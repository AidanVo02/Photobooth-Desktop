using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class EosCameraService
{
    private const uint Ok = 0;
    private const uint ObjectEventAll = 0x00000200;
    private const uint ObjectEventDirItemRequestTransfer = 0x00000208;
    private const uint PropSaveTo = 0x0000000b;
    private const uint SaveToHost = 2;
    private const uint PropEvfOutputDevice = 0x00000500;
    private const uint EvfOutputDevicePc = 2;
    private const uint CameraCommandTakePicture = 0;
    private const uint FileCreateAlways = 1;
    private const uint AccessReadWrite = 2;
    private const uint ErrorObjectNotReady = 0x0000A102;
    private const uint ErrorDeviceBusy = 0x00000081;
    private const uint ErrorNotReady = 0x00008D01;

    private static IntPtr cameraList;
    private static IntPtr camera;
    private static bool sdkStarted;
    private static bool sessionOpened;
    private static bool liveViewStarted;
    private static string captureOutputPath;
    private static string temporaryCapturePath;
    private static Exception captureError;
    private static readonly AutoResetEvent CaptureFinished = new AutoResetEvent(false);
    private static ObjectEventHandler objectEventHandler;

    [StructLayout(LayoutKind.Sequential)]
    private struct Capacity { public int FreeClusters; public int BytesPerSector; public int Reset; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    private struct DirectoryItemInfo
    {
        public ulong Size;
        public int IsFolder;
        public uint GroupId;
        public uint Option;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string FileName;
        public uint Format;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    private struct DeviceInfo
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string PortName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string Description;
        public uint DeviceSubType;
        public uint Reserved;
    }

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate uint ObjectEventHandler(uint eventCode, IntPtr objectRef, IntPtr context);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool SetDllDirectory(string path);
    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall)] private static extern uint EdsInitializeSDK();
    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall)] private static extern uint EdsTerminateSDK();
    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall)] private static extern uint EdsGetCameraList(out IntPtr list);
    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall)] private static extern uint EdsGetChildCount(IntPtr reference, out int count);
    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall)] private static extern uint EdsGetChildAtIndex(IntPtr reference, int index, out IntPtr child);
    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall)] private static extern uint EdsGetDeviceInfo(IntPtr cameraRef, out DeviceInfo info);
    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall)] private static extern uint EdsOpenSession(IntPtr cameraRef);
    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall)] private static extern uint EdsCloseSession(IntPtr cameraRef);
    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall)] private static extern int EdsRelease(IntPtr reference);
    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall)] private static extern uint EdsSetPropertyData(IntPtr reference, uint propertyId, int parameter, int size, ref uint data);
    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall)] private static extern uint EdsSetCapacity(IntPtr cameraRef, Capacity capacity);
    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall)] private static extern uint EdsSetObjectEventHandler(IntPtr cameraRef, uint eventCode, ObjectEventHandler handler, IntPtr context);
    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall)] private static extern uint EdsSendCommand(IntPtr cameraRef, uint command, int parameter);
    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall)] private static extern uint EdsGetEvent();
    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)] private static extern uint EdsCreateFileStream(string fileName, uint disposition, uint access, out IntPtr stream);
    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall)] private static extern uint EdsGetDirectoryItemInfo(IntPtr item, out DirectoryItemInfo info);
    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall)] private static extern uint EdsDownload(IntPtr item, uint size, IntPtr stream);
    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall)] private static extern uint EdsDownloadComplete(IntPtr item);
    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall)] private static extern uint EdsDownloadCancel(IntPtr item);
    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall)] private static extern uint EdsCreateEvfImageRef(IntPtr stream, out IntPtr evfImage);
    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall)] private static extern uint EdsDownloadEvfImage(IntPtr cameraRef, IntPtr evfImage);

    private static void Check(uint error, string action)
    {
        if (error != Ok) throw new InvalidOperationException(action + " failed (EDSDK 0x" + error.ToString("X8") + ")");
    }

    private static string Decode(string value)
    {
        return Encoding.UTF8.GetString(Convert.FromBase64String(value));
    }

    private static string Encode(string value)
    {
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(value ?? string.Empty));
    }

    private static void Reply(string kind, string requestId, string value)
    {
        Console.WriteLine(kind + "\t" + requestId + "\t" + Encode(value));
        Console.Out.Flush();
    }

    private static uint OnObjectEvent(uint eventCode, IntPtr objectRef, IntPtr context)
    {
        if (eventCode != ObjectEventDirItemRequestTransfer || objectRef == IntPtr.Zero) return Ok;
        bool isJpegTransfer = false;
        try
        {
            DirectoryItemInfo info;
            Check(EdsGetDirectoryItemInfo(objectRef, out info), "Read captured image information");
            string extension = Path.GetExtension(info.FileName);
            isJpegTransfer = extension.Equals(".jpg", StringComparison.OrdinalIgnoreCase)
                || extension.Equals(".jpeg", StringComparison.OrdinalIgnoreCase);
            if (!isJpegTransfer)
            {
                EdsDownloadCancel(objectRef);
                return Ok;
            }
            if (info.Size > uint.MaxValue) throw new IOException("Captured image is too large.");

            IntPtr stream = IntPtr.Zero;
            try
            {
                Check(EdsCreateFileStream(temporaryCapturePath, FileCreateAlways, AccessReadWrite, out stream), "Create temporary JPEG");
                Check(EdsDownload(objectRef, (uint)info.Size, stream), "Download JPEG");
                Check(EdsDownloadComplete(objectRef), "Complete JPEG download");
            }
            finally { if (stream != IntPtr.Zero) EdsRelease(stream); }

            File.Copy(temporaryCapturePath, captureOutputPath, true);
        }
        catch (Exception ex) { captureError = ex; }
        finally
        {
            if (objectRef != IntPtr.Zero) EdsRelease(objectRef);
            if (isJpegTransfer) CaptureFinished.Set();
        }
        return Ok;
    }

    private static string Connect()
    {
        Check(EdsInitializeSDK(), "Initialize EDSDK");
        sdkStarted = true;
        Check(EdsGetCameraList(out cameraList), "Get camera list");
        int count;
        Check(EdsGetChildCount(cameraList, out count), "Count cameras");
        if (count < 1) throw new InvalidOperationException("Không tìm thấy Canon EOS. Kiểm tra USB và nguồn máy ảnh.");
        Check(EdsGetChildAtIndex(cameraList, 0, out camera), "Select camera");
        DeviceInfo info;
        Check(EdsGetDeviceInfo(camera, out info), "Read camera information");
        Check(EdsOpenSession(camera), "Open camera session");
        sessionOpened = true;

        objectEventHandler = OnObjectEvent;
        Check(EdsSetObjectEventHandler(camera, ObjectEventAll, objectEventHandler, IntPtr.Zero), "Register camera events");
        uint saveTo = SaveToHost;
        Check(EdsSetPropertyData(camera, PropSaveTo, 0, sizeof(uint), ref saveTo), "Set host storage");
        Check(EdsSetCapacity(camera, new Capacity { FreeClusters = 0x7fffffff, BytesPerSector = 0x1000, Reset = 1 }), "Set host capacity");
        string cameraName = info.Description == "MTP USB Device" ? "Canon EOS 60D" : info.Description;
        return cameraName + "|" + info.PortName;
    }

    private static void StartLiveView()
    {
        if (liveViewStarted) return;
        uint output = EvfOutputDevicePc;
        Check(EdsSetPropertyData(camera, PropEvfOutputDevice, 0, sizeof(uint), ref output), "Start Live View");
        liveViewStarted = true;
        Thread.Sleep(500);
    }

    private static string DownloadPreview(string requestedPath)
    {
        StartLiveView();
        string output = Path.GetFullPath(requestedPath);
        Directory.CreateDirectory(Path.GetDirectoryName(output));
        string temp = Path.Combine(Path.GetTempPath(), "eos-evf-" + Guid.NewGuid().ToString("N") + ".jpg");
        IntPtr stream = IntPtr.Zero;
        IntPtr evfImage = IntPtr.Zero;
        try
        {
            Check(EdsCreateFileStream(temp, FileCreateAlways, AccessReadWrite, out stream), "Create Live View stream");
            Check(EdsCreateEvfImageRef(stream, out evfImage), "Create Live View image");
            uint error = Ok;
            for (int attempt = 0; attempt < 20; attempt++)
            {
                error = EdsDownloadEvfImage(camera, evfImage);
                if (error == Ok) break;
                if (error != ErrorObjectNotReady) break;
                Thread.Sleep(50);
                EdsGetEvent();
            }
            Check(error, "Download Live View frame");
        }
        finally
        {
            if (evfImage != IntPtr.Zero) EdsRelease(evfImage);
            if (stream != IntPtr.Zero) EdsRelease(stream);
        }
        File.Copy(temp, output, true);
        File.Delete(temp);
        return output;
    }

    private static string Capture(string requestedPath)
    {
        captureOutputPath = Path.GetFullPath(requestedPath);
        Directory.CreateDirectory(Path.GetDirectoryName(captureOutputPath));
        temporaryCapturePath = Path.Combine(Path.GetTempPath(), "eos-capture-" + Guid.NewGuid().ToString("N") + ".jpg");
        captureError = null;
        while (CaptureFinished.WaitOne(0)) { }
        uint triggerError = Ok;
        for (int attempt = 0; attempt < 12; attempt++)
        {
            triggerError = EdsSendCommand(camera, CameraCommandTakePicture, 0);
            if (triggerError == Ok) break;
            if (triggerError != ErrorDeviceBusy && triggerError != ErrorNotReady && triggerError != ErrorObjectNotReady) break;
            Thread.Sleep(250);
            EdsGetEvent();
        }
        Check(triggerError, "Trigger shutter");

        DateTime deadline = DateTime.UtcNow.AddSeconds(30);
        while (!CaptureFinished.WaitOne(40))
        {
            EdsGetEvent();
            if (DateTime.UtcNow >= deadline) throw new TimeoutException("Hết thời gian chờ JPEG từ EOS 60D.");
        }
        if (captureError != null) throw captureError;
        if (!File.Exists(captureOutputPath) || new FileInfo(captureOutputPath).Length == 0)
            throw new IOException("EOS báo chụp xong nhưng không có JPEG.");
        if (File.Exists(temporaryCapturePath)) File.Delete(temporaryCapturePath);
        return captureOutputPath;
    }

    private static void Disconnect()
    {
        if (sessionOpened && liveViewStarted)
        {
            uint output = 0;
            EdsSetPropertyData(camera, PropEvfOutputDevice, 0, sizeof(uint), ref output);
        }
        if (sessionOpened) EdsCloseSession(camera);
        if (camera != IntPtr.Zero) EdsRelease(camera);
        if (cameraList != IntPtr.Zero) EdsRelease(cameraList);
        if (sdkStarted) EdsTerminateSDK();
        sessionOpened = sdkStarted = liveViewStarted = false;
        camera = cameraList = IntPtr.Zero;
        GC.KeepAlive(objectEventHandler);
    }

    public static int Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        string sdkDirectory = args.Length > 0 ? args[0] : @"C:\Program Files (x86)\Canon\EOS Utility\EU2";
        try
        {
            if (!File.Exists(Path.Combine(sdkDirectory, "EDSDK.dll"))) throw new FileNotFoundException("Không tìm thấy EDSDK.dll", sdkDirectory);
            SetDllDirectory(sdkDirectory);
            Reply("READY", "0", Connect());

            string line;
            while ((line = Console.ReadLine()) != null)
            {
                string[] parts = line.Split('\t');
                string command = parts.Length > 0 ? parts[0] : string.Empty;
                string requestId = parts.Length > 1 ? parts[1] : "0";
                try
                {
                    EdsGetEvent();
                    if (command == "STATUS") Reply("OK", requestId, "connected");
                    else if (command == "PREVIEW") Reply("OK", requestId, DownloadPreview(Decode(parts[2])));
                    else if (command == "CAPTURE") Reply("OK", requestId, Capture(Decode(parts[2])));
                    else if (command == "QUIT") { Reply("OK", requestId, "bye"); break; }
                    else throw new InvalidOperationException("Lệnh EOS không hợp lệ: " + command);
                }
                catch (Exception ex) { Reply("ERR", requestId, ex.Message); }
            }
            return 0;
        }
        catch (Exception ex)
        {
            Reply("FATAL", "0", ex.Message + " Hãy đóng hoàn toàn EOS Utility trước khi mở photobooth.");
            return 1;
        }
        finally { Disconnect(); }
    }
}
