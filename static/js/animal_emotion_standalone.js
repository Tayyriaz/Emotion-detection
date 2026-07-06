/**
 * Animal Emotion Detection — Standalone Page
 * Calls POST /api/animal/analyze, renders result card with
 * emotion label, confidence bar, and full distribution.
 */

// ── DOM refs ──────────────────────────────────────────────────
const uploadZone    = document.getElementById('uploadZone');
const fileInput     = document.getElementById('fileInput');
const fileStrip     = document.getElementById('fileStrip');
const fileStripName = document.getElementById('fileStripName');
const fileStripSize = document.getElementById('fileStripSize');
const previewWrap   = document.getElementById('previewWrap');
const previewImg    = document.getElementById('previewImg');
const analyzeBtn    = document.getElementById('analyzeBtn');
const loading       = document.getElementById('loading');
const errorBanner   = document.getElementById('errorBanner');
const resultsEmpty  = document.getElementById('resultsEmpty');
const resultCard    = document.getElementById('resultCard');

// result card elements
const heroEmoji  = document.getElementById('heroEmoji');
const heroLabel  = document.getElementById('heroLabel');
const heroConf   = document.getElementById('heroConf');
const confFill   = document.getElementById('confFill');
const distList   = document.getElementById('distList');
const metaModel  = document.getElementById('metaModel');
const metaTime   = document.getElementById('metaTime');

// ── Emotion → emoji map (labels from dima806/pets_facial_expression_detection)
const EMOJI_MAP = {
    happy:   '😄', Happy:   '😄',
    angry:   '😠', Angry:   '😠',
    sad:     '😢', Sad:     '😢',
    other:   '😐', Other:   '😐',
};

function emojiFor(label) {
    return EMOJI_MAP[label?.toLowerCase()] || '🐾';
}

// ── State ─────────────────────────────────────────────────────
let selectedFile = null;

// ── Upload zone events ────────────────────────────────────────
uploadZone.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', e => {
    if (e.target.files.length > 0) handleFile(e.target.files[0]);
});

uploadZone.addEventListener('dragover', e => {
    e.preventDefault();
    uploadZone.classList.add('dragover');
});
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
uploadZone.addEventListener('drop', e => {
    e.preventDefault();
    uploadZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) handleFile(e.dataTransfer.files[0]);
});

analyzeBtn.addEventListener('click', runAnalysis);

// ── File handling ─────────────────────────────────────────────
function handleFile(file) {
    const allowed = ['image/jpeg', 'image/jpg', 'image/png'];
    const allowedExts = ['.jpg', '.jpeg', '.png'];
    const ext = '.' + file.name.split('.').pop().toLowerCase();

    if (!allowed.includes(file.type) && !allowedExts.includes(ext)) {
        showError('Unsupported format. Please upload JPEG or PNG.');
        return;
    }
    if (file.size > 5 * 1024 * 1024) {
        showError('File too large. Maximum allowed size is 5 MB.');
        return;
    }

    selectedFile = file;
    fileStripName.textContent = file.name;
    fileStripSize.textContent = formatBytes(file.size);
    fileStrip.classList.add('visible');
    analyzeBtn.disabled = false;
    hideError();
    clearResults();

    const reader = new FileReader();
    reader.onload = ev => {
        previewImg.src = ev.target.result;
        previewWrap.classList.add('visible');
    };
    reader.readAsDataURL(file);
}

// ── Analysis ──────────────────────────────────────────────────
async function runAnalysis() {
    if (!selectedFile) return;

    setLoading(true);
    hideError();
    clearResults();

    try {
        const form = new FormData();
        form.append('file', selectedFile);

        const t0 = performance.now();
        const res = await fetch('/api/animal/analyze', { method: 'POST', body: form });
        const elapsed = ((performance.now() - t0) / 1000).toFixed(2);

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `Server error (${res.status})`);
        }

        const data = await res.json();
        renderResult(data, elapsed);

    } catch (err) {
        showError(err.message || 'Analysis failed. Please try again.');
    } finally {
        setLoading(false);
    }
}

// ── Render result ─────────────────────────────────────────────
function renderResult(data, elapsed) {
    resultsEmpty.style.display = 'none';

    const label = data.label || 'unknown';
    const conf  = data.confidence_score || 0;
    const pct   = (conf * 100).toFixed(1);

    // Hero
    heroEmoji.textContent = emojiFor(label);
    heroLabel.textContent = label;
    heroConf.textContent  = `Confidence: ${pct}%`;
    confFill.style.width  = `${pct}%`;

    // Distribution bars
    distList.innerHTML = '';
    const emotions = data.all_emotions || {};
    const sorted = Object.entries(emotions).sort((a, b) => b[1] - a[1]);

    sorted.forEach(([lbl, score]) => {
        const p = (score * 100).toFixed(1);
        const row = document.createElement('div');
        row.className = 'dist-item';
        row.innerHTML = `
            <span class="dist-label">${emojiFor(lbl)} ${lbl}</span>
            <div class="dist-bar-wrap">
                <div class="dist-bar-fill" style="width:${p}%;
                     opacity:${lbl === label ? '1' : '0.5'}"></div>
            </div>
            <span class="dist-conf">${p}%</span>`;
        distList.appendChild(row);
    });

    // Meta
    if (metaModel) metaModel.textContent = data.backend || 'vit-animal-emotion';
    if (metaTime)  metaTime.textContent  = `${elapsed}s`;

    resultCard.classList.add('visible');

    // Disagree button
    const fbRow = document.getElementById('standaloneFeedbackRow');
    if (fbRow && window.Feedback) {
        fbRow.innerHTML = '';
        fbRow.appendChild(window.Feedback.createDisagreeButton({
            modality: 'animal',
            predicted_label: label,
            predicted_confidence: conf,
        }));
    }
}

function clearResults() {
    resultCard.classList.remove('visible');
    resultsEmpty.style.display = '';
    distList.innerHTML = '';
    confFill.style.width = '0%';
}

// ── UI helpers ────────────────────────────────────────────────
function setLoading(on) {
    loading.classList.toggle('visible', on);
    analyzeBtn.disabled = on;
}
function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.classList.add('visible');
}
function hideError() {
    errorBanner.classList.remove('visible');
}
function formatBytes(b) {
    if (!b) return '0 B';
    const k = 1024, s = ['B','KB','MB'];
    const i = Math.floor(Math.log(b) / Math.log(k));
    return `${(b / Math.pow(k, i)).toFixed(1)} ${s[i]}`;
}
