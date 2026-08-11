const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const ptp = require('pdf-to-printer'); // Thư viện dùng để gửi file ảnh thẳng đến máy in

const eosServiceDir = path.join(__dirname, 'tools', 'eos-camera-service');
const eosServiceSource = path.join(eosServiceDir, 'EosCameraService.cs');
const eosServiceExe = path.join(eosServiceDir, 'EosCameraService.exe');
const eosCompiler = 'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe';
let eosProcess = null;
let eosStatus = { connected: false, message: 'Dịch vụ EOS chưa khởi động.' };
let eosRequestId = 0;
let eosStdoutBuffer = '';
let eosReadyPromise = null;
let eosReadyResolve = null;
let eosReadyReject = null;
const eosPendingRequests = new Map();

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

let mainWindow;

function encodeEosValue(value) {
  return Buffer.from(String(value), 'utf8').toString('base64');
}

function decodeEosValue(value) {
  return Buffer.from(value || '', 'base64').toString('utf8');
}

function compileEosService() {
  if (!fs.existsSync(eosCompiler)) throw new Error(`Không tìm thấy trình biên dịch EOS: ${eosCompiler}`);
  const needsBuild = !fs.existsSync(eosServiceExe)
    || fs.statSync(eosServiceSource).mtimeMs > fs.statSync(eosServiceExe).mtimeMs;
  if (!needsBuild) return;

  const result = spawnSync(eosCompiler, [
    '/nologo', '/target:exe', '/platform:x86', `/out:${eosServiceExe}`, eosServiceSource
  ], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`Không biên dịch được dịch vụ EOS: ${result.stderr || result.stdout}`);
}

function settleEosRequest(kind, requestId, value) {
  if (requestId === '0') {
    if (kind === 'READY') {
      eosStatus = { connected: true, message: value.split('|')[0] || 'Canon EOS đã kết nối.' };
      if (eosReadyResolve) eosReadyResolve(eosStatus);
    } else if (kind === 'FATAL') {
      eosStatus = { connected: false, message: value };
      if (eosReadyReject) eosReadyReject(new Error(value));
    }
    return;
  }

  const pending = eosPendingRequests.get(requestId);
  if (!pending) return;
  eosPendingRequests.delete(requestId);
  clearTimeout(pending.timeout);
  if (kind === 'OK') pending.resolve(value);
  else pending.reject(new Error(value));
}

function handleEosOutput(chunk) {
  eosStdoutBuffer += chunk;
  const lines = eosStdoutBuffer.split(/\r?\n/);
  eosStdoutBuffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const [kind, requestId, encodedValue] = line.split('\t');
    settleEosRequest(kind, requestId, decodeEosValue(encodedValue));
  }
}

async function stopEosService() {
  if (!eosProcess) return;
  const processToStop = eosProcess;
  eosProcess = null;
  await new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolve();
    };
    processToStop.once('exit', finish);
    try { processToStop.stdin.write('QUIT\tshutdown\n'); }
    catch (_) { finish(); }
    setTimeout(() => {
      if (processToStop.exitCode === null) processToStop.kill();
      finish();
    }, 1800);
  });
}

async function startEosService() {
  await stopEosService();
  eosPendingRequests.forEach(({ reject, timeout }) => {
    clearTimeout(timeout);
    reject(new Error('Dịch vụ EOS đang khởi động lại.'));
  });
  eosPendingRequests.clear();
  eosStatus = { connected: false, message: 'Đang kết nối Canon EOS...' };

  eosReadyPromise = new Promise((resolve, reject) => {
    eosReadyResolve = resolve;
    eosReadyReject = reject;
  });

  try {
    compileEosService();
    const eosSdkDir = process.env.EDSDK_DIR || 'C:\\Program Files (x86)\\Canon\\EOS Utility\\EU2';
    eosProcess = spawn(eosServiceExe, [eosSdkDir], {
      cwd: eosServiceDir,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    eosProcess.stdout.setEncoding('utf8');
    eosProcess.stdout.on('data', handleEosOutput);
    eosProcess.stderr.setEncoding('utf8');
    eosProcess.stderr.on('data', (data) => console.error('[EOS]', data.trim()));
    eosProcess.on('error', (error) => {
      eosStatus = { connected: false, message: error.message };
      if (eosReadyReject) eosReadyReject(error);
    });
    eosProcess.on('exit', (code) => {
      if (eosProcess && eosProcess.exitCode === code) eosProcess = null;
      if (eosStatus.connected) eosStatus = { connected: false, message: `Dịch vụ EOS đã dừng (${code}).` };
    });
  } catch (error) {
    eosStatus = { connected: false, message: error.message };
    eosReadyReject(error);
  }

  // Prevent an expected connection failure from becoming an unhandled rejection.
  eosReadyPromise.catch(() => {});
  return eosReadyPromise;
}

async function sendEosCommand(command, value = '', timeoutMs = 10000) {
  if (!eosProcess || !eosStatus.connected) await eosReadyPromise;
  if (!eosProcess || !eosStatus.connected) throw new Error(eosStatus.message);
  const requestId = String(++eosRequestId);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      eosPendingRequests.delete(requestId);
      reject(new Error(`EOS không phản hồi lệnh ${command}.`));
    }, timeoutMs);
    eosPendingRequests.set(requestId, { resolve, reject, timeout });
    eosProcess.stdin.write(`${command}\t${requestId}\t${encodeEosValue(value)}\n`);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    fullscreen: true, // Chạy toàn màn hình cho đúng chuẩn Photobooth công cộng
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false, // Bật lên để renderer.js dùng được hàm require/ipcRenderer nhanh gọn
    }
  });

  mainWindow.loadFile('index.html');
}

loadEnvFile(path.join(__dirname, '.env'));

app.whenReady().then(() => {
  startEosService();
  createWindow();
});

ipcMain.handle('eos-status', async () => {
  if (!eosStatus.connected && eosReadyPromise) {
    try { await eosReadyPromise; } catch (_) { /* eosStatus contains the actionable error */ }
  }
  return eosStatus;
});

ipcMain.handle('eos-reconnect', async () => {
  try { return await startEosService(); }
  catch (error) { return { connected: false, message: error.message }; }
});

ipcMain.handle('eos-preview', async () => {
  const previewDir = path.join(__dirname, 'assets', 'eos-preview');
  if (!fs.existsSync(previewDir)) fs.mkdirSync(previewDir, { recursive: true });
  const previewPath = path.join(previewDir, 'current.jpg');
  await sendEosCommand('PREVIEW', previewPath, 5000);
  return previewPath;
});

ipcMain.handle('eos-capture', async () => {
  const captureDir = path.join(__dirname, 'assets', 'captures');
  if (!fs.existsSync(captureDir)) fs.mkdirSync(captureDir, { recursive: true });
  const capturePath = path.join(captureDir, `eos_${Date.now()}.jpg`);
  await sendEosCommand('CAPTURE', capturePath, 35000);
  return capturePath;
});

ipcMain.handle('album-create-session', async (_event, { mode, images }) => {
  const apiUrl = (process.env.PHOTO_ALBUM_API_URL || '').replace(/\/$/, '');
  const publicUrl = (process.env.PHOTO_ALBUM_PUBLIC_URL || apiUrl).replace(/\/$/, '');
  const apiSecret = process.env.PHOTOBOOTH_API_SECRET || '';
  if (!apiUrl || !publicUrl || !apiSecret) {
    throw new Error('Thiếu PHOTO_ALBUM_API_URL, PHOTO_ALBUM_PUBLIC_URL hoặc PHOTOBOOTH_API_SECRET trong .env.');
  }
  if (!['quick2', 'photobooth'].includes(mode) || !Array.isArray(images) || images.length < 1 || images.length > 6) {
    throw new Error('Dữ liệu album không hợp lệ.');
  }

  const token = crypto.randomBytes(18).toString('base64url');
  const response = await fetch(`${apiUrl}/api/sessions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiSecret}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ token, mode, images }),
    signal: AbortSignal.timeout(20000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Album API HTTP ${response.status}`);
  return { token, albumUrl: `${publicUrl}/s/${token}`, expiresAt: result.expiresAt };
});

ipcMain.handle('album-config-status', () => {
  const missing = ['PHOTO_ALBUM_API_URL', 'PHOTO_ALBUM_PUBLIC_URL', 'PHOTOBOOTH_API_SECRET']
    .filter(name => !process.env[name]);
  return {
    configured: missing.length === 0,
    message: missing.length ? `Thiếu cấu hình album: ${missing.join(', ')}` : 'Dịch vụ album đã cấu hình.'
  };
});

ipcMain.handle('app-request-quit', () => {
  return stopEosService().then(() => {
    app.quit();
    return true;
  });
});

// Lắng nghe lệnh IN từ Renderer gửi lên
ipcMain.on('trigger-silent-print', async (event, filePath) => {
  console.log("Nhận lệnh in cho file:", filePath);
  try {
    // Tự động gửi thẳng tới máy in mặc định (Default Printer) đã cấu hình trên Windows
    await ptp.print(filePath);
    event.reply('print-success', 'Ảnh đang được máy in xử lý!');
  } catch (error) {
    console.error("Lỗi in ấn:", error);
    event.reply('print-error', 'Không thể kết nối máy in: ' + error.message);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', stopEosService);
