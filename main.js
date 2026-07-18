const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const ptp = require('pdf-to-printer'); // Thư viện dùng để gửi file ảnh thẳng đến máy in

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

app.whenReady().then(createWindow);

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