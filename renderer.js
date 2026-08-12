const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const LAYOUTS = {
  strip3: { count: 3, name: 'Dải 3 ảnh', cropAspect: 509 / 475.333 },
  quick2: { count: 2, name: 'Nhanh 2 ảnh', cropAspect: 1040 / 724 },
  grid4: { count: 4, name: 'Lưới 4 ô', cropAspect: 509 / 724 },
  strip4_teu_hoa_ca: { count: 4, name: 'Tếu Họa Ca', cropAspect: 382 / 249 },
  single: { count: 1, name: 'Ảnh đơn', cropAspect: 1040 / 1470 }
};

const appState = {
  currentStep: 1,
  selectedLayout: 'strip3',
  capturedPhotos: [],
  capturedPhotoPaths: [],
  currentSlot: 0,
  pendingPhoto: null,
  pendingPath: null,
  selectedFilter: 'normal',
  selectedFrame: 'classic',
  finalCollageUrl: ''
};

let cameraMode = localStorage.getItem('cameraMode') || 'eos';
let selectedDeviceId = localStorage.getItem('cameraDeviceId') || '';
let testStream = null;
let mainStream = null;
let mainPreviewPromise = null;
let eosPreviewGeneration = 0;
let eosConnected = false;
let captureBusy = false;
let cachedImgbbApiKey = null;

const NETWORK_SETTINGS = {
  albumCreateRetries: 3,
  baseRetryDelayMs: 900,
  imgbbRequestTimeoutMs: 45000,
  uploadConcurrency: 3,
  uploadMaxDimension: 2400,
  uploadJpegQuality: 0.9
};

const TEU_HOA_CA_FRAME_PATH = path.join(__dirname, 'assets', 'frames', 'teu-hoa-ca-strip4.png');
const TEU_HOA_CA_SLOTS = [
  { x:114,y:157,width:382,height:249,photo:0 }, { x:717,y:160,width:383,height:249,photo:0 },
  { x:114,y:531,width:383,height:249,photo:1 }, { x:717,y:534,width:383,height:249,photo:1 },
  { x:114,y:907,width:382,height:248,photo:2 }, { x:717,y:910,width:383,height:248,photo:2 },
  { x:114,y:1282,width:382,height:248,photo:3 }, { x:717,y:1285,width:383,height:248,photo:3 }
];

document.addEventListener('DOMContentLoaded', async () => {
  bindControls();
  bindCropGuide();
  await getAvailableCameras();
  selectLayout('strip3');
  updateProgress(1);
});

function bindControls() {
  document.querySelectorAll('[data-layout]').forEach(button => button.addEventListener('click', () => selectLayout(button.dataset.layout)));
  document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
    appState.selectedFilter = button.dataset.filter;
    selectOption('[data-filter]', button);
    renderEditPreview();
  }));
  document.querySelectorAll('[data-frame]').forEach(button => button.addEventListener('click', () => {
    appState.selectedFrame = button.dataset.frame;
    selectOption('[data-frame]', button);
    renderEditPreview();
  }));
}

function selectOption(selector, selected) {
  document.querySelectorAll(selector).forEach(button => button.classList.toggle('selected', button === selected));
}

function selectLayout(layout) {
  if (!LAYOUTS[layout]) return;
  appState.selectedLayout = layout;
  document.querySelectorAll('[data-layout]').forEach(button => button.classList.toggle('selected', button.dataset.layout === layout));
}

function confirmLayout() {
  resetCaptureSlots();
  goToStep(2);
}

function resetCaptureSlots() {
  appState.capturedPhotos = [];
  appState.capturedPhotoPaths = [];
  appState.currentSlot = 0;
  appState.pendingPhoto = null;
  appState.pendingPath = null;
  renderCaptureLayout();
}

function updateProgress(step) {
  document.querySelectorAll('.progress-item').forEach(item => {
    const itemStep = Number(item.dataset.step);
    item.classList.toggle('active', itemStep === step);
    item.classList.toggle('done', itemStep < step);
  });
}

async function goToStep(step) {
  document.querySelectorAll('main > .view').forEach(view => view.classList.add('hidden'));
  document.getElementById(`step-${step}-view`).classList.remove('hidden');
  appState.currentStep = step;
  updateProgress(step);
  if (step === 2) {
    document.getElementById('capture-review').classList.add('hidden');
    renderCaptureLayout();
    try { await startMainCameraPreview(); }
    catch (error) { setCaptureStatus(`LỖI CAMERA: ${error.message}`); }
  } else {
    stopMainCameraPreview();
  }
  if (step === 3) renderEditPreview();
  if (step === 4) {
    document.getElementById('output-choice').classList.remove('hidden');
    document.getElementById('output-result').classList.add('hidden');
  }
}

function layoutGridStyles(layout) {
  if (layout === 'strip3') return { columns: '1fr 1fr', rows: 'repeat(3,1fr)', count: 6 };
  if (layout === 'quick2') return { columns: '1fr', rows: 'repeat(2,1fr)', count: 2 };
  if (layout === 'grid4') return { columns: '1fr 1fr', rows: '1fr 1fr', count: 4 };
  if (layout === 'strip4_teu_hoa_ca') return { columns: '1fr 1fr', rows: 'repeat(4,1fr)', count: 8 };
  return { columns: '1fr', rows: '1fr', count: 1 };
}

function slotPhotoIndex(layout, visualIndex) {
  if (layout === 'strip3') return visualIndex % 3;
  if (layout === 'strip4_teu_hoa_ca') return Math.floor(visualIndex / 2);
  return visualIndex;
}

function renderCaptureLayout() {
  const layout = appState.selectedLayout;
  const config = LAYOUTS[layout];
  const grid = document.getElementById('capture-layout-preview');
  const styles = layoutGridStyles(layout);
  grid.style.gridTemplateColumns = styles.columns;
  grid.style.gridTemplateRows = styles.rows;
  grid.innerHTML = '';
  for (let visualIndex = 0; visualIndex < styles.count; visualIndex += 1) {
    const photoIndex = slotPhotoIndex(layout, visualIndex);
    const slot = document.createElement('div');
    slot.className = 'mini-slot';
    if (photoIndex === appState.currentSlot && !appState.capturedPhotos[photoIndex]) slot.classList.add('current');
    if (appState.capturedPhotos[photoIndex]) {
      slot.classList.add('done');
      const image = document.createElement('img');
      image.src = appState.capturedPhotos[photoIndex];
      slot.appendChild(image);
    } else slot.textContent = photoIndex + 1;
    grid.appendChild(slot);
  }
  const shownSlot = Math.min(appState.currentSlot + 1, config.count);
  document.getElementById('slot-heading').textContent = appState.currentSlot >= config.count ? 'ĐÃ CHỤP XONG' : `ẢNH ${shownSlot} / ${config.count}`;
  document.getElementById('capture-button').disabled = captureBusy || appState.currentSlot >= config.count;
  updateCropGuide();
}

function bindCropGuide() {
  const panel = document.querySelector('.camera-panel');
  const video = document.getElementById('webcam-video');
  const eos = document.getElementById('eos-preview');
  video.addEventListener('loadedmetadata', updateCropGuide);
  video.addEventListener('resize', updateCropGuide);
  eos.addEventListener('load', updateCropGuide);
  if (typeof ResizeObserver === 'function') new ResizeObserver(updateCropGuide).observe(panel);
  else window.addEventListener('resize', updateCropGuide);
}

function activePreviewDimensions() {
  const video = document.getElementById('webcam-video');
  const eos = document.getElementById('eos-preview');
  if (cameraMode === 'eos' && eos.naturalWidth && eos.naturalHeight) return { width: eos.naturalWidth, height: eos.naturalHeight };
  if (video.videoWidth && video.videoHeight) return { width: video.videoWidth, height: video.videoHeight };
  return null;
}

function updateCropGuide() {
  const guide = document.getElementById('crop-guide');
  const panel = document.querySelector('.camera-panel');
  const source = activePreviewDimensions();
  if (!guide || !panel || !source || appState.currentStep !== 2) {
    if (guide) guide.classList.add('hidden');
    return;
  }

  const panelWidth = panel.clientWidth;
  const panelHeight = panel.clientHeight;
  const sourceAspect = source.width / source.height;
  const panelAspect = panelWidth / panelHeight;
  let mediaWidth, mediaHeight, mediaLeft, mediaTop;
  if (panelAspect > sourceAspect) {
    mediaHeight = panelHeight;
    mediaWidth = mediaHeight * sourceAspect;
    mediaLeft = (panelWidth - mediaWidth) / 2;
    mediaTop = 0;
  } else {
    mediaWidth = panelWidth;
    mediaHeight = mediaWidth / sourceAspect;
    mediaLeft = 0;
    mediaTop = (panelHeight - mediaHeight) / 2;
  }

  const targetAspect = LAYOUTS[appState.selectedLayout].cropAspect;
  let safeWidth, safeHeight;
  if (sourceAspect > targetAspect) {
    safeHeight = mediaHeight;
    safeWidth = safeHeight * targetAspect;
  } else {
    safeWidth = mediaWidth;
    safeHeight = safeWidth / targetAspect;
  }
  guide.style.left = `${mediaLeft + (mediaWidth - safeWidth) / 2}px`;
  guide.style.top = `${mediaTop + (mediaHeight - safeHeight) / 2}px`;
  guide.style.width = `${safeWidth}px`;
  guide.style.height = `${safeHeight}px`;
  guide.classList.remove('hidden');

  const keptRatio = sourceAspect > targetAspect ? safeWidth / mediaWidth : safeHeight / mediaHeight;
  const croppedPercent = Math.max(0, Math.round((1 - keptRatio) * 100));
  const direction = sourceAspect > targetAspect ? 'hai bên' : 'trên & dưới';
  document.getElementById('crop-guide-label').innerHTML = `<b>VÙNG ẢNH GIỮ LẠI</b> · Cắt khoảng ${croppedPercent}% ${direction}`;
}

function setCaptureStatus(message) { document.getElementById('capture-status').textContent = message; }
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function retryOperation(operation, options = {}) {
  const {
    retries = 3,
    baseDelayMs = NETWORK_SETTINGS.baseRetryDelayMs,
    shouldRetry = () => true
  } = options;
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !shouldRetry(error, attempt)) break;
      await wait(baseDelayMs * attempt);
    }
  }
  throw lastError;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = NETWORK_SETTINGS.imgbbRequestTimeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function captureCurrentSlot() {
  const target = LAYOUTS[appState.selectedLayout].count;
  if (captureBusy || appState.currentSlot >= target) return;
  captureBusy = true;
  renderCaptureLayout();
  const overlay = document.getElementById('countdown-overlay');
  const countdown = document.getElementById('countdown-text');
  try {
    await startMainCameraPreview();
    overlay.classList.remove('hidden');
    for (let seconds = 5; seconds >= 1; seconds -= 1) {
      countdown.textContent = seconds;
      playBeep(seconds === 1 ? 720 : 440, .12);
      await wait(1000);
    }
    overlay.classList.add('hidden');
    setCaptureStatus('ĐANG CHỤP...');
    playShutterSound();
    document.getElementById('flash-overlay').classList.add('active');
    setTimeout(() => document.getElementById('flash-overlay').classList.remove('active'), 500);
    const captured = await takePhoto();
    appState.pendingPhoto = captured.url;
    appState.pendingPath = captured.filePath;
    document.getElementById('review-image').src = captured.url;
    document.getElementById('capture-review').classList.remove('hidden');
    setCaptureStatus(`ẢNH ${appState.currentSlot + 1} ĐÃ CHỤP`);
  } catch (error) {
    overlay.classList.add('hidden');
    setCaptureStatus('CAMERA GẶP LỖI');
    alert(`Không chụp được ảnh: ${error.message}`);
  } finally {
    captureBusy = false;
    renderCaptureLayout();
  }
}

async function takePhoto() {
  if (cameraMode === 'eos') {
    const filePath = await ipcRenderer.invoke('eos-capture');
    return { url: pathToFileURL(filePath).href, filePath };
  }
  const video = document.getElementById('webcam-video');
  if (!video.videoWidth) throw new Error('Webcam chưa sẵn sàng.');
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0);
  return { url: canvas.toDataURL('image/jpeg', .94), filePath: null };
}

function acceptCapturedPhoto() {
  if (!appState.pendingPhoto) return;
  appState.capturedPhotos[appState.currentSlot] = appState.pendingPhoto;
  appState.capturedPhotoPaths[appState.currentSlot] = appState.pendingPath;
  appState.pendingPhoto = null;
  appState.pendingPath = null;
  appState.currentSlot += 1;
  document.getElementById('capture-review').classList.add('hidden');
  renderCaptureLayout();
  if (appState.currentSlot >= LAYOUTS[appState.selectedLayout].count) {
    setCaptureStatus('HOÀN TẤT TẤT CẢ ẢNH');
    setTimeout(() => goToStep(3), 500);
  } else setCaptureStatus('SẴN SÀNG CHỤP ẢNH TIẾP THEO');
}

function retakeCapturedPhoto() {
  appState.pendingPhoto = null;
  appState.pendingPath = null;
  document.getElementById('capture-review').classList.add('hidden');
  setCaptureStatus(`CHỤP LẠI ẢNH ${appState.currentSlot + 1}`);
  renderCaptureLayout();
}

function getCSSFilterString(filter) {
  return { normal:'none', bright:'brightness(1.15) saturate(1.12)', bw:'grayscale(1) contrast(1.08)', vintage:'sepia(.38) contrast(1.05) saturate(.82)' }[filter] || 'none';
}

function renderEditPreview() {
  const preview = document.getElementById('collage-preview');
  compileFinalCollageCanvas(false).then(canvas => {
    const image = new Image();
    image.src = canvas.toDataURL('image/jpeg', .9);
    image.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block';
    preview.replaceChildren(image);
  }).catch(error => { preview.textContent = error.message; });
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Không tải được ảnh để ghép.'));
    image.src = src;
  });
}

function drawImageCenterCrop(ctx, image, x, y, width, height) {
  const sourceRatio = image.width / image.height;
  const targetRatio = width / height;
  let sx = 0, sy = 0, sw = image.width, sh = image.height;
  if (sourceRatio > targetRatio) { sw = image.height * targetRatio; sx = (image.width - sw) / 2; }
  else { sh = image.width / targetRatio; sy = (image.height - sh) / 2; }
  ctx.drawImage(image, sx, sy, sw, sh, x, y, width, height);
}

function drawBrandFrame(ctx, canvas) {
  const frame = appState.selectedFrame;
  ctx.save();
  if (frame === 'comic') {
    ctx.strokeStyle = '#090909'; ctx.lineWidth = 24; ctx.strokeRect(24,24,canvas.width-48,canvas.height-48);
    ctx.fillStyle = '#ffd21f'; ctx.beginPath(); ctx.arc(1050,145,90,0,Math.PI*2); ctx.fill();
    ctx.fillStyle = '#090909'; ctx.font = '60px Bangers, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('TẾU!',1050,165);
  } else if (frame === 'stage') {
    const gradient = ctx.createLinearGradient(0,0,0,canvas.height); gradient.addColorStop(0,'#ffd21f'); gradient.addColorStop(.2,'transparent'); gradient.addColorStop(.8,'transparent'); gradient.addColorStop(1,'#ffd21f');
    ctx.strokeStyle='#ffd21f';ctx.lineWidth=30;ctx.strokeRect(15,15,canvas.width-30,canvas.height-30);ctx.fillStyle=gradient;ctx.fillRect(30,30,canvas.width-60,canvas.height-60);
  } else { ctx.strokeStyle='#ffd21f';ctx.lineWidth=28;ctx.strokeRect(14,14,canvas.width-28,canvas.height-28); }
  ctx.restore();
}

function drawFooter(ctx, canvas, dark = true) {
  ctx.fillStyle = dark ? '#090909' : '#ffd21f';
  ctx.fillRect(60, canvas.height - 185, canvas.width - 120, 120);
  ctx.fillStyle = dark ? '#ffd21f' : '#090909';
  ctx.textAlign = 'center'; ctx.font = '72px Bangers, sans-serif';
  ctx.fillText('SAIGON TẾU PHOTOBOOTH', canvas.width / 2, canvas.height - 105);
}

async function compileFinalCollageCanvas(saveFile = false) {
  if (appState.capturedPhotos.length < LAYOUTS[appState.selectedLayout].count) throw new Error('Chưa đủ ảnh để ghép.');
  const canvas = document.createElement('canvas');
  canvas.width = 1200; canvas.height = 1800;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0,0,canvas.width,canvas.height);
  const images = await Promise.all(appState.capturedPhotos.map(loadImageElement));
  ctx.filter = getCSSFilterString(appState.selectedFilter);
  const layout = appState.selectedLayout;
  if (layout === 'strip4_teu_hoa_ca' && fs.existsSync(TEU_HOA_CA_FRAME_PATH)) {
    for (const slot of TEU_HOA_CA_SLOTS) drawImageCenterCrop(ctx, images[slot.photo], slot.x, slot.y, slot.width, slot.height);
    ctx.filter = 'none';
    const overlay = await loadImageElement(pathToFileURL(TEU_HOA_CA_FRAME_PATH).href);
    ctx.drawImage(overlay,0,0,canvas.width,canvas.height);
  } else {
    const left=80, top=80, width=1040, bottom=250, gap=22, areaHeight=canvas.height-top-bottom;
    if (layout === 'strip3') {
      const cellW=(width-gap)/2, cellH=(areaHeight-gap*2)/3;
      for(let row=0;row<3;row+=1) for(let col=0;col<2;col+=1) drawImageCenterCrop(ctx,images[row],left+col*(cellW+gap),top+row*(cellH+gap),cellW,cellH);
    } else if (layout === 'quick2') {
      const cellH=(areaHeight-gap)/2;
      images.forEach((image,index)=>drawImageCenterCrop(ctx,image,left,top+index*(cellH+gap),width,cellH));
    } else if (layout === 'grid4') {
      const cellW=(width-gap)/2, cellH=(areaHeight-gap)/2;
      images.forEach((image,index)=>drawImageCenterCrop(ctx,image,left+(index%2)*(cellW+gap),top+Math.floor(index/2)*(cellH+gap),cellW,cellH));
    } else drawImageCenterCrop(ctx,images[0],left,top,width,areaHeight);
    ctx.filter='none'; drawFooter(ctx,canvas,appState.selectedFrame!=='comic'); drawBrandFrame(ctx,canvas);
  }
  if (saveFile) {
    const outputDir = path.join(__dirname,'assets','prints');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir,{recursive:true});
    const filePath = path.join(outputDir,`saigonteu_${Date.now()}.jpg`);
    fs.writeFileSync(filePath,canvas.toDataURL('image/jpeg',.96).replace(/^data:image\/jpeg;base64,/,''),'base64');
    canvas.outputPath = filePath;
  }
  return canvas;
}

async function finishSession(shouldPrint) {
  document.getElementById('output-choice').classList.add('hidden');
  document.getElementById('output-result').classList.remove('hidden');
  const progress = document.getElementById('upload-progress');
  const status = document.getElementById('upload-status');
  const qr = document.getElementById('qrcode-container');
  try {
    progress.style.width='8%'; status.textContent='Đang tạo ảnh ghép chất lượng cao...';
    const canvas = await compileFinalCollageCanvas(true);
    if (shouldPrint) ipcRenderer.send('trigger-silent-print',canvas.outputPath);
    const collageBlob = await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.95));
    if (!collageBlob) throw new Error('Không tạo được file ảnh ghép.');
    progress.style.width='20%'; status.textContent='Đang tải ảnh lên album...';
    const originalsPromise = uploadOriginalPhotos((done,total)=>{ progress.style.width=`${20 + Math.round(done/total*50)}%`; status.textContent=`Đã tải ${done}/${total} ảnh gốc...`; });
    const collagePromise = uploadBlobToImgbb(collageBlob,'saigonteu_collage.jpg');
    const [originals, collage] = await Promise.all([originalsPromise, collagePromise]);
    progress.style.width='82%'; status.textContent='Đang tạo album riêng...';
    const album = await createPhotoSession('photobooth',[...originals,{...collage,kind:'collage',order:originals.length+1}]);
    renderAlbumQr(qr,album.albumUrl);
    progress.style.width='100%';
    document.getElementById('result-badge').textContent=shouldPrint?'ĐÃ GỬI LỆNH IN':'ALBUM ĐÃ SẴN SÀNG';
    document.getElementById('result-title').textContent='QUÉT QR NHẬN ẢNH';
    status.textContent=shouldPrint?'Ảnh đang được máy in xử lý. Quét QR để nhận bản số.':'Quét QR, hoàn thành khảo sát và tải ảnh về điện thoại.';
    document.getElementById('new-session-button').classList.remove('hidden');
  } catch (error) {
    progress.style.width='100%'; progress.style.background='#ef4444';
    document.getElementById('result-title').textContent='CHƯA TẠO ĐƯỢC ALBUM';
    status.textContent=error.message;
    qr.textContent='VUI LÒNG GỌI NHÂN VIÊN HỖ TRỢ';
    document.getElementById('new-session-button').classList.remove('hidden');
  }
}

function getImgbbApiKey() {
  if (cachedImgbbApiKey) return cachedImgbbApiKey;
  const line = fs.readFileSync(path.join(__dirname,'.env'),'utf8').split(/\r?\n/).find(value=>value.trim().startsWith('IMGBB_API_KEY='));
  if (!line) throw new Error('Thiếu IMGBB_API_KEY trong .env.');
  cachedImgbbApiKey = line.slice(line.indexOf('=')+1).trim().replace(/^['"]|['"]$/g,'');
  return cachedImgbbApiKey;
}

async function uploadBlobToImgbb(blob,fileName) {
  return retryOperation(async () => {
    const form = new FormData();
    form.append('image',blob,fileName);
    const response = await fetchWithTimeout(
      `https://api.imgbb.com/1/upload?key=${encodeURIComponent(getImgbbApiKey())}`,
      {method:'POST',body:form}
    );
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result?.error?.message || 'Không upload được ảnh.');
    return { directUrl:result.data.url, viewerUrl:result.data.url_viewer };
  }, {
    retries: 3,
    shouldRetry: error => /abort|timeout|network|fetch/i.test(error?.message || '')
  });
}

async function optimizePhotoBlob(sourceUrl) {
  const image = await loadImageElement(sourceUrl);
  const longestSide = Math.max(image.width, image.height);
  const scale = longestSide > NETWORK_SETTINGS.uploadMaxDimension
    ? NETWORK_SETTINGS.uploadMaxDimension / longestSide
    : 1;
  const targetWidth = Math.max(1, Math.round(image.width * scale));
  const targetHeight = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, targetWidth, targetHeight);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', NETWORK_SETTINGS.uploadJpegQuality));
  if (!blob) throw new Error('Không tạo được ảnh tối ưu để upload.');
  return blob;
}

async function photoBlob(index) {
  const sourceUrl = appState.capturedPhotos[index];
  if (!sourceUrl) throw new Error(`Thiếu ảnh cho vị trí ${index + 1}.`);
  return optimizePhotoBlob(sourceUrl);
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
  return results;
}

async function uploadOriginalPhotos(onProgress) {
  let completed = 0;
  return mapWithConcurrency(
    appState.capturedPhotos,
    NETWORK_SETTINGS.uploadConcurrency,
    async (_photo,index) => {
      const uploaded=await uploadBlobToImgbb(await photoBlob(index),`photo_${index+1}.jpg`);
      completed += 1;
      if(onProgress) onProgress(completed,appState.capturedPhotos.length);
      return {...uploaded,kind:'original',order:index+1};
    }
  );
}

async function createPhotoSession(mode,images) {
  const publicImages=images.map(({directUrl,viewerUrl,kind,order})=>({directUrl,viewerUrl,kind,order}));
  return retryOperation(() => ipcRenderer.invoke('album-create-session',{mode,images:publicImages}), {
    retries: NETWORK_SETTINGS.albumCreateRetries
  });
}

function renderAlbumQr(container,url) {
  container.innerHTML='';
  new QRCode(container,{text:url,width:198,height:198,colorDark:'#000000',colorLight:'#ffffff',correctLevel:QRCode.CorrectLevel.H});
}

function resetPhotobooth() {
  stopMainCameraPreview();
  Object.assign(appState,{currentStep:1,selectedLayout:'strip3',capturedPhotos:[],capturedPhotoPaths:[],currentSlot:0,pendingPhoto:null,pendingPath:null,selectedFilter:'normal',selectedFrame:'classic',finalCollageUrl:''});
  selectLayout('strip3');
  document.querySelectorAll('[data-filter]').forEach(button=>button.classList.toggle('selected',button.dataset.filter==='normal'));
  document.querySelectorAll('[data-frame]').forEach(button=>button.classList.toggle('selected',button.dataset.frame==='classic'));
  document.getElementById('upload-progress').style.cssText='width:0;background:var(--yellow)';
  document.getElementById('qrcode-container').textContent='ĐANG TẠO QR...';
  document.getElementById('new-session-button').classList.add('hidden');
  goToStep(1);
}

async function getAvailableCameras() {
  const select=document.getElementById('camera-select'); select.innerHTML='';
  try {
    const status=await ipcRenderer.invoke('eos-status'); eosConnected=Boolean(status.connected);
    if(eosConnected){const option=document.createElement('option');option.value='eos';option.textContent='Canon EOS';select.appendChild(option);}
    const initial=await navigator.mediaDevices.getUserMedia({video:true,audio:false}); initial.getTracks().forEach(track=>track.stop());
    const devices=(await navigator.mediaDevices.enumerateDevices()).filter(device=>device.kind==='videoinput');
    devices.forEach((device,index)=>{const option=document.createElement('option');option.value=device.deviceId;option.textContent=device.label||`Webcam ${index+1}`;select.appendChild(option);});
    if(cameraMode==='eos'&&eosConnected) select.value='eos';
    else { cameraMode='webcam'; selectedDeviceId=selectedDeviceId||devices[0]?.deviceId||''; select.value=selectedDeviceId; }
  } catch(error) { console.error('Không quét được camera:',error); }
}

async function startWebcam(video,deviceId) {
  const stream=await navigator.mediaDevices.getUserMedia({video:deviceId?{deviceId:{exact:deviceId}}:true,audio:false});
  video.srcObject=stream; await video.play(); return stream;
}

async function startMainCameraPreview() {
  if(mainPreviewPromise) return mainPreviewPromise;
  mainPreviewPromise=(async()=>{
    stopMainCameraPreview();
    const video=document.getElementById('webcam-video'),eos=document.getElementById('eos-preview');
    if(cameraMode==='eos') { video.classList.add('hidden'); eos.classList.remove('hidden'); startEosPreviewLoop(eos); }
    else { eos.classList.add('hidden'); video.classList.remove('hidden'); mainStream=await startWebcam(video,selectedDeviceId); }
    updateCropGuide();
    setCaptureStatus('CAMERA ĐÃ SẴN SÀNG');
  })().finally(()=>{mainPreviewPromise=null;});
  return mainPreviewPromise;
}

function stopMainCameraPreview() {
  if(mainStream){mainStream.getTracks().forEach(track=>track.stop());mainStream=null;}
  eosPreviewGeneration+=1;
}

async function startEosPreviewLoop(imageElement) {
  const generation=++eosPreviewGeneration;
  while(generation===eosPreviewGeneration&&cameraMode==='eos'){
    try { const previewPath=await ipcRenderer.invoke('eos-preview'); imageElement.src=`${pathToFileURL(previewPath).href}?t=${Date.now()}`; }
    catch(error){setCaptureStatus('MẤT KẾT NỐI EOS');await wait(800);}
    await wait(80);
  }
}

function toggleSettingsPanel() {
  const panel=document.getElementById('settings-panel'); panel.classList.toggle('hidden');
  if(panel.classList.contains('hidden')) stopTestCamera(); else startTestCamera();
}

async function startTestCamera() {
  stopTestCamera();
  const video=document.getElementById('test-video'),eos=document.getElementById('test-eos-preview');
  if(cameraMode==='eos'){video.classList.add('hidden');eos.classList.remove('hidden');startEosPreviewLoop(eos);}
  else {eos.classList.add('hidden');video.classList.remove('hidden');testStream=await startWebcam(video,selectedDeviceId);}
}

function stopTestCamera(){if(testStream){testStream.getTracks().forEach(track=>track.stop());testStream=null;}eosPreviewGeneration+=1;}

async function changeCameraDevice(){const value=document.getElementById('camera-select').value;cameraMode=value==='eos'?'eos':'webcam';selectedDeviceId=value==='eos'?'':value;localStorage.setItem('cameraMode',cameraMode);localStorage.setItem('cameraDeviceId',selectedDeviceId);await startTestCamera();}

async function reconnectEosCamera(){const status=await ipcRenderer.invoke('eos-reconnect');eosConnected=Boolean(status.connected);await getAvailableCameras();alert(status.message);}

async function triggerTestCapture(){try{const photo=await takePhoto();document.getElementById('test-eos-preview').src=photo.url;alert('Chụp test thành công.');}catch(error){alert(`Chụp test thất bại: ${error.message}`);}}

function playBeep(frequency,duration){try{const AudioContext=window.AudioContext||window.webkitAudioContext;const context=new AudioContext();const oscillator=context.createOscillator();const gain=context.createGain();oscillator.frequency.value=frequency;gain.gain.value=.08;oscillator.connect(gain);gain.connect(context.destination);oscillator.start();gain.gain.exponentialRampToValueAtTime(.001,context.currentTime+duration);oscillator.stop(context.currentTime+duration);}catch(_){}}
function playShutterSound(){playBeep(900,.08);setTimeout(()=>playBeep(320,.16),80);}
