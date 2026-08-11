using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

internal static class EosSmokeTest
{
    private const uint EdsObjectEventAll = 0x00000200;
    private const uint EdsObjectEventDirItemRequestTransfer = 0x00000208;
    private const uint EdsPropIdSaveTo = 0x0000000b;
    private const uint EdsSaveToHost = 2;
    private const uint EdsCameraCommandTakePicture = 0;
    private const uint EdsFileCreateDispositionCreateAlways = 1;
    private const uint EdsAccessReadWrite = 2;

    private static readonly AutoResetEvent DownloadFinished = new AutoResetEvent(false);
    private static EdsObjectEventHandler objectEventHandler;
    private static string outputPath;
    private static string temporaryOutputPath;
    private static Exception callbackError;

    [StructLayout(LayoutKind.Sequential)]
    private struct EdsCapacity
    {
        public int NumberOfFreeClusters;
        public int BytesPerSector;
        public int Reset;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    private struct EdsDirectoryItemInfo
    {
        public ulong Size;
        public int IsFolder;
        public uint GroupId;
        public uint Option;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
        public string FileName;

        public uint Format;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    private struct EdsDeviceInfo
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
        public string PortName;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
        public string DeviceDescription;

        public uint DeviceSubType;
        public uint Reserved;
    }

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate uint EdsObjectEventHandler(uint eventCode, IntPtr objectRef, IntPtr context);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool SetDllDirectory(string path);

    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall)]
    private static extern uint EdsInitializeSDK();

    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall)]
    private static extern uint EdsTerminateSDK();

    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall)]
    private static extern uint EdsGetCameraList(out IntPtr cameraList);

    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall)]
    private static extern uint EdsGetChildCount(IntPtr reference, out int count);

    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall)]
    private static extern uint EdsGetChildAtIndex(IntPtr reference, int index, out IntPtr child);

    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall)]
    private static extern uint EdsGetDeviceInfo(IntPtr camera, out EdsDeviceInfo deviceInfo);

    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall)]
    private static extern uint EdsOpenSession(IntPtr camera);

    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall)]
    private static extern uint EdsCloseSession(IntPtr camera);

    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall)]
    private static extern int EdsRelease(IntPtr reference);

    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall)]
    private static extern uint EdsSetPropertyData(IntPtr reference, uint propertyId, int parameter, int size, ref uint data);

    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall)]
    private static extern uint EdsSetCapacity(IntPtr camera, EdsCapacity capacity);

    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall)]
    private static extern uint EdsSetObjectEventHandler(IntPtr camera, uint eventCode, EdsObjectEventHandler handler, IntPtr context);

    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall)]
    private static extern uint EdsSendCommand(IntPtr camera, uint command, int parameter);

    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall)]
    private static extern uint EdsGetEvent();

    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)]
    private static extern uint EdsCreateFileStream(string fileName, uint createDisposition, uint desiredAccess, out IntPtr stream);

    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall)]
    private static extern uint EdsGetDirectoryItemInfo(IntPtr directoryItem, out EdsDirectoryItemInfo info);

    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall)]
    private static extern uint EdsDownload(IntPtr directoryItem, uint readSize, IntPtr stream);

    [DllImport("EDSDK.dll", CallingConvention = CallingConvention.StdCall)]
    private static extern uint EdsDownloadComplete(IntPtr directoryItem);

    private static void Check(uint error, string operation)
    {
        if (error != 0)
        {
            string hint = error == 0x000000C0
                ? " The installed EDSDK does not support opening this camera in its current driver/software state. Close EOS Utility and verify that EOS Utility 2 Remote Shooting can connect first."
                : string.Empty;
            throw new InvalidOperationException(operation + " failed (EDSDK 0x" + error.ToString("X8") + ")." + hint);
        }
    }

    private static uint HandleObjectEvent(uint eventCode, IntPtr objectRef, IntPtr context)
    {
        try
        {
            if (eventCode != EdsObjectEventDirItemRequestTransfer || objectRef == IntPtr.Zero)
                return 0;

            EdsDirectoryItemInfo info;
            Check(EdsGetDirectoryItemInfo(objectRef, out info), "Read captured image information");
            Console.WriteLine("Camera image: " + info.FileName + " (" + info.Size + " bytes)");

            IntPtr stream = IntPtr.Zero;
            try
            {
                Check(EdsCreateFileStream(temporaryOutputPath, EdsFileCreateDispositionCreateAlways, EdsAccessReadWrite, out stream), "Create temporary output JPEG");
                if (info.Size > uint.MaxValue)
                    throw new IOException("Captured image is too large for this EDSDK download API.");
                Check(EdsDownload(objectRef, (uint)info.Size, stream), "Download captured image");
                Check(EdsDownloadComplete(objectRef), "Finish captured image download");
            }
            finally
            {
                if (stream != IntPtr.Zero) EdsRelease(stream);
            }

            File.Copy(temporaryOutputPath, outputPath, true);
        }
        catch (Exception ex)
        {
            callbackError = ex;
        }
        finally
        {
            if (objectRef != IntPtr.Zero) EdsRelease(objectRef);
            DownloadFinished.Set();
        }
        return 0;
    }

    public static int Main(string[] args)
    {
        string sdkDirectory = args.Length > 1 ? Path.GetFullPath(args[1]) : @"C:\Program Files (x86)\Canon\EOS Utility\EU2";
        string requestedOutput = args.Length > 0 ? args[0] : Path.Combine(Environment.CurrentDirectory, "eos60d-test.jpg");
        outputPath = Path.GetFullPath(requestedOutput);
        temporaryOutputPath = Path.Combine(Path.GetTempPath(), "eos60d-" + Guid.NewGuid().ToString("N") + ".jpg");

        if (!File.Exists(Path.Combine(sdkDirectory, "EDSDK.dll")))
        {
            Console.Error.WriteLine("EDSDK.dll was not found in: " + sdkDirectory);
            return 2;
        }

        Directory.CreateDirectory(Path.GetDirectoryName(outputPath));
        SetDllDirectory(sdkDirectory);

        IntPtr cameraList = IntPtr.Zero;
        IntPtr camera = IntPtr.Zero;
        bool sdkStarted = false;
        bool sessionOpened = false;

        try
        {
            Console.WriteLine("Initializing Canon EDSDK...");
            Check(EdsInitializeSDK(), "Initialize Canon EDSDK");
            sdkStarted = true;

            Check(EdsGetCameraList(out cameraList), "Read camera list");
            int cameraCount;
            Check(EdsGetChildCount(cameraList, out cameraCount), "Count connected cameras");
            if (cameraCount < 1)
                throw new InvalidOperationException("No Canon EOS camera was detected. Check USB, camera power, and close EOS Utility.");

            Check(EdsGetChildAtIndex(cameraList, 0, out camera), "Select first Canon camera");
            EdsDeviceInfo deviceInfo;
            Check(EdsGetDeviceInfo(camera, out deviceInfo), "Read Canon camera identity");
            Console.WriteLine("Detected: " + deviceInfo.DeviceDescription + " (" + deviceInfo.PortName + ")");
            Check(EdsOpenSession(camera), "Open camera session");
            sessionOpened = true;

            objectEventHandler = HandleObjectEvent;
            Check(EdsSetObjectEventHandler(camera, EdsObjectEventAll, objectEventHandler, IntPtr.Zero), "Register image download handler");

            uint saveTo = EdsSaveToHost;
            Check(EdsSetPropertyData(camera, EdsPropIdSaveTo, 0, sizeof(uint), ref saveTo), "Set camera save destination");
            Check(EdsSetCapacity(camera, new EdsCapacity
            {
                NumberOfFreeClusters = 0x7fffffff,
                BytesPerSector = 0x1000,
                Reset = 1
            }), "Set host storage capacity");

            Console.WriteLine("Camera connected. Taking one photo...");
            Check(EdsSendCommand(camera, EdsCameraCommandTakePicture, 0), "Trigger shutter");

            DateTime deadline = DateTime.UtcNow.AddSeconds(30);
            while (!DownloadFinished.WaitOne(50))
            {
                EdsGetEvent();
                if (DateTime.UtcNow >= deadline)
                    throw new TimeoutException("Timed out waiting for the camera to deliver the JPEG.");
            }

            if (callbackError != null) throw callbackError;
            if (!File.Exists(outputPath) || new FileInfo(outputPath).Length == 0)
                throw new IOException("The camera reported completion, but the JPEG was not written.");

            Console.WriteLine("JPEG saved: " + outputPath);
            Console.WriteLine("Size: " + new FileInfo(outputPath).Length + " bytes");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("EOS smoke test failed: " + ex.Message);
            return 1;
        }
        finally
        {
            if (sessionOpened) EdsCloseSession(camera);
            if (camera != IntPtr.Zero) EdsRelease(camera);
            if (cameraList != IntPtr.Zero) EdsRelease(cameraList);
            if (sdkStarted) EdsTerminateSDK();
            if (!string.IsNullOrEmpty(temporaryOutputPath) && File.Exists(temporaryOutputPath))
                File.Delete(temporaryOutputPath);
            GC.KeepAlive(objectEventHandler);
        }
    }
}
