/**
 * Pet Detection — Standalone Page
 * Handles two modes:
 *   1. Upload Mode   — POST /pet/detect
 *   2. Webcam Mode   — WS  /pet/detect/live
 */

// ============================================================
// DOM refs
// ============================================================
const modeUploadBtn   = document.getElementById('modeUploadBtn');
const modeWebcamBtn   = document.getElementById('modeWebcamBtn');
const uploadSection   = document.getElementById('uploadSection');
const webcamSection   = document.getElementById('webcamSection');

// Upload
const uploadZone      = document.getElementById('uploadZone');
const fileInput       = document.getElementById('fileInput');
const fileStrip       = document.getElementById('fileStrip');
const fileStripName   = document.getElementById('fileStripName');
const fileStripSize   = document.getElementById('fileStripSize');
const analyzeBtn      = document.getElementById('analyzeBtn');
const uploadLoading   = document.getElementById('uploadLoading');
const uploadError     = document.getElementById('uploadError');
const previewWrap     = document.getElementById('previewWrap');
const previewImg      = document.getElementById('previewImg');
const previewCanvas   = document.getElementById('previewCanvas');

// Webcam
const webcamVideo     = document.getElementById('webcamVideo');
const webcamCanvas    = document.getElementById('webcamCanvas');
const webcamPlaceholder = document.getElementById('webcamPlaceholder');
const startBtn        = document.getElementById('startBtn');
const stopBtn         = document.getElementById('stopBtn');
const webcamStatus    = document.getElementById('webcamStatus');
const webcamStatusDot = document.getElementById('webcamStatusDot');
const webcamStatusTxt = document.getElementById('webcamStatusTxt');
const webcamError     = document.getElementById('webcamError');

// Results (shared)
const resultsEmpty    = document.getElementById('resultsEmpty');
const countBadge      = document.getElementById('countBadge');
const countBadgeLabel = document.getElementById('countBadgeLabel');
const countBadgeSub   = document.getElementById('countBadgeSub');
const noPetsBadge     = document.getElementById('noPetsBadge');
const detectionList   = document.getElementById('detectionList');

// ============================================================
// State
// ============================================================
let currentMode       = 'upload'; // 'upload' | 'webcam'
let selectedFile      = null;
let webcamStream      = null;
let ws                = null;
let isLive            = false;
let frameInterval     = null;
let webcamCtx         = null;

const EMOJI = { cat: '🐱', dog: '🐶' };
const BOX_COLOR = { cat: '#f97316', dog: '#a855f7' };

// ============================================================
// MODE SWITCHER
// ============================================================

modeUploadBtn.addEventListener('click', () => switchMode('upload'));
modeWebcamBtn.addEventListener('click', () => switchMode('webcam'));

function switchMode(mode) {
    currentMode = mode;
    modeUploadBtn.classList.toggle('active', mode === 'upload');
    modeWebcamBtn.classList.toggle('active', mode === 'webcam');
    uploadSection.style.display  = mode === 'upload'  ? '' : 'none';
    webcamSection.style.display  = mode === 'webcam'  ? '' : 'none';

    // Stop live session when switching away
    if (mode !== 'webcam' && isLive) {
        stopWebcam();
    }
    clearResults();
}

// ============================================================
// UPLOAD MODE
// ============================================================

uploadZone.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) handleFile(e.target.files[0]);
});

uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadZone.classList.add('dragover');
});

uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));

uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) handleFile(e.dataTransfer.files[0]);
});

analyzeBtn.addEventListener('click', () => {
    if (selectedFile) analyzeImage();
});

function handleFile(file) {
    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    const allowedExts = ['.jpg', '.jpeg', '.png', '.webp'];
    const ext = '.' + file.name.split('.').pop().toLowerCase();

    if (!allowed.includes(file.type) && !allowedExts.includes(ext)) {
        showUploadError('Unsupported format. Please upload JPG, PNG, or WebP.');
        return;
    }

    if (file.size > 10 * 1024 * 1024) {
        showUploadError('File too large. Maximum 10 MB.');
        return;
    }

    selectedFile = file;
    fileStripName.textContent = file.name;
    fileStripSize.textContent = formatSize(file.size);
    fileStrip.classList.add('visible');
    analyzeBtn.disabled = false;
    hideUploadError();
    clearResults();

    // Preview
    const reader = new FileReader();
    reader.onload = (ev) => {
        previewImg.src = ev.target.result;
        previewWrap.classList.add('visible');
        clearPreviewCanvas();
    };
    reader.readAsDataURL(file);
}

async function analyzeImage() {
    if (!selectedFile) return;

    uploadLoading.classList.add('visible');
    analyzeBtn.disabled = true;
    hideUploadError();
    clearResults();

    try {
        const form = new FormData();
        form.append('file', selectedFile);

        const response = await fetch('/pet/detect', { method: 'POST', body: form });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.detail || `Server error (${response.status})`);
        }

        const data = await response.json();
        renderResults(data.detections || []);

        // Draw boxes on preview canvas
        if (previewImg.complete) {
            drawBoxesOnPreview(data.detections || []);
        } else {
            previewImg.onload = () => drawBoxesOnPreview(data.detections || []);
        }

    } catch (err) {
        showUploadError(err.message || 'Analysis failed. Please try again.');
    } finally {
        uploadLoading.classList.remove('visible');
        analyzeBtn.disabled = false;
    }
}

// ============================================================
// WEBCAM MODE
// ============================================================

startBtn.addEventListener('click', startWebcam);
stopBtn.addEventListener('click', stopWebcam);

async function startWebcam() {
    try {
        webcamStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'environment' }
        });
    } catch (err) {
        const msg = err.name === 'NotAllowedError'
            ? 'Camera permission denied. Allow camera access in browser settings.'
            : err.name === 'NotFoundError'
                ? 'No camera found. Please connect a camera.'
                : `Camera error: ${err.message}`;
        showWebcamError(msg);
        return;
    }

    webcamVideo.srcObject = webcamStream;
    await webcamVideo.play();

    webcamPlaceholder.classList.add('hidden');
    webcamVideo.style.display = 'block';

    webcamCtx = webcamCanvas.getContext('2d');
    syncCanvasSize();

    startBtn.style.display = 'none';
    stopBtn.style.display  = '';
    setWebcamStatus('live', 'Live — detecting pets…');
    hideWebcamError();
    clearResults();

    isLive = true;
    await connectWS();

    frameInterval = setInterval(captureAndSend, 250); // ~4 fps is plenty for pets
}

function stopWebcam() {
    isLive = false;

    if (frameInterval)    { clearInterval(frameInterval); frameInterval = null; }
    if (ws)               { try { ws.send(JSON.stringify({ type: 'stop' })); } catch (_) {} ws.close(); ws = null; }
    if (webcamStream)     { webcamStream.getTracks().forEach(t => t.stop()); webcamStream = null; }

    webcamVideo.srcObject = null;
    webcamVideo.style.display = 'none';
    webcamPlaceholder.classList.remove('hidden');

    startBtn.style.display = '';
    stopBtn.style.display  = 'none';
    setWebcamStatus('idle', 'Stopped');
    clearWebcamCanvas();
}

async function connectWS() {
    return new Promise((resolve, reject) => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${proto}//${location.host}/pet/detect/live`);

        ws.onopen = () => resolve();

        ws.onmessage = (ev) => {
            try {
                const msg = JSON.parse(ev.data);
                if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
                if (msg.type === 'detection') handleLiveDetection(msg);
                if (msg.type === 'error')     showWebcamError(msg.message);
            } catch (_) {}
        };

        ws.onerror   = (e) => { console.error('WS error', e); reject(e); };
        ws.onclose   = () => {
            if (isLive) {
                setTimeout(() => { if (isLive) connectWS().catch(console.error); }, 2000);
            }
        };
    });
}

function captureAndSend() {
    if (!webcamVideo || webcamVideo.readyState < webcamVideo.HAVE_ENOUGH_DATA) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const tmp = document.createElement('canvas');
    tmp.width  = 320;
    tmp.height = 240;
    tmp.getContext('2d').drawImage(webcamVideo, 0, 0, 320, 240);

    ws.send(JSON.stringify({ type: 'frame', image: tmp.toDataURL('image/jpeg', 0.65) }));
}

function handleLiveDetection(msg) {
    renderResults(msg.detections || []);
    clearWebcamCanvas();
    if (msg.detections && msg.detections.length > 0) {
        drawBoxesOnWebcam(msg.detections);
    }
}

// ============================================================
// RESULTS RENDERING
// ============================================================

function renderResults(detections) {
    detectionList.innerHTML = '';
    resultsEmpty.style.display = 'none';

    if (!detections || detections.length === 0) {
        countBadge.classList.remove('visible');
        noPetsBadge.classList.add('visible');
        return;
    }

    noPetsBadge.classList.remove('visible');
    countBadge.classList.add('visible');
    countBadgeLabel.textContent = `${detections.length} pet${detections.length > 1 ? 's' : ''} detected`;

    const cats = detections.filter(d => d.label === 'cat').length;
    const dogs = detections.filter(d => d.label === 'dog').length;
    const parts = [];
    if (cats) parts.push(`${cats} cat${cats > 1 ? 's' : ''}`);
    if (dogs) parts.push(`${dogs} dog${dogs > 1 ? 's' : ''}`);
    countBadgeSub.textContent = parts.join(' · ');

    detections.forEach((det, i) => {
        const card = document.createElement('div');
        card.className = `detection-card ${det.label}`;

        const conf = (det.confidence * 100).toFixed(1);
        card.innerHTML = `
            <div class="detection-icon">${EMOJI[det.label] || '🐾'}</div>
            <div class="detection-info">
                <div class="detection-label">#${i + 1} — ${det.label}</div>
                <div class="detection-conf">Confidence: ${conf}%</div>
                <div class="detection-conf-bar">
                    <div class="detection-conf-fill" style="width:${conf}%"></div>
                </div>
            </div>`;
        detectionList.appendChild(card);
    });
}

function clearResults() {
    detectionList.innerHTML = '';
    countBadge.classList.remove('visible');
    noPetsBadge.classList.remove('visible');
    resultsEmpty.style.display = '';
}

// ============================================================
// CANVAS — BOUNDING BOXES
// ============================================================

function drawBoxesOnPreview(detections) {
    if (!detections || detections.length === 0) { clearPreviewCanvas(); return; }

    const canvas = previewCanvas;
    const img    = previewImg;
    canvas.width  = img.naturalWidth;
    canvas.height = img.naturalHeight;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    detections.forEach(det => drawBox(ctx, det, canvas.width, canvas.height, 1, 1));
}

function drawBoxesOnWebcam(detections) {
    if (!webcamCtx) return;
    syncCanvasSize();
    const cw = webcamCanvas.width;
    const ch = webcamCanvas.height;
    const vw = webcamVideo.videoWidth  || 320;
    const vh = webcamVideo.videoHeight || 240;
    const sx = cw / vw;
    const sy = ch / vh;

    detections.forEach(det => drawBox(webcamCtx, det, cw, ch, sx, sy));
}

function drawBox(ctx, det, cw, ch, sx, sy) {
    const [x1, y1, x2, y2] = det.bbox;
    const color = BOX_COLOR[det.label] || '#3b82f6';

    const bx = x1 * sx;
    const by = y1 * sy;
    const bw = (x2 - x1) * sx;
    const bh = (y2 - y1) * sy;

    // Box
    ctx.strokeStyle = color;
    ctx.lineWidth   = 2.5;
    ctx.strokeRect(bx, by, bw, bh);

    // Corner accents
    const cs = Math.min(bw, bh) * 0.12;
    ctx.lineWidth = 4;
    ctx.strokeStyle = color;
    [[bx, by], [bx + bw, by], [bx, by + bh], [bx + bw, by + bh]].forEach(([cx, cy], i) => {
        ctx.beginPath();
        const dx = i % 2 === 0 ? 1 : -1;
        const dy = i < 2 ? 1 : -1;
        ctx.moveTo(cx, cy + dy * cs);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx + dx * cs, cy);
        ctx.stroke();
    });

    // Label pill
    const label = `${EMOJI[det.label] || '🐾'} ${det.label} ${(det.confidence * 100).toFixed(0)}%`;
    ctx.font      = 'bold 13px Inter, Arial, sans-serif';
    const tw      = ctx.measureText(label).width;
    const ph      = 22;
    const pw      = tw + 16;
    const px      = bx;
    const py      = by - ph - 4 < 0 ? by + 4 : by - ph - 4;

    ctx.fillStyle = color;
    roundRect(ctx, px, py, pw, ph, 6);
    ctx.fill();

    ctx.fillStyle = '#fff';
    ctx.fillText(label, px + 8, py + ph - 6);
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

function clearPreviewCanvas() {
    const ctx = previewCanvas.getContext('2d');
    ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
}

function clearWebcamCanvas() {
    if (webcamCtx) webcamCtx.clearRect(0, 0, webcamCanvas.width, webcamCanvas.height);
}

function syncCanvasSize() {
    if (!webcamVideo || !webcamCanvas) return;
    const r = webcamVideo.getBoundingClientRect();
    webcamCanvas.width  = r.width  || webcamVideo.videoWidth  || 640;
    webcamCanvas.height = r.height || webcamVideo.videoHeight || 480;
}

// ============================================================
// UI HELPERS
// ============================================================

function showUploadError(msg) {
    uploadError.textContent = msg;
    uploadError.classList.add('visible');
}
function hideUploadError() {
    uploadError.classList.remove('visible');
}
function showWebcamError(msg) {
    webcamError.textContent = msg;
    webcamError.classList.add('visible');
}
function hideWebcamError() {
    webcamError.classList.remove('visible');
}

function setWebcamStatus(state, text) {
    webcamStatusDot.className = `status-dot ${state}`;
    webcamStatusTxt.textContent = text;
}

function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

// Resize canvas when window resizes during live session
window.addEventListener('resize', () => {
    if (isLive) syncCanvasSize();
});
