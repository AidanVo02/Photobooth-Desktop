const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

let appState = {
  currentStep: 1,
  selectedLayout: 'strip3', // 'strip3', 'grid4', 'single_vert', 'single_horiz'
  capturedPhotos: [],
  selectedPhotoIndexes: [],
  selectedFilter: 'normal',
  selectedFrame: 'classic',
  finalCollageUrl: ''
};

let selectedDeviceId = '';
let testStream = null;
let mainStream = null;

const funnyQuotes = [
  "Bật cơ cười tự tin vàng rực rỡ lên nhe!",
  "Tạo dáng 'ủa alo' đi xem nào!",
  "Diễn sâu dữ chưa nghệ sĩ ơi!",
  "Tươi tắn lên, Saigon Tếu yêu bạn!",
  "Pose cuối: Bùng nổ quả tếu lâm xem!"
];

// Khởi tạo thiết bị camera khi load ứng dụng
document.addEventListener('DOMContentLoaded', () => {
  getAvailableCameras();
});

async function getAvailableCameras() {
  try {
    await navigator.mediaDevices.getUserMedia({ video: true });
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(d => d.kind === 'videoinput');
    const selectEl = document.getElementById('camera-select');
    selectEl.innerHTML = '';
    videoDevices.forEach((device, index) => {
      const opt = document.createElement('option');
      opt.value = device.deviceId;
      opt.text = device.label || `Camera ${index + 1}`;
      selectEl.appendChild(opt);
    });
    if (videoDevices.length > 0) selectedDeviceId = videoDevices[0].deviceId;
  } catch (err) { console.error("Không quét được camera", err); }
}

function toggleSettingsPanel() {
  const panel = document.getElementById('settings-panel');
  if (panel.classList.contains('hidden')) {
    panel.classList.remove('hidden');
    startTestCamera();
  } else {
    panel.classList.add('hidden');
    stopTestCamera();
  }
}

async function startTestCamera() {
  if (testStream) testStream.getTracks().forEach(t => t.stop());
  try {
    testStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined, width: 640, height: 480 }
    });
    document.getElementById('test-webcam').srcObject = testStream;
  } catch (e) { console.error(e); }
}

function stopTestCamera() {
  if (testStream) { testStream.getTracks().forEach(t => t.stop()); testStream = null; }
}

function changeCameraDevice() {
  selectedDeviceId = document.getElementById('camera-select').value;
  startTestCamera();
}

// Chức năng chụp test nhanh để kiểm tra Center Crop
function triggerTestCapture() {
  const testVideo = document.getElementById('test-webcam');
  if (!testVideo.srcObject) return alert("Chưa bật camera test!");

  const canvas = document.createElement('canvas');
  canvas.width = testVideo.videoWidth; canvas.height = testVideo.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width, 0); ctx.scale(-1, 1);
  ctx.drawImage(testVideo, 0, 0, canvas.width, canvas.height);

  const testData = canvas.toDataURL('image/jpeg');
  appState.capturedPhotos = [testData, testData, testData, testData, testData];
  appState.selectedPhotoIndexes = appState.selectedLayout === 'strip3' ? [0, 1, 2] : (appState.selectedLayout === 'grid4' ? [0, 1, 2, 3] : [0]);

  stopTestCamera();
  document.getElementById('settings-panel').classList.add('hidden');
  initFilterWorkspace();
  goToStep(4);
}

function goToStep(step) {
  document.querySelectorAll('.step-view').forEach(view => view.classList.add('hidden'));
  document.getElementById(`step-${step}-view`).classList.remove('hidden');
  appState.currentStep = step;

  for (let i = 1; i <= 6; i++) {
    const indicator = document.getElementById(`ind-${i}`);
    if (i <= step) {
      indicator.className = "w-3.5 h-3.5 rounded-full bg-brandYellow border border-black transition-all scale-110";
    } else {
      indicator.className = "w-3.5 h-3.5 rounded-full bg-zinc-700 border border-black";
    }
  }
}

// BƯỚC 1: Xử lý chọn Bố cục
async function selectLayout(layout) {
  appState.selectedLayout = layout;
  document.querySelectorAll('.layout-card').forEach(c => c.classList.remove('border-brandYellow', 'selected'));
  document.getElementById(`layout-${layout}`).classList.add('border-brandYellow', 'selected');

  let needed = layout === 'strip3' ? 3 : (layout === 'grid4' ? 4 : 1);
  document.getElementById('target-count-badge').innerText = needed;
  document.getElementById('total-poses-needed').innerText = needed;
}

// BƯỚC 2: Khởi động Camera thật và Đếm ngược chụp 5 tấm
async function startPhotoSession() {
  const startBtn = document.getElementById('start-shoot-btn');
  startBtn.disabled = true; startBtn.classList.add('opacity-50');
  appState.capturedPhotos = [];
  let counter = 0;

  const video = document.getElementById('webcam-video');
  try {
    mainStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined, width: 1280, height: 720 }
    });
    video.srcObject = mainStream;
  } catch (e) { return alert("Không mở được camera chính: " + e.message); }

  const countdownOverlay = document.getElementById('countdown-overlay');
  const countdownText = document.getElementById('countdown-text');
  const flashOverlay = document.getElementById('flash-overlay');
  const quoteBubble = document.getElementById('camera-quote-bubble');

  const triggerNextPhoto = () => {
    if (counter >= 5) {
      if (mainStream) mainStream.getTracks().forEach(t => t.stop());
      countdownOverlay.classList.add('hidden');
      renderGalleryGrid();
      goToStep(3);
      return;
    }

    quoteBubble.innerText = `"${funnyQuotes[counter]}"`;
    quoteBubble.classList.remove('opacity-0', 'scale-75'); quoteBubble.classList.add('opacity-100', 'scale-100');

    let secondsLeft = 3;
    countdownOverlay.classList.remove('hidden');
    countdownText.innerText = secondsLeft;
    playBeep(440, 0.15);

    let clockInterval = setInterval(() => {
      secondsLeft--;
      if (secondsLeft > 0) {
        countdownText.innerText = secondsLeft; playBeep(440, 0.15);
      } else {
        clearInterval(clockInterval);
        playShutterSound();
        flashOverlay.classList.add('flash-active');
        setTimeout(() => flashOverlay.classList.remove('flash-active'), 500);

        // Bắt ảnh chụp từ video
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.translate(canvas.width, 0); ctx.scale(-1, 1);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        appState.capturedPhotos.push(canvas.toDataURL('image/jpeg'));
        counter++;
        document.getElementById('captured-counter-text').innerText = counter;

        quoteBubble.classList.remove('opacity-100', 'scale-100'); quoteBubble.classList.add('opacity-0', 'scale-75');
        setTimeout(triggerNextPhoto, 1200);
      }
    }, 1000);
  };
  triggerNextPhoto();
}

// BƯỚC 3: Chọn lựa ảnh chất lượng trong lưới gallery
function renderGalleryGrid() {
  const container = document.getElementById('gallery-grid-container');
  container.innerHTML = ''; appState.selectedPhotoIndexes = [];
  updateSelectionUI();

  appState.capturedPhotos.forEach((dataUrl, idx) => {
    const item = document.createElement('div');
    item.className = "relative aspect-[2/3] border-4 border-black rounded-xl overflow-hidden cursor-pointer bg-zinc-800 shadow-md";
    item.id = `gallery-item-${idx}`;
    item.onclick = () => toggleSelectPhoto(idx);
    item.innerHTML = `
            <img src="${dataUrl}" class="w-full h-full object-cover" />
            <div class="absolute top-2 left-2 w-6 h-6 rounded-full bg-black border border-brandYellow flex items-center justify-center font-comic text-xs text-brandYellow font-bold">${idx + 1}</div>
            <div class="select-badge absolute inset-0 bg-brandYellow/40 flex items-center justify-center opacity-0"><div class="w-10 h-10 rounded-full bg-white border-4 border-black flex items-center justify-center"><i class="fa-solid fa-check text-black"></i></div></div>
        `;
    container.appendChild(item);
  });
  document.getElementById('selection-instruction').innerText = `Hãy chọn đúng ${document.getElementById('target-count-badge').innerText} tấm bạn ưng ý nhất trong 5 tấm dưới đây`;
}

function toggleSelectPhoto(index) {
  const targetCount = parseInt(document.getElementById('target-count-badge').innerText);
  const currentSelectedPos = appState.selectedPhotoIndexes.indexOf(index);
  const itemElement = document.getElementById(`gallery-item-${index}`);
  const badge = itemElement.querySelector('.select-badge');

  if (currentSelectedPos > -1) {
    appState.selectedPhotoIndexes.splice(currentSelectedPos, 1);
    itemElement.classList.remove('border-brandYellow'); badge.classList.remove('opacity-100');
    playBeep(300, 0.1);
  } else if (appState.selectedPhotoIndexes.length < targetCount) {
    appState.selectedPhotoIndexes.push(index);
    itemElement.classList.add('border-brandYellow'); badge.classList.add('opacity-100');
    playBeep(600, 0.1);
  } else { playBeep(180, 0.3); }
  updateSelectionUI();
}

function updateSelectionUI() {
  const targetCount = parseInt(document.getElementById('target-count-badge').innerText);
  const nextBtn = document.getElementById('step-3-next-btn');
  document.getElementById('selected-count-badge').innerText = appState.selectedPhotoIndexes.length;

  if (appState.selectedPhotoIndexes.length === targetCount) {
    nextBtn.disabled = false; nextBtn.classList.remove('bg-zinc-700', 'text-zinc-400', 'cursor-not-allowed');
    nextBtn.classList.add('bg-brandYellow', 'text-black', 'hover:bg-yellow-400', 'active-pulse');
  } else {
    nextBtn.disabled = true; nextBtn.classList.add('bg-zinc-700', 'text-zinc-400', 'cursor-not-allowed');
    nextBtn.classList.remove('bg-brandYellow', 'text-black', 'hover:bg-yellow-400', 'active-pulse');
  }
}

// THUẬT TOÁN CENTER CROP CHỐNG MÉO HÌNH
function drawImageCenterCrop(ctx, img, destX, destY, destWidth, destHeight) {
  const imgRatio = img.width / img.height;
  const destRatio = destWidth / destHeight;
  let srcX = 0, srcY = 0, srcWidth = img.width, srcHeight = img.height;

  if (imgRatio > destRatio) {
    srcWidth = img.height * destRatio; srcX = (img.width - srcWidth) / 2;
  } else {
    srcHeight = img.width / destRatio; srcY = (img.height - srcHeight) / 2;
  }
  ctx.drawImage(img, srcX, srcY, srcWidth, srcHeight, destX, destY, destWidth, destHeight);
}

function getCSSFilterString(filter) {
  switch (filter) {
    case 'bright': return 'brightness(1.25) contrast(1.1) saturate(1.1)';
    case 'bw': return 'grayscale(1) contrast(1.4)';
    case 'vintage': return 'sepia(0.4) contrast(0.95) brightness(1.05)';
    default: return 'none';
  }
}

function initFilterWorkspace() { renderCollage(document.getElementById('filter-collage-preview')); }
function applyFilter(filterType) {
  appState.selectedFilter = filterType;
  document.querySelectorAll('.filter-option-btn').forEach(b => b.classList.remove('border-brandYellow'));
  event.currentTarget.classList.add('border-brandYellow');
  document.querySelectorAll('.collage-img-unit').forEach(img => img.style.filter = getCSSFilterString(filterType));
  playBeep(700, 0.08);
}

function initFrameWorkspace() { renderCollage(document.getElementById('frame-collage-preview'), true); }
function selectFrame(frameStyle) {
  appState.selectedFrame = frameStyle;
  document.querySelectorAll('.frame-option-btn').forEach(b => b.classList.remove('border-brandYellow'));
  document.getElementById(`frame-opt-${frameStyle}`).classList.add('border-brandYellow');
  renderCollage(document.getElementById('frame-collage-preview'), true);
  playBeep(800, 0.08);
}

// Hàm vẽ xem trước cấu trúc ảnh (Mô phỏng giống Canvas in thật)
function renderCollage(container, applyFrameStyles = false) {
  container.innerHTML = '';
  const layout = appState.selectedLayout;
  container.style.aspectRatio = layout === 'single_horiz' ? '3/2' : '2/3';

  let frameBg = applyFrameStyles && appState.selectedFrame === 'classic' ? '#121212' : (applyFrameStyles && appState.selectedFrame === 'comic' ? '#FFCC00' : '#ffffff');
  container.style.backgroundColor = frameBg;
  container.style.padding = '8px';

  const innerWrapper = document.createElement('div');
  innerWrapper.className = "w-full h-full flex flex-col gap-1";

  if (layout === 'strip3') {
    innerWrapper.className = "w-full h-full flex gap-2 p-1";
    for (let s = 0; s < 2; s++) {
      const strip = document.createElement('div');
      strip.className = "w-1/2 h-full flex flex-col justify-between gap-1";
      appState.selectedPhotoIndexes.forEach(pIdx => {
        const box = document.createElement('div'); box.className = "flex-1 overflow-hidden bg-zinc-800 border border-black";
        const img = document.createElement('img'); img.src = appState.capturedPhotos[pIdx];
        img.className = "w-full h-full object-cover collage-img-unit";
        img.style.filter = getCSSFilterString(appState.selectedFilter);
        box.appendChild(img); strip.appendChild(box);
      });
      const footer = document.createElement('div'); footer.className = "text-[7px] text-center font-comic text-black";
      footer.innerText = "SAIGON TẾU"; strip.appendChild(footer); innerWrapper.appendChild(strip);
    }
  } else if (layout === 'grid4') {
    const grid = document.createElement('div'); grid.className = "flex-1 grid grid-cols-2 gap-1";
    appState.selectedPhotoIndexes.forEach(pIdx => {
      const box = document.createElement('div'); box.className = "overflow-hidden bg-zinc-800 border border-black";
      const img = document.createElement('img'); img.src = appState.capturedPhotos[pIdx];
      img.className = "w-full h-full object-cover collage-img-unit";
      img.style.filter = getCSSFilterString(appState.selectedFilter);
      box.appendChild(img); grid.appendChild(box);
    });
    innerWrapper.appendChild(grid);
  } else {
    const box = document.createElement('div'); box.className = "flex-1 overflow-hidden bg-zinc-800 border border-black";
    const img = document.createElement('img'); img.src = appState.capturedPhotos[appState.selectedPhotoIndexes[0]];
    img.className = "w-full h-full object-cover collage-img-unit";
    img.style.filter = getCSSFilterString(appState.selectedFilter);
    box.appendChild(img); innerWrapper.appendChild(box);
  }
  container.appendChild(innerWrapper);
}

// BƯỚC 6: Xuất file chất lượng cao thông qua Canvas 1200x1800 chuẩn in nhiệt
function compileFinalCollageCanvas(callback) {
  const canvas = document.createElement('canvas');
  const layout = appState.selectedLayout;
  canvas.width = layout === 'single_horiz' ? 1800 : 1200;
  canvas.height = layout === 'single_horiz' ? 1200 : 1800;
  const ctx = canvas.getContext('2d');

  let bgStyle = appState.selectedFrame === 'classic' ? '#121212' : (appState.selectedFrame === 'comic' ? '#FFCC00' : '#ffffff');
  ctx.fillStyle = bgStyle; ctx.fillRect(0, 0, canvas.width, canvas.height);

  const loadAndDrawImage = (src, x, y, w, h) => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        ctx.save();
        ctx.filter = getCSSFilterString(appState.selectedFilter);
        // Áp dụng Center Crop chống méo hình khi render tệp in thật
        drawImageCenterCrop(ctx, img, x, y, w, h);
        ctx.restore();
        ctx.lineWidth = 6; ctx.strokeStyle = '#000000'; ctx.strokeRect(x, y, w, h);
        resolve();
      };
      img.src = src;
    });
  };

  const run = async () => {
    if (layout === 'strip3') {
      const w = 460, h = 420, cellGap = 20, topY = 80;
      for (let s = 0; s < 2; s++) {
        const currentX = s === 0 ? 80 : 660;
        for (let i = 0; i < 3; i++) {
          await loadAndDrawImage(appState.capturedPhotos[appState.selectedPhotoIndexes[i]], currentX, topY + i * (h + cellGap), w, h);
        }
        ctx.fillStyle = appState.selectedFrame === 'classic' ? '#FFCC00' : '#000000';
        ctx.font = 'bold 36px "Bangers"'; ctx.textAlign = 'center';
        ctx.fillText('SAIGON TẾU', currentX + w / 2, 1450);
      }
    } else if (layout === 'grid4') {
      const w = 480, h = 680, startX = 90, startY = 100, gap = 60;
      for (let i = 0; i < 4; i++) {
        const currentX = startX + (i % 2) * (w + gap);
        const currentY = startY + Math.floor(i / 2) * (h + gap);
        await loadAndDrawImage(appState.capturedPhotos[appState.selectedPhotoIndexes[i]], currentX, currentY, w, h);
      }
      ctx.fillStyle = '#000000'; ctx.font = 'bold 44px "Bangers"'; ctx.textAlign = 'center';
      ctx.fillText('SAIGON TẾU PHOTOPLACE 2026', 600, 1650);
    } else {
      await loadAndDrawImage(appState.capturedPhotos[appState.selectedPhotoIndexes[0]], 100, 100, canvas.width - 200, canvas.height - 350);
    }

    // Đóng gói Base64 và kích hoạt tiến trình in tự động qua Electron Main Process
    const dataUrl = canvas.toDataURL('image/jpeg', 0.98);
    const base64Data = dataUrl.replace(/^data:image\/jpeg;base64,/, "");
    const printDir = path.join(__dirname, 'assets', 'prints');
    if (!fs.existsSync(printDir)) fs.mkdirSync(printDir, { recursive: true });

    const filePath = path.join(printDir, `saigonteu_${Date.now()}.jpg`);
    fs.writeFileSync(filePath, base64Data, 'base64');

    // Gửi tệp xuống driver máy in thật thông qua IPC
    ipcRenderer.send('trigger-silent-print', filePath);
    callback(canvas);
  };
  run();
}

function startPrintingSession() {
  goToStep(6);

  const screen = document.getElementById('printer-lcd-screen');
  const paperCard = document.getElementById('printer-paper-card');
  const inkLayer = document.getElementById('paper-ink-layer');
  const progressStep = document.getElementById('print-progress-step');
  const progressPercent = document.getElementById('print-progress-percent');
  const progressBar = document.getElementById('print-progress-bar');
  const successActions = document.getElementById('print-success-actions');

  // Khởi động hiệu ứng chạy giấy máy in
  paperCard.classList.remove('printing-paper-move');
  setTimeout(() => paperCard.classList.add('printing-paper-move'), 100);

  // Kích hoạt vẽ canvas in thật chất lượng cao
  compileFinalCollageCanvas(async (finalCanvas) => {
    progressStep.innerText = "Đang tải ảnh lên Imgbb...";

    const onlineImageUrl = await uploadToCloud(finalCanvas);
    appState.finalCollageUrl = onlineImageUrl || '';

    // Tiến hành sinh mã QR từ thư viện qrcode.js
    const qrContainer = document.getElementById('qrcode-container');
    qrContainer.innerHTML = ''; // Reset xóa mã QR cũ của lượt chụp trước

    if (onlineImageUrl) {
      if (typeof QRCode !== 'function') {
        qrContainer.innerHTML = "<p class='text-red-500 text-xs font-bold font-sans text-center leading-tight'>Thiếu thư viện QRCode</p>";
        console.error('QRCode library is not available on window.');
        return;
      }

      new QRCode(qrContainer, {
        text: onlineImageUrl,
        width: 180,
        height: 180,
        colorDark: "#000000",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.H
      });
      progressStep.innerText = "Đã tạo mã QR tải ảnh.";
      console.log("Đã vẽ xong mã QR lên màn hình.", onlineImageUrl);
    } else {
      qrContainer.innerHTML = "<p class='text-red-500 text-xs font-bold font-sans text-center leading-tight'>Không tải được ảnh lên Imgbb.<br>Kiểm tra API key.</p>";
      progressStep.innerText = "Upload Imgbb thất bại.";
    }

    let currentProgress = 0;
    let interval = setInterval(() => {
      currentProgress += 1;
      progressPercent.innerText = `${currentProgress}%`;
      progressBar.style.width = `${currentProgress}%`;

      if (currentProgress < 25) {
        screen.innerText = "COLOR: YELLOW"; inkLayer.style.backgroundColor = '#facc15'; progressStep.innerText = "Bơm mực vàng (Yellow Pass)...";
      } else if (currentProgress < 50) {
        screen.innerText = "COLOR: MAGENTA"; inkLayer.style.backgroundColor = '#ec4899'; progressStep.innerText = "Bơm mực đỏ sen (Magenta Pass)...";
      } else if (currentProgress < 75) {
        screen.innerText = "COLOR: CYAN"; inkLayer.style.backgroundColor = '#3b82f6'; progressStep.innerText = "Bơm mực xanh (Cyan Pass)...";
      } else if (currentProgress < 95) {
        screen.innerText = "COLOR: OVERCOAT"; inkLayer.style.backgroundColor = '#ffffff'; inkLayer.style.opacity = '0.2'; progressStep.innerText = "Cán màng bảo vệ bóng bẩy chống bay màu...";
      } else if (currentProgress >= 100) {
        clearInterval(interval);
        screen.innerText = "PRINT READY"; progressStep.innerText = "Xong rồi! Nhận ảnh kỉ niệm tại máy in!";
        paperCard.classList.remove('printing-paper-move');
        paperCard.style.transform = 'translateY(10%)';
        confetti({ particleCount: 120, spread: 60, origin: { y: 0.7 } });
        successActions.classList.remove('hidden');
      }
    }, 100);
  });
}

// Hàm upload ảnh lên Imgbb và trả về URL online
function getImgbbApiKey() {
  const envKey = typeof process !== 'undefined' && process.env ? process.env.IMGBB_API_KEY : '';
  const storedKey = localStorage.getItem('imgbbApiKey') || '';
  return (envKey || storedKey || '').trim();
}

function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.98) {
  return new Promise((resolve) => {
    if (!canvas || typeof canvas.toBlob !== 'function') {
      resolve(null);
      return;
    }
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

async function uploadToCloud(canvas) {
  const apiKey = getImgbbApiKey();
  if (!apiKey) {
    console.error('Thiếu API key Imgbb. Hãy đặt IMGBB_API_KEY hoặc lưu localStorage imgbbApiKey.');
    return null;
  }

  const formData = new FormData();
  const blob = await canvasToBlob(canvas);
  if (!blob) {
    console.error('Không tạo được Blob từ canvas để upload lên Imgbb.');
    return null;
  }

  formData.append('image', blob, 'photobooth.jpg');

  try {
    const response = await fetch(`https://api.imgbb.com/1/upload?key=${apiKey}`, {
      method: 'POST',
      body: formData
    });
    const result = await response.json();

    if (!response.ok || !result.success) {
      const message = result?.error?.message || `HTTP ${response.status}`;
      throw new Error(message);
    }

    if (result.success) {
      return result.data.url_viewer || result.data.url; // Ưu tiên trang xem ảnh để khách tải về
    }

    return null;
  } catch (error) {
    console.error("Lỗi upload ảnh:", error);
    return null;
  }
}

function resetPhotobooth() {
  appState.capturedPhotos = []; appState.selectedPhotoIndexes = [];
  document.getElementById('captured-counter-text').innerText = '0';
  document.getElementById('start-shoot-btn').disabled = false;
  document.getElementById('start-shoot-btn').classList.remove('opacity-50');
  goToStep(1);
}
