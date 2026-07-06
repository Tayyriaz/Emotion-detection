/**
 * Multimodal Emotion Analyzer - Main Application
 * Production-ready JavaScript matching client architecture
 */

(function () {
    'use strict';

    // ============================================
    // DOM SELECTORS
    // ============================================
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => Array.from(document.querySelectorAll(sel));

    // ============================================
    // STATE MANAGEMENT
    // ============================================
    const videoState = {
        isRecording: false,
        startTs: 0,
        duration: 0,
        pollId: null,
        timerId: null,
        canvasUpdateId: null,  // Continuous canvas update loop
        useBrowserWebcam: true,
        sessionCount: 0,
        activeSessionId: null,
        userId: null,
        timeline: [],
        emotionHistory: [],
        auHistory: [],
        ws: null,  // WebSocket connection
        lastBbox: null,        // Legacy single-face bbox (fallback)
        lastFaces: null,       // Multi-face array [{bbox, emotion, confidence, is_pov}]
        lastRoom: null,        // Last room aggregate (for storage restore)
        videoSource: 'webcam', // 'webcam' | 'screen'
        captureW: 320,         // Width used when last frame was captured for inference
        captureH: 240,         // Height used (aspect-ratio-correct, NOT hardcoded 240)
        facingMode: 'user',    // 'user' = front / selfie, 'environment' = back (mobile)
        selectedDeviceId: null,
        resumeFromStorage: false,
    };

    // ------------------------------------------------------------------ //
    // Browser session persistence (Issue #2 — survive refresh / disconnect)
    // ------------------------------------------------------------------ //
    const SESSION_STORAGE_KEY = 'emotion_analyzer_video_session_v1';
    const SESSION_RESTORE_MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours
    let _persistSessionTimer = null;

    function createSessionId() {
        return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    }

    function getOrCreateUserId() {
        if (videoState.userId) return videoState.userId;
        try {
            const existing = localStorage.getItem('emotion_analyzer_user_id');
            if (existing) {
                videoState.userId = existing;
                return existing;
            }
        } catch (_) { /* private browsing */ }
        videoState.userId = `user_${Math.random().toString(36).slice(2, 11)}`;
        try {
            localStorage.setItem('emotion_analyzer_user_id', videoState.userId);
        } catch (_) { /* ignore */ }
        return videoState.userId;
    }

    function captureChartSeries() {
        const series = {};
        if (emotionChart?.data?.datasets?.[0]) {
            series.emotionTimeline = {
                labels: emotionChart.data.labels.slice(),
                data: emotionChart.data.datasets[0].data.slice(),
            };
        }
        if (roomComparisonChart?.data?.datasets?.length >= 2) {
            series.roomComparison = {
                labels: roomComparisonChart.data.labels.slice(),
                pov: roomComparisonChart.data.datasets[0].data.slice(),
                room: roomComparisonChart.data.datasets[1].data.slice(),
            };
        }
        if (emotionMultiChart?.data?.datasets) {
            series.emotionMulti = {
                labels: emotionMultiChart.data.labels.slice(),
                datasets: emotionMultiChart.data.datasets.map((ds) => ({
                    label: ds.label,
                    data: ds.data.slice(),
                })),
            };
        }
        return series;
    }

    function applyChartSeries(series) {
        if (!series) return;
        if (series.emotionTimeline && emotionChart) {
            emotionChart.data.labels = series.emotionTimeline.labels;
            emotionChart.data.datasets[0].data = series.emotionTimeline.data;
            emotionChart.update('none');
        }
        if (series.roomComparison && roomComparisonChart) {
            roomComparisonChart.data.labels = series.roomComparison.labels;
            roomComparisonChart.data.datasets[0].data = series.roomComparison.pov;
            roomComparisonChart.data.datasets[1].data = series.roomComparison.room;
            roomComparisonChart.update('none');
        }
        if (series.emotionMulti && emotionMultiChart) {
            emotionMultiChart.data.labels = series.emotionMulti.labels;
            series.emotionMulti.datasets.forEach((saved, idx) => {
                if (emotionMultiChart.data.datasets[idx]) {
                    emotionMultiChart.data.datasets[idx].data = saved.data;
                }
            });
            emotionMultiChart.update('none');
        }
    }

    function buildSessionSnapshot(wasInterrupted = false) {
        const lastEntry = videoState.timeline[videoState.timeline.length - 1];
        return {
            version: 1,
            activeSessionId: videoState.activeSessionId,
            userId: getOrCreateUserId(),
            isRecording: videoState.isRecording,
            wasInterrupted: wasInterrupted || videoState.resumeFromStorage,
            sessionCount: videoState.sessionCount,
            startTs: videoState.startTs,
            duration: videoState.duration,
            videoSource: videoState.videoSource,
            timeline: videoState.timeline,
            emotionHistory: videoState.emotionHistory,
            auHistory: videoState.auHistory,
            lastRoom: videoState.lastRoom,
            chartSeries: captureChartSeries(),
            lastEmotion: lastEntry?.label || null,
            lastConfidence: lastEntry?.confidence ?? null,
            updatedAt: Date.now(),
        };
    }

    function persistSessionToStorage(wasInterrupted = false) {
        if (!videoState.activeSessionId || videoState.timeline.length === 0) return;
        try {
            localStorage.setItem(
                SESSION_STORAGE_KEY,
                JSON.stringify(buildSessionSnapshot(wasInterrupted))
            );
        } catch (err) {
            console.warn('Session backup to localStorage failed:', err);
        }
    }

    function schedulePersistSession() {
        clearTimeout(_persistSessionTimer);
        _persistSessionTimer = setTimeout(() => persistSessionToStorage(false), 400);
    }

    function clearSessionStorage() {
        try {
            localStorage.removeItem(SESSION_STORAGE_KEY);
        } catch (_) { /* ignore */ }
    }

    function showSessionRestoreBanner(message) {
        let banner = $('#sessionRestoreBanner');
        if (!banner) {
            banner = document.createElement('div');
            banner.id = 'sessionRestoreBanner';
            banner.className = 'session-restore-banner';
            banner.innerHTML = '<span id="sessionRestoreBannerText"></span><button type="button" id="sessionRestoreDismiss" aria-label="Dismiss">×</button>';
            const videoTab = $('#videoTab');
            (videoTab || document.body).prepend(banner);
            $('#sessionRestoreDismiss')?.addEventListener('click', () => banner.remove());
        }
        const text = $('#sessionRestoreBannerText');
        if (text) text.textContent = message;
        banner.style.display = 'flex';
    }

    function restoreVideoSessionFromStorage() {
        let raw;
        try {
            raw = localStorage.getItem(SESSION_STORAGE_KEY);
        } catch (_) {
            return false;
        }
        if (!raw) return false;

        let snap;
        try {
            snap = JSON.parse(raw);
        } catch (_) {
            clearSessionStorage();
            return false;
        }

        if (!snap?.activeSessionId || !Array.isArray(snap.timeline) || snap.timeline.length === 0) {
            return false;
        }
        if (Date.now() - (snap.updatedAt || 0) > SESSION_RESTORE_MAX_AGE_MS) {
            clearSessionStorage();
            return false;
        }

        const recent = Date.now() - (snap.updatedAt || 0) < 15 * 60 * 1000;
        const shouldRestore = snap.wasInterrupted || snap.isRecording || recent;
        if (!shouldRestore) return false;

        videoState.activeSessionId = snap.activeSessionId;
        videoState.userId = snap.userId || getOrCreateUserId();
        videoState.sessionCount = snap.sessionCount || 0;
        videoState.timeline = snap.timeline;
        videoState.emotionHistory = snap.emotionHistory || [];
        videoState.auHistory = snap.auHistory || [];
        videoState.duration = snap.duration || (snap.timeline.at(-1)?.t ?? 0);
        videoState.videoSource = snap.videoSource || 'webcam';
        videoState.lastRoom = snap.lastRoom || null;
        videoState.resumeFromStorage = true;

        applyChartSeries(snap.chartSeries);

        const last = snap.timeline[snap.timeline.length - 1];
        if (last?.scores) updateEmotionBars(last.scores);
        if (snap.lastRoom) {
            updateHarmonyMeter(snap.lastRoom);
            if (snap.lastRoom.social_prompt) updateGuidanceBox(snap.lastRoom.social_prompt);
        }
        if (snap.lastEmotion) {
            $('#currentEmotion').textContent = formatEmotionCertainty(
                normalizeEmotion(snap.lastEmotion),
                snap.lastConfidence ?? 0
            );
        }
        $('#videoTimer').textContent = fmtTime(videoState.duration);
        $('#sessionCount').textContent = `Session: ${videoState.sessionCount}`;

        const pts = snap.timeline.length;
        showSessionRestoreBanner(
            `Restored ${pts} tracking point${pts !== 1 ? 's' : ''} from your last session. Press Start to resume live analysis.`
        );
        console.log('📦 Restored video session from localStorage:', snap.activeSessionId);
        return true;
    }

    function setupSessionPersistenceHooks() {
        window.addEventListener('pagehide', () => {
            if (videoState.isRecording || videoState.timeline.length > 0) {
                persistSessionToStorage(videoState.isRecording);
            }
        });
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                schedulePersistSession();
            }
        });
    }

    const audioState = {
        isRecording: false,
        mediaRecorder: null,
        audioChunks: [],
        stream: null,
        analyser: null,
        rafId: null,
        audioCtx: null,
        source: null,
        recordingStartTime: 0
    };

    const auAnalytics = {
        history: [],
        stats: {},
        totalFrames: 0,
        startTime: null
    };

    // ============================================
    // CHART INSTANCES
    // ============================================
    let emotionChart = null;
    let emotionBars = null;
    let emotionMultiChart = null;
    let emotionPie = null;
    let auTimeSeriesChart = null;
    let auDistributionChart = null;
    let auTopChart = null;
    let auCorrelationChart = null;
    let roomComparisonChart = null;   // POV vs Room dual-line chart

    // ============================================
    // INITIALIZATION
    // ============================================
    function init() {
        console.log('Initializing Multimodal Emotion Analyzer...');
        
        setupTabs();
        setupEvents();
        initCharts();
        setupSessionPersistenceHooks();
        restoreVideoSessionFromStorage();
        initImageTab();
        initializeHealthAndModels();
        checkCameras();
        setupSessionHistoryResume();

        console.log('✅ Initialization complete');
    }

    // ── Session History: listen for resume events from session_history.js ────
    function setupSessionHistoryResume() {
        document.addEventListener('sh:resume', (e) => {
            const { session_id, name, checkpoint } = e.detail || {};
            if (!session_id) return;

            // Pre-fill the session ID so the next "Start Recording" uses it
            videoState.activeSessionId = session_id;

            // Store in localStorage so it survives a page refresh
            try {
                const stored = JSON.parse(localStorage.getItem('emotion_analyzer_video_session_v1') || '{}');
                stored.sessionId = session_id;
                if (name) stored.sessionName = name;
                localStorage.setItem('emotion_analyzer_video_session_v1', JSON.stringify(stored));
            } catch (_) {}

            // Switch to video tab so the user can see controls
            const videoTabBtn = document.getElementById('videoTabBtn');
            if (videoTabBtn) videoTabBtn.click();

            // Show confirmation banner
            const banner = document.createElement('div');
            banner.style.cssText =
                'padding:10px 16px;background:rgba(99,102,241,.15);border:1px solid rgba(99,102,241,.3);'
                + 'border-radius:8px;color:#a5b4fc;font-size:.85rem;font-weight:600;margin-bottom:12px;';
            banner.innerHTML =
                `▶ Resuming: <strong>${name || session_id}</strong> — click Start Recording to continue`;
            banner.id = 'resumeBanner';

            const placeholder = document.getElementById('videoPlaceholder');
            const existing = document.getElementById('resumeBanner');
            if (existing) existing.remove();
            if (placeholder && placeholder.parentNode) {
                placeholder.parentNode.insertBefore(banner, placeholder);
                setTimeout(() => banner.remove(), 8000);
            }

            console.log('Session resume prepared:', session_id);
        });
    }

    function setupTabs() {
        const tabBtns = $$('.tab-btn');
        const tabContents = $$('.tab-content');
        
        tabBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const targetTab = btn.dataset.tab;
                
                // Update buttons
                tabBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                
                // Update content
                tabContents.forEach(content => {
                    content.classList.remove('active');
                    if (content.id === `${targetTab}Tab`) {
                        content.classList.add('active');
                    }
                });
            });
        });
    }

    // ============================================
    // IMAGE FUNCTIONS
    // ============================================
    let imageEmotionChart = null;

    function initImageTab() {
        // Setup image file input
        $('#imageUploadArea')?.addEventListener('click', () => $('#imageFileInput')?.click());
        $('#imageFileInput')?.addEventListener('change', handleImageFileSelect);
        $('#analyzeImageBtn')?.addEventListener('click', analyzeImage);
        
        // Drag & drop for image
        const uploadArea = $('#imageUploadArea');
        if (uploadArea) {
            uploadArea.addEventListener('dragover', (e) => {
                e.preventDefault();
                uploadArea.style.borderColor = 'var(--primary)';
            });
            
            uploadArea.addEventListener('dragleave', () => {
                uploadArea.style.borderColor = 'var(--border)';
            });
            
            uploadArea.addEventListener('drop', (e) => {
                e.preventDefault();
                uploadArea.style.borderColor = 'var(--border)';
                if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                    const file = e.dataTransfer.files[0];
                    if (file.type.startsWith('image/')) {
                        handleImageFile(file);
                    } else {
                        alert('Please drop an image file (JPG, PNG, WebP)');
                    }
                }
            });
        }
        
        // Initialize image emotion chart
        initImageEmotionChart();
    }

    function initImageEmotionChart() {
        const ctx = $('#imageEmotionChart')?.getContext('2d');
        if (ctx) {
            imageEmotionChart = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: ['Happiness', 'Sadness', 'Anger', 'Fear', 'Surprise', 'Disgust', 'Neutral'],
                    datasets: [{
                        label: 'Confidence',
                        data: [0, 0, 0, 0, 0, 0, 0],
                        backgroundColor: [
                            'rgba(16, 185, 129, 0.6)',
                            'rgba(59, 130, 246, 0.6)',
                            'rgba(239, 68, 68, 0.6)',
                            'rgba(245, 158, 11, 0.6)',
                            'rgba(249, 115, 22, 0.6)',
                            'rgba(132, 204, 22, 0.6)',
                            'rgba(148, 163, 184, 0.6)'
                        ]
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            backgroundColor: 'rgba(15, 23, 42, 0.9)',
                            titleColor: '#e2e8f0',
                            bodyColor: '#e2e8f0'
                        }
                    },
                    scales: {
                        y: {
                            beginAtZero: true,
                            max: 100,
                            ticks: { color: '#94a3b8', font: { size: 10 } },
                            grid: { color: 'rgba(255, 255, 255, 0.05)' }
                        },
                        x: {
                            ticks: { color: '#94a3b8', font: { size: 10 } },
                            grid: { color: 'rgba(255, 255, 255, 0.05)' }
                        }
                    }
                }
            });
        }
    }

    function handleImageFileSelect(e) {
        const file = e.target.files[0];
        if (file) {
            handleImageFile(file);
        }
    }

    function handleImageFile(file) {
        console.log('📷 Image file selected:', {
            name: file.name,
            size: file.size,
            type: file.type,
            isFile: file instanceof File
        });
        
        // Validate file is a File object
        if (!(file instanceof File)) {
            console.error('❌ Invalid file object:', typeof file, file);
            alert('Invalid file. Please try selecting the file again.');
            return;
        }
        
        // Validate file type
        const supportedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
        const supportedExtensions = ['.jpg', '.jpeg', '.png', '.webp'];
        const fileName = file.name.toLowerCase();
        const hasValidType = supportedTypes.includes(file.type.toLowerCase());
        const hasValidExtension = supportedExtensions.some(ext => fileName.endsWith(ext));
        
        if (!hasValidType && !hasValidExtension) {
            alert('Invalid file type. Please select JPG, PNG, or WebP image.');
            return;
        }
        
        // Validate file size (max 10MB)
        const maxSizeMB = 10;
        if (file.size > maxSizeMB * 1024 * 1024) {
            alert(`File too large. Maximum size is ${maxSizeMB}MB.`);
            return;
        }
        
        // Validate file is not empty
        if (file.size === 0) {
            alert('File is empty. Please select a valid image file.');
            return;
        }
        
        // Show file info
        $('#imageFileName').textContent = file.name;
        $('#imageFileSize').textContent = formatFileSize(file.size);
        $('#imageFileInfo').style.display = 'flex';
        
        // Show preview with error handling
        const reader = new FileReader();
        reader.onerror = (error) => {
            console.error('❌ FileReader error:', error);
            alert('Failed to read image file. Please try again.');
        };
        reader.onload = (e) => {
            try {
                const preview = $('#imagePreview');
                const container = $('#imagePreviewContainer');
                if (preview && container) {
                    preview.src = e.target.result;
                    preview.onerror = () => {
                        console.error('❌ Image preview error');
                        alert('Failed to display image preview. File may be corrupted.');
                    };
                    container.style.display = 'block';
                }
            } catch (error) {
                console.error('❌ Preview display error:', error);
                alert('Failed to display image preview.');
            }
        };
        reader.readAsDataURL(file);
        
        // Show analyze button
        $('#analyzeImageBtn').style.display = 'inline-flex';
        $('#imageEmptyState').style.display = 'none';
        $('#imageResults').style.display = 'none';
        $('#imageEmotionChartCard').style.display = 'none';
        $('#imageEmotionDetails').style.display = 'none';
        $('#imageErrorMessage').style.display = 'none';
        
        // Store file for analysis
        window.selectedImageFile = file;
        
        console.log('✅ Image file validated and ready for analysis');
    }

    async function analyzeImage() {
        const file = window.selectedImageFile || $('#imageFileInput')?.files[0];
        
        if (!file) {
            alert('Please select an image file first');
            return;
        }
        
        // Validate file
        if (!(file instanceof File)) {
            console.error('Invalid file type:', typeof file, file);
            alert('Invalid file. Please select a valid image file.');
            return;
        }
        
        // Show loading
        $('#analyzeImageBtn').disabled = true;
        $('#analyzeImageBtn').textContent = 'Analyzing...';
        $('#imageErrorMessage').style.display = 'none';
        $('#imageEmptyState').style.display = 'none';
        $('#imageStatus').textContent = 'Image: Analyzing...';
        $('#imageStatus').className = 'badge badge-live';
        
        try {
            const formData = new FormData();
            formData.append('file', file);
            
            console.log('📤 Uploading image for analysis:', {
                name: file.name,
                size: file.size,
                type: file.type
            });
            
            const response = await fetch('/image/emotion', {
                method: 'POST',
                body: formData
            });
            
            console.log('📥 Response status:', response.status);
            
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ detail: `HTTP ${response.status}` }));
                throw new Error(errorData.detail || `Request failed: ${response.status}`);
            }
            
            const data = await response.json();
            console.log('✅ Image analysis response:', data);
            
            displayImageResults(data);
            
            // Update status
            $('#imageStatus').textContent = 'Image: Complete';
            $('#imageStatus').className = 'badge badge-live';
            
        } catch (error) {
            console.error('❌ Image analysis error:', error);
            showImageError(error.message || 'Failed to analyze image');
            $('#imageStatus').textContent = 'Image: Error';
            $('#imageStatus').className = 'badge badge-idle';
        } finally {
            $('#analyzeImageBtn').disabled = false;
            $('#analyzeImageBtn').textContent = 'Analyze Emotion';
        }
    }

    function displayImageResults(data) {
        if (!data.success) {
            $('#imageEmotion').textContent = 'No Face Detected';
            $('#imageConfidence').textContent = '0%';
            showImageError('No face detected in the image. Please upload an image with a clear face.');
            return;
        }
        
        // Update emotion and confidence
        const emotion = normalizeEmotion(data.emotion);
        const confidence = (data.confidence || 0) * 100;
        
        $('#imageEmotion').textContent = emotion;
        $('#imageConfidence').textContent = `${confidence.toFixed(1)}%`;
        
        // Show results
        $('#imageResults').style.display = 'grid';
        $('#imageEmptyState').style.display = 'none';
        
        // Update emotion chart with all emotion scores
        if (imageEmotionChart) {
            const emotionLabels = ['happiness', 'sadness', 'anger', 'fear', 'surprise', 'disgust', 'neutral'];
            
            if (data.emotions && Object.keys(data.emotions).length > 0) {
                // Use all emotion scores from response
                const chartData = emotionLabels.map(label => {
                    const score = data.emotions[label] || 0;
                    return score * 100; // Convert to percentage
                });
                imageEmotionChart.data.datasets[0].data = chartData;
            } else {
                // Fallback: show only dominant emotion
                const emotionIndex = emotionLabels.indexOf(data.emotion.toLowerCase());
                const chartData = [0, 0, 0, 0, 0, 0, 0];
                if (emotionIndex >= 0) {
                    chartData[emotionIndex] = confidence;
                }
                imageEmotionChart.data.datasets[0].data = chartData;
            }
            
            imageEmotionChart.update('none');
            $('#imageEmotionChartCard').style.display = 'block';
        }
        
        // Show emotion details with all scores
        const scoresContainer = $('#imageEmotionScores');
        if (scoresContainer) {
            if (data.emotions && Object.keys(data.emotions).length > 0) {
                // Sort emotions by score (descending)
                const sortedEmotions = Object.entries(data.emotions)
                    .sort((a, b) => b[1] - a[1])
                    .map(([emotion, score]) => ({
                        emotion: normalizeEmotion(emotion),
                        score: score * 100
                    }));
                
                scoresContainer.innerHTML = sortedEmotions.map(item => `
                    <div class="emotion-score-item">
                        <span class="score-label">${item.emotion}:</span>
                        <span class="score-value">${item.score.toFixed(1)}%</span>
                    </div>
                `).join('');
            } else {
                // Fallback: show only dominant emotion
                scoresContainer.innerHTML = `
                    <div class="emotion-score-item">
                        <span class="score-label">${emotion}:</span>
                        <span class="score-value">${confidence.toFixed(1)}%</span>
                    </div>
                `;
            }
            $('#imageEmotionDetails').style.display = 'block';
        }

        // Disagree button
        const imgFbRow = $('#imageFeedbackRow');
        if (imgFbRow && window.Feedback) {
            imgFbRow.style.display = 'block';
            imgFbRow.innerHTML = '';
            imgFbRow.appendChild(window.Feedback.createDisagreeButton({
                modality: 'image',
                predicted_label: data.emotion || 'unknown',
                predicted_confidence: data.confidence || null,
            }));
        }

        console.log('✅ Image results displayed successfully');
    }

    function showImageError(message) {
        const errorEl = $('#imageErrorMessage');
        if (errorEl) {
            errorEl.textContent = message;
            errorEl.style.display = 'block';
        } else {
            alert(message);
        }
    }

    function setupEvents() {
        // Video events
        $('#startVideoBtn')?.addEventListener('click', startVideoRecording);
        $('#zoomAnalysisBtn')?.addEventListener('click', startZoomAnalysis);
        $('#stopVideoBtn')?.addEventListener('click', stopVideoRecording);
        $('#pauseVideoBtn')?.addEventListener('click', pauseVideoRecording);
        $('#cameraSelect')?.addEventListener('change', handleCameraChange);
        $('#cameraFacing')?.addEventListener('change', handleCameraChange);
        $('#exportSessionBtn')?.addEventListener('click', exportSessionCSV);
        
        // Audio events
        $('#startAudioBtn')?.addEventListener('click', startAudioRecording);
        $('#stopAudioBtn')?.addEventListener('click', stopAudioRecording);
        $('#uploadAudioBtn')?.addEventListener('click', () => {
            // Get file from input when button is clicked
            const fileInput = $('#audioFileInput');
            if (fileInput?.files && fileInput.files[0]) {
                console.log('Upload button clicked, file from input:', fileInput.files[0]);
                uploadAudioForAnalysis(fileInput.files[0]);
            } else {
                alert('Please select an audio file first');
            }
        });
        $('#audioModeRecord')?.addEventListener('click', () => switchAudioMode('record'));
        $('#audioModeUpload')?.addEventListener('click', () => switchAudioMode('upload'));
        $('#audioUploadArea')?.addEventListener('click', () => $('#audioFileInput')?.click());
        $('#audioFileInput')?.addEventListener('change', handleAudioFileSelect);
        
        // HSEmotion Model Dashboard
        $('#refreshModelStatusBtn')?.addEventListener('click', refreshModelStatus);
        
        // Diagnostics
        $('#diagnosticToggle')?.addEventListener('click', () => {
            const content = $('#diagnosticContent');
            if (content) {
                content.style.display = content.style.display === 'none' ? 'block' : 'none';
            }
        });
        $('#checkBackendBtn')?.addEventListener('click', checkBackend);
        $('#checkCamerasBtn')?.addEventListener('click', checkCameras);
        $('#showMacSetupBtn')?.addEventListener('click', showMacSetup);
    }

    // ============================================
    // CHART INITIALIZATION
    // ============================================
    function initCharts() {
        const chartOptions = {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            plugins: {
                legend: {
                    labels: {
                        color: '#94a3b8',
                        font: { size: 11 }
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(15, 23, 42, 0.9)',
                    titleColor: '#e2e8f0',
                    bodyColor: '#e2e8f0',
                    borderColor: '#334155',
                    borderWidth: 1
                }
            },
            scales: {
                x: {
                    ticks: { color: '#94a3b8', font: { size: 10 } },
                    grid: { color: 'rgba(255, 255, 255, 0.05)' }
                },
                y: {
                    ticks: { color: '#94a3b8', font: { size: 10 } },
                    grid: { color: 'rgba(255, 255, 255, 0.05)' }
                }
            }
        };

        // Emotion Confidence Timeline
        const emotionCtx = $('#emotionChart')?.getContext('2d');
        if (emotionCtx) {
            emotionChart = new Chart(emotionCtx, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [{
                        label: 'Confidence',
                        data: [],
                        borderColor: '#3b82f6',
                        backgroundColor: 'rgba(59, 130, 246, 0.1)',
                        tension: 0.4,
                        fill: true
                    }]
                },
                options: {
                    ...chartOptions,
                    plugins: {
                        ...chartOptions.plugins,
                        title: { display: false }
                    }
                }
            });
        }

        // Current Emotion Distribution (Stacked Histogram - like Visage Technologies)
        const barsCtx = $('#emotionBars')?.getContext('2d');
        if (barsCtx) {
            emotionBars = new Chart(barsCtx, {
                type: 'bar',
                data: {
                    labels: ['Current Frame'],
                    datasets: [
                        {
                            label: 'Happiness',
                            data: [0],
                            backgroundColor: 'rgba(16, 185, 129, 0.8)',
                            stack: 'emotions'
                        },
                        {
                            label: 'Sadness',
                            data: [0],
                            backgroundColor: 'rgba(59, 130, 246, 0.8)',
                            stack: 'emotions'
                        },
                        {
                            label: 'Anger',
                            data: [0],
                            backgroundColor: 'rgba(239, 68, 68, 0.8)',
                            stack: 'emotions'
                        },
                        {
                            label: 'Fear',
                            data: [0],
                            backgroundColor: 'rgba(245, 158, 11, 0.8)',
                            stack: 'emotions'
                        },
                        {
                            label: 'Surprise',
                            data: [0],
                            backgroundColor: 'rgba(249, 115, 22, 0.8)',
                            stack: 'emotions'
                        },
                        {
                            label: 'Disgust',
                            data: [0],
                            backgroundColor: 'rgba(132, 204, 22, 0.8)',
                            stack: 'emotions'
                        },
                        {
                            label: 'Neutral',
                            data: [0],
                            backgroundColor: 'rgba(148, 163, 184, 0.8)',
                            stack: 'emotions'
                        }
                    ]
                },
                options: {
                    ...chartOptions,
                    indexAxis: 'y',
                    scales: {
                        ...chartOptions.scales,
                        x: {
                            ...chartOptions.scales.x,
                            stacked: true,
                            max: 100,
                            ticks: {
                                ...chartOptions.scales.x.ticks,
                                callback: function(value) {
                                    return value + '%';
                                }
                            }
                        },
                        y: {
                            ...chartOptions.scales.y,
                            stacked: true
                        }
                    },
                    plugins: {
                        ...chartOptions.plugins,
                        legend: {
                            display: true,
                            position: 'right',
                            labels: {
                                color: '#94a3b8',
                                font: { size: 10 },
                                usePointStyle: true,
                                padding: 8
                            }
                        },
                        tooltip: {
                            ...chartOptions.plugins.tooltip,
                            callbacks: {
                                label: function(context) {
                                    const label = context.dataset.label || '';
                                    const value = context.parsed.x || 0;
                                    return `${label}: ${value.toFixed(1)}%`;
                                },
                                footer: function(tooltipItems) {
                                    const total = tooltipItems.reduce((sum, item) => sum + (item.parsed.x || 0), 0);
                                    return `Total: ${total.toFixed(1)}%`;
                                }
                            }
                        }
                    }
                }
            });
        }

        // Multi-Series Emotion Timeline
        const multiCtx = $('#emotionMultiChart')?.getContext('2d');
        if (multiCtx) {
            emotionMultiChart = new Chart(multiCtx, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [
                        { label: 'Happiness', data: [], borderColor: '#10b981', tension: 0.4 },
                        { label: 'Sadness', data: [], borderColor: '#3b82f6', tension: 0.4 },
                        { label: 'Anger', data: [], borderColor: '#ef4444', tension: 0.4 },
                        { label: 'Fear', data: [], borderColor: '#f59e0b', tension: 0.4 },
                        { label: 'Surprise', data: [], borderColor: '#f97316', tension: 0.4 },
                        { label: 'Disgust', data: [], borderColor: '#84cc16', tension: 0.4 },
                        { label: 'Neutral', data: [], borderColor: '#94a3b8', tension: 0.4 }
                    ]
                },
                options: chartOptions
            });
        }


        // Emotion Pie Chart
        const pieCtx = $('#emotionPie')?.getContext('2d');
        if (pieCtx) {
            emotionPie = new Chart(pieCtx, {
                type: 'doughnut',
                data: {
                    labels: [],
                    datasets: [{
                        data: [],
                        backgroundColor: [
                            '#10b981', '#3b82f6', '#ef4444', '#f59e0b',
                            '#f97316', '#84cc16', '#94a3b8'
                        ]
                    }]
                },
                options: {
                    ...chartOptions,
                    plugins: {
                        ...chartOptions.plugins,
                        legend: { position: 'right' }
                    }
                }
            });
        }

        // Initialize AU Analytics Charts
        initAUAnalyticsCharts();
    }

    function initAUAnalyticsCharts() {
        const chartOptions = {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            plugins: {
                legend: {
                    labels: { color: '#94a3b8', font: { size: 10 } }
                }
            },
            scales: {
                x: { ticks: { color: '#94a3b8', font: { size: 9 } } },
                y: { ticks: { color: '#94a3b8', font: { size: 9 } } }
            }
        };

        // AU Time Series
        const tsCtx = $('#auTimeSeriesChart')?.getContext('2d');
        if (tsCtx) {
            auTimeSeriesChart = new Chart(tsCtx, {
                type: 'line',
                data: { labels: [], datasets: [] },
                options: chartOptions
            });
        }

        // AU Distribution
        const distCtx = $('#auDistributionChart')?.getContext('2d');
        if (distCtx) {
            auDistributionChart = new Chart(distCtx, {
                type: 'pie',
                data: { labels: [], datasets: [{ data: [] }] },
                options: chartOptions
            });
        }

        // Top AUs
        const topCtx = $('#auTopChart')?.getContext('2d');
        if (topCtx) {
            auTopChart = new Chart(topCtx, {
                type: 'bar',
                data: { labels: [], datasets: [{ data: [] }] },
                options: { ...chartOptions, indexAxis: 'y' }
            });
        }

        // AU Correlation (Heatmap placeholder - will use canvas)
        // auCorrelationChart handled by custom canvas rendering

        // POV vs Room dual-line chart
        initRoomComparisonChart();
    }

    // ============================================
    // ROOM INTELLIGENCE — chart + UI functions
    // ============================================

    function initRoomComparisonChart() {
        const ctx = $('#roomComparisonChart')?.getContext('2d');
        if (!ctx) return;

        roomComparisonChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [
                    {
                        label: 'You (POV)',
                        data: [],
                        borderColor: '#3b82f6',
                        backgroundColor: 'rgba(59,130,246,0.08)',
                        borderWidth: 2,
                        tension: 0.4,
                        fill: true,
                        pointRadius: 0,
                    },
                    {
                        label: 'Room Avg',
                        data: [],
                        borderColor: '#10b981',
                        backgroundColor: 'rgba(16,185,129,0.06)',
                        borderWidth: 2,
                        tension: 0.4,
                        fill: true,
                        pointRadius: 0,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                interaction: { intersect: false, mode: 'index' },
                plugins: {
                    legend: {
                        labels: { color: '#94a3b8', font: { size: 11 }, boxWidth: 12 }
                    },
                    tooltip: { enabled: true },
                },
                scales: {
                    x: {
                        ticks: { color: '#475569', font: { size: 10 }, maxTicksLimit: 6 },
                        grid:  { color: 'rgba(255,255,255,0.04)' },
                    },
                    y: {
                        min: 0, max: 1,
                        ticks: {
                            color: '#475569', font: { size: 10 },
                            callback: v => (v * 100).toFixed(0) + '%',
                        },
                        grid: { color: 'rgba(255,255,255,0.04)' },
                    },
                },
            },
        });
    }

    const RING_CIRCUMFERENCE = 263.9; // 2π × r(42)
    let _spikeCornerTimer = null;     // auto-hide timer for the corner alert

    /**
     * Update the SVG harmony ring and the text values.
     * @param {object} room - result from calculate_weighted_room_state()
     */
    function updateHarmonyMeter(room) {
        const pct   = room.harmony_pct  ?? 0;
        const label = room.harmony_label ?? '--';

        const pctEl   = $('#harmonyPctVal');
        const labelEl = $('#harmonyStateLabel');
        const ringEl  = $('#harmonyRingFill');
        const badgeEl = $('#riSessionBadge');
        const partEl  = $('#riParticipantsRow');

        if (pctEl)   pctEl.textContent   = Math.round(pct);
        if (labelEl) labelEl.textContent = label;

        if (ringEl) {
            const arc = (pct / 100) * RING_CIRCUMFERENCE;
            ringEl.style.strokeDasharray = `${arc} ${RING_CIRCUMFERENCE}`;
            // SVG elements return SVGAnimatedString for .className (read-only setter)
            // Must use setAttribute instead.
            ringEl.setAttribute('class', 'ring-fill ' + (
                pct >= 80 ? 'harmony-high' :
                pct >= 50 ? 'harmony-mid'  :
                            'harmony-low'
            ));
        }

        if (partEl) {
            const total = room.participant_count ?? 1;
            const room_ = room.room_participant_count ?? 0;
            partEl.textContent = `${total} participant${total !== 1 ? 's' : ''} · ${room_} in room`;
        }

        if (badgeEl && room.pov_present) {
            badgeEl.textContent = room.pov_present ? 'POV active' : 'Waiting for POV…';
        }
    }

    /**
     * Update the guidance text with a subtle fade animation on change.
     * @param {string} prompt - sentence from insight_generator
     */
    function updateGuidanceBox(prompt) {
        const box  = $('#guidanceBox');
        const text = $('#guidanceText');
        if (!text) return;

        if (!prompt) {
            text.textContent = 'Start recording with multiple participants to receive real-time social guidance.';
            return;
        }

        if (text.textContent === prompt) return; // no change — skip animation

        text.textContent = prompt;
        if (box) {
            box.classList.remove('guidance-updated');
            // Force reflow so the animation restarts cleanly
            void box.offsetWidth;
            box.classList.add('guidance-updated');
        }
    }

    /**
     * Show or hide the spike alert indicators.
     * @param {object|null} spike  - spike payload from server (or null)
     * @param {object}      room   - full room state
     */
    function updateSpikeAlert(spike, room) {
        const inlineEl   = $('#spikeInlineAlert');
        const inlineText = $('#spikeInlineText');
        const cornerEl   = $('#spikeCornerAlert');
        const cornerEmo  = $('#spikeCornerEmotion');

        // Also check room active_spikes for non-POV spikes
        const roomSpikes = (room.active_spikes || []).filter(s => !s.is_pov);
        const hasSpikeActivity = spike !== null || roomSpikes.length > 0;

        const topSpike = spike || (roomSpikes[0] ? roomSpikes[0] : null);
        const emotionLabel = topSpike?.peak_emotion ?? '';

        if (hasSpikeActivity) {
            // Inline alert (inside panel)
            if (inlineText) inlineText.textContent =
                emotionLabel ? `${capitalize(emotionLabel)} detected in room` : 'Room Intensity Increasing';
            if (inlineEl)  inlineEl.classList.add('visible');

            // Corner alert
            if (cornerEmo) cornerEmo.textContent = emotionLabel ? capitalize(emotionLabel) : '';
            if (cornerEl) {
                cornerEl.classList.remove('hiding');
                cornerEl.classList.add('visible');
            }

            // Auto-hide corner alert after 4 s
            if (_spikeCornerTimer) clearTimeout(_spikeCornerTimer);
            _spikeCornerTimer = setTimeout(() => {
                if (cornerEl) {
                    cornerEl.classList.add('hiding');
                    setTimeout(() => {
                        cornerEl.classList.remove('visible', 'hiding');
                    }, 320);
                }
                if (inlineEl) inlineEl.classList.remove('visible');
            }, 4000);

        } else {
            // No spike — clear inline; corner auto-hides via timer
            if (inlineEl) inlineEl.classList.remove('visible');
        }
    }

    /**
     * Push one data point to the POV-vs-Room dual-line chart.
     * Keeps a rolling window of 60 points.
     * @param {number} povConfidence  - POV dominant emotion score (0–1)
     * @param {object} room           - room state dict
     * @param {number} t              - session time in seconds (for label)
     */
    function pushRoomComparisonPoint(povConfidence, room, t) {
        if (!roomComparisonChart) return;

        const WINDOW = 60;
        const roomMax = room.room_state
            ? Math.max(...Object.values(room.room_state))
            : 0;

        const labels   = roomComparisonChart.data.labels;
        const povData  = roomComparisonChart.data.datasets[0].data;
        const roomData = roomComparisonChart.data.datasets[1].data;

        labels.push(t + 's');
        povData.push(+(povConfidence).toFixed(3));
        roomData.push(+(roomMax).toFixed(3));

        if (labels.length > WINDOW) {
            labels.shift();
            povData.shift();
            roomData.shift();
        }

        roomComparisonChart.update('none');
    }

    function capitalize(s) {
        return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
    }

    // ------------------------------------------------------------------ //
    // Participant label helper
    // face_index 0 = POV when is_pov is true, otherwise Guest N
    // ------------------------------------------------------------------ //
    function participantLabel(faceIndex, isPov) {
        if (isPov) return 'You (POV)';
        return `Guest ${faceIndex}`; // face_1 → Guest 1, face_2 → Guest 2 …
    }

    // ------------------------------------------------------------------ //
    // Participant Roster — live table under Room Intelligence
    // ------------------------------------------------------------------ //
    function updateParticipantRoster(faces) {
        const empty      = $('#rosterEmpty');
        const tableWrap  = $('#rosterTableWrap');
        const tbody      = $('#rosterBody');
        const countBadge = $('#rosterFaceCount');
        const exportBtn  = $('#exportSessionBtn');

        if (!faces || faces.length === 0) {
            if (empty)  empty.style.display  = 'block';
            if (tableWrap) tableWrap.style.display  = 'none';
            if (countBadge) countBadge.textContent = '0 faces';
            return;
        }

        if (empty) empty.style.display  = 'none';
        if (tableWrap) tableWrap.style.display  = 'block';
        if (countBadge) countBadge.textContent = `${faces.length} face${faces.length !== 1 ? 's' : ''}`;
        if (exportBtn)  exportBtn.disabled = false;

        if (!tbody) return;
        tbody.innerHTML = '';

        const colors = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899'];

        faces.forEach((face, i) => {
            const color   = colors[i % colors.length];
            const label   = participantLabel(face.face_index, face.is_pov);
            const emotion = capitalize(face.emotion || 'neutral');
            const conf    = ((face.confidence || 0) * 100).toFixed(0);
            const role    = face.is_pov
                ? '<span class="roster-role-pov">★ POV</span>'
                : '<span class="roster-role-guest">Guest</span>';
            const spike   = face._spiking
                ? '<span class="roster-spike-dot" title="Emotional spike detected"></span>'
                : '—';

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><span class="roster-dot" style="background:${color}"></span></td>
                <td>${label}</td>
                <td><span class="roster-emotion-badge">${emotion}</span></td>
                <td>${conf}%</td>
                <td>${role}</td>
                <td>${spike}</td>
            `;
            tbody.appendChild(tr);
        });
    }

    // ------------------------------------------------------------------ //
    // Session Export — download timeline as CSV
    // ------------------------------------------------------------------ //
    function exportSessionCSV() {
        if (!videoState.timeline || videoState.timeline.length === 0) {
            alert('No session data to export yet. Start a recording first.');
            return;
        }

        const rows = [
            ['Time (s)', 'Emotion', 'Confidence', 'Happiness', 'Sadness',
             'Anger', 'Fear', 'Surprise', 'Disgust', 'Neutral', 'Contempt']
        ];

        videoState.timeline.forEach(entry => {
            const s = entry.scores || {};
            rows.push([
                entry.t,
                entry.label,
                (entry.confidence * 100).toFixed(1),
                ((s.happiness  || 0) * 100).toFixed(1),
                ((s.sadness    || 0) * 100).toFixed(1),
                ((s.anger      || 0) * 100).toFixed(1),
                ((s.fear       || 0) * 100).toFixed(1),
                ((s.surprise   || 0) * 100).toFixed(1),
                ((s.disgust    || 0) * 100).toFixed(1),
                ((s.neutral    || 0) * 100).toFixed(1),
                ((s.contempt   || 0) * 100).toFixed(1),
            ]);
        });

        const csv  = rows.map(r => r.join(',')).join('\n');
        const blob = new Blob([csv], { type: 'text/csv' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `emotion-session-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }

    // ============================================
    // VIDEO FUNCTIONS
    // ============================================
    // ------------------------------------------------------------------ //
    // Zoom / Screen-share Analysis
    // ------------------------------------------------------------------ //

    /**
     * Prompt the user to select a screen / window (expected: their Zoom window).
     * Replaces the webcam feed with the captured display stream and starts
     * the same frame-analysis loop used for the webcam.
     *
     * Behaviour on error / cancel:
     *   - If the user cancels the picker (NotAllowedError / AbortError) the
     *     function silently offers to fall back to the webcam.
     *   - Any other error is shown as an alert so the user knows what went wrong.
     */
    async function startZoomAnalysis() {
        // Prevent double-start
        if (videoState.isRecording) {
            console.warn('Already recording — stop current session first.');
            return;
        }

        let screenStream;
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    frameRate: { ideal: 10, max: 15 }, // low FPS is fine for emotion analysis
                    displaySurface: 'window',          // hint: prefer a window over full screen
                },
                audio: false,
            });
        } catch (err) {
            const cancelled = err.name === 'NotAllowedError' || err.name === 'AbortError';
            if (cancelled) {
                // User pressed Cancel — offer webcam fallback
                const useFallback = window.confirm(
                    'Screen share was cancelled.\n\nWould you like to fall back to your webcam instead?'
                );
                if (useFallback) await startVideoRecording();
            } else {
                alert(`Screen capture failed: ${err.message}`);
                console.error('getDisplayMedia error:', err);
            }
            return;
        }

        // Attach stream to the same <video> element the webcam uses
        const video = $('#videoStream');
        if (video) {
            video.srcObject = screenStream;
            video.style.display = 'block';
            $('#videoPlaceholder')?.classList.add('hidden');

            video.addEventListener('loadedmetadata', () => {
                const canvas = $('#videoCanvas');
                if (canvas) {
                    canvas.width  = video.videoWidth;
                    canvas.height = video.videoHeight;
                }
            }, { once: true });
        }

        // When the user stops sharing via the browser's native "Stop sharing" button
        // treat it the same as pressing our Stop button.
        screenStream.getVideoTracks()[0].addEventListener('ended', () => {
            console.log('📺 Screen share ended by user');
            stopVideoRecording();
        });

        videoState.stream        = screenStream;
        videoState.videoSource   = 'screen';
        videoState.useBrowserWebcam = true; // reuse the same captureAndAnalyzeFrame path

        // Mark session metadata
        videoState.isRecording = true;
        videoState.startTs     = Date.now();
        videoState.sessionCount++;

        if (videoState.resumeFromStorage) {
            videoState.resumeFromStorage = false;
            $('#sessionRestoreBanner')?.remove();
        } else {
            videoState.activeSessionId = createSessionId();
            videoState.timeline       = [];
            videoState.emotionHistory = [];
            videoState.auHistory      = [];
            clearSessionStorage();
        }

        // Connect WebSocket (is_pov flag comes from the checkbox)
        try {
            await connectVideoWebSocket();
            console.log('✅ WebSocket connected for Zoom screen analysis');
        } catch (wsErr) {
            console.warn('⚠️ WebSocket failed, using HTTP fallback:', wsErr);
        }

        // Update UI
        _setVideoUIActive('screen');

        // Start frame capture loop (identical to webcam path)
        const frameInterval = parseInt($('#frameInterval')?.value || 200);
        videoState.pollId = setInterval(captureAndAnalyzeFrame, frameInterval);

        // Canvas refresh loop
        videoState.canvasUpdateId = setInterval(updateVideoCanvas, 33);

        // Timer
        videoState.timerId = setInterval(() => {
            videoState.duration = Math.floor((Date.now() - videoState.startTs) / 1000);
            $('#videoTimer').textContent = fmtTime(videoState.duration);
            const progress = Math.min((videoState.duration / 300) * 100, 100);
            $('#videoProgress').style.width = `${progress}%`;
        }, 1000);

        // AU analytics reset
        auAnalytics.startTime   = Date.now();
        auAnalytics.history     = [];
        auAnalytics.stats       = {};
        auAnalytics.totalFrames = 0;
    }

    /** Shared helper: update all video-tab UI elements for the active source. */
    function _setVideoUIActive(source /* 'webcam' | 'screen' */) {
        $('#startVideoBtn').style.display    = 'none';
        $('#zoomAnalysisBtn').style.display  = 'none';
        $('#stopVideoBtn').style.display     = 'inline-flex';
        $('#pauseVideoBtn').style.display    = 'inline-flex';

        const indicator = $('#sourceIndicator');
        const label     = $('#sourceLabel');
        if (source === 'screen') {
            if (indicator) indicator.classList.add('active');
            if (label)     label.textContent = 'Analyzing Screen: Zoom';
            $('#videoStatus').textContent = 'Video: Screen';
            $('#videoStatus').className   = 'badge badge-live';
        } else {
            if (indicator) indicator.classList.remove('active');
            $('#videoStatus').textContent = 'Video: Recording';
            $('#videoStatus').className   = 'badge badge-live';
        }
        $('#sessionCount').textContent = `Session: ${videoState.sessionCount}`;
    }

    async function startVideoRecording() {
        try {
            videoState.useBrowserWebcam = $('#cameraSelect')?.value === 'browser';
            videoState.videoSource      = 'webcam';
            
            if (videoState.useBrowserWebcam) {
                await startBrowserWebcam();
            }
            
            videoState.isRecording = true;
            videoState.startTs = Date.now();
            videoState.sessionCount++;

            if (videoState.resumeFromStorage) {
                videoState.resumeFromStorage = false;
                $('#sessionRestoreBanner')?.remove();
            } else {
                videoState.activeSessionId = createSessionId();
                videoState.timeline = [];
                videoState.emotionHistory = [];
                videoState.auHistory = [];
                clearSessionStorage();
            }
            
            // Connect WebSocket for real-time analysis (better for Render)
            try {
                await connectVideoWebSocket();
                console.log('✅ WebSocket connected, starting frame capture');
            } catch (error) {
                console.warn('⚠️ WebSocket connection failed, using HTTP fallback:', error);
                // Continue with HTTP fallback
            }
            
            // Update UI
            _setVideoUIActive('webcam');
            
            // Start polling (faster for real-time updates)
            const frameInterval = parseInt($('#frameInterval')?.value || 200);
            videoState.pollId = setInterval(() => {
                if (videoState.useBrowserWebcam) {
                    captureAndAnalyzeFrame();
                } else {
                    updateVideoTelemetry();
                }
            }, frameInterval);
            
            // Also start continuous canvas update loop for smooth video display
            videoState.canvasUpdateId = setInterval(() => {
                updateVideoCanvas();
            }, 33); // ~30 FPS for smooth video display
            
            // Start timer
            videoState.timerId = setInterval(() => {
                videoState.duration = Math.floor((Date.now() - videoState.startTs) / 1000);
                $('#videoTimer').textContent = fmtTime(videoState.duration);
                const progress = Math.min((videoState.duration / 300) * 100, 100); // Max 5 min
                $('#videoProgress').style.width = `${progress}%`;
            }, 1000);
            
            // Initialize AU Analytics
            auAnalytics.startTime = Date.now();
            auAnalytics.history = [];
            auAnalytics.stats = {};
            auAnalytics.totalFrames = 0;
            
        } catch (error) {
            console.error('Error starting video recording:', error);
            alert(`Failed to start recording: ${error.message}`);
        }
    }

    function stopVideoRecording() {
        videoState.isRecording = false;

        // Stop polling
        if (videoState.pollId) {
            clearInterval(videoState.pollId);
            videoState.pollId = null;
        }

        // Stop timer
        if (videoState.timerId) {
            clearInterval(videoState.timerId);
            videoState.timerId = null;
        }

        // Stop canvas update loop
        if (videoState.canvasUpdateId) {
            clearInterval(videoState.canvasUpdateId);
            videoState.canvasUpdateId = null;
        }

        // Close WebSocket connection
        if (videoState.ws) {
            if (videoState.ws.readyState === WebSocket.OPEN) {
                videoState.ws.send(JSON.stringify({ type: 'stop' }));
            }
            videoState.ws.close();
            videoState.ws = null;
            console.log('🔌 WebSocket closed');
        }

        // Stop all media tracks (works for both webcam and screen-share streams)
        if (videoState.stream) {
            videoState.stream.getTracks().forEach(t => t.stop());
            videoState.stream = null;
        }
        // Legacy path: also call stopBrowserWebcam to clear the video element
        if (videoState.useBrowserWebcam) {
            stopBrowserWebcam();
        }

        // Reset source state
        videoState.videoSource = 'webcam';

        // Update UI — restore both start buttons, hide source indicator
        $('#startVideoBtn').style.display   = 'inline-flex';
        $('#zoomAnalysisBtn').style.display = 'inline-flex';
        $('#stopVideoBtn').style.display    = 'none';
        $('#pauseVideoBtn').style.display   = 'none';
        $('#sourceIndicator')?.classList.remove('active');
        $('#videoStatus').textContent = 'Video: Idle';
        $('#videoStatus').className   = 'badge badge-idle';

        clearSessionStorage();
        videoState.activeSessionId = null;
        videoState.resumeFromStorage = false;

        // Generate session summary
        generateSessionSummary();

        // Refresh session history panel (new sessions may have been created)
        if (window.SessionHistory) window.SessionHistory.refresh();
    }

    function pauseVideoRecording() {
        if (videoState.pollId) {
            clearInterval(videoState.pollId);
            videoState.pollId = null;
            $('#pauseVideoBtn').textContent = 'Resume';
        } else {
            videoState.pollId = setInterval(() => {
                if (videoState.useBrowserWebcam) {
                    captureAndAnalyzeFrame();
                } else {
                    updateVideoTelemetry();
                }
            }, parseInt($('#frameInterval')?.value || 200));
            $('#pauseVideoBtn').textContent = 'Pause';
        }
    }

    function isMobileDevice() {
        return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
            || (navigator.maxTouchPoints > 1 && window.innerWidth < 1024);
    }

    function buildVideoConstraints() {
        const facing = $('#cameraFacing')?.value || 'user';
        const selectVal = $('#cameraSelect')?.value || 'browser';
        videoState.facingMode = facing;

        const video = {
            width:  { ideal: isMobileDevice() ? 1280 : 640 },
            height: { ideal: isMobileDevice() ? 720 : 480 },
            facingMode: { ideal: facing },
        };

        if (selectVal.startsWith('device:')) {
            const deviceId = selectVal.slice('device:'.length);
            if (deviceId) {
                videoState.selectedDeviceId = deviceId;
                delete video.facingMode;
                return { video: { ...video, deviceId: { exact: deviceId } } };
            }
        }

        videoState.selectedDeviceId = null;
        return { video };
    }

    async function startBrowserWebcam() {
        try {
            let stream = null;
            const constraints = buildVideoConstraints();

            try {
                stream = await navigator.mediaDevices.getUserMedia(constraints);
            } catch (firstErr) {
                const facing = videoState.facingMode || 'user';
                console.warn('Camera constraints failed, retrying:', firstErr.message);
                stream = await navigator.mediaDevices.getUserMedia({
                    video: {
                        facingMode: facing === 'environment'
                            ? { exact: 'environment' }
                            : { ideal: 'user' },
                        width:  { ideal: 640 },
                        height: { ideal: 480 },
                    },
                });
            }

            const video = $('#videoStream');
            if (video) {
                video.srcObject = stream;
                video.setAttribute('playsinline', 'true');
                video.setAttribute('webkit-playsinline', 'true');
                video.muted = true;
                video.style.display = 'block';
                $('#videoPlaceholder')?.classList.add('hidden');

                video.addEventListener('loadedmetadata', () => {
                    const canvas = $('#videoCanvas');
                    if (canvas) {
                        canvas.width = video.videoWidth;
                        canvas.height = video.videoHeight;
                    }
                    console.log(
                        `📷 Camera active: ${video.videoWidth}x${video.videoHeight} ` +
                        `facing=${videoState.facingMode}`
                    );
                }, { once: true });
            }

            videoState.stream = stream;
        } catch (error) {
            const hint = videoState.facingMode === 'environment'
                ? ' Allow rear-camera permission or switch Lens to Front (Selfie).'
                : '';
            throw new Error(`Camera access failed: ${error.message}.${hint}`);
        }
    }

    function stopBrowserWebcam() {
        if (videoState.stream) {
            videoState.stream.getTracks().forEach(track => track.stop());
            videoState.stream = null;
        }
        
        const video = $('#videoStream');
        if (video) {
            video.srcObject = null;
            video.style.display = 'none';
            $('#videoPlaceholder')?.classList.remove('hidden');
        }
    }

    async function connectVideoWebSocket() {
        return new Promise((resolve, reject) => {
            // Use WSS for HTTPS (Render), WS for HTTP (local)
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const isPov = $('#isPovCheckbox')?.checked ?? true;
            if (!videoState.activeSessionId) {
                videoState.activeSessionId = createSessionId();
            }
            const userId = encodeURIComponent(getOrCreateUserId());
            const sessionId = encodeURIComponent(videoState.activeSessionId);
            const wsUrl = `${protocol}//${window.location.host}/video/emotion?is_pov=${isPov}&session_id=${sessionId}&user_id=${userId}`;
            
            console.log('🔌 Connecting WebSocket to:', wsUrl);
            
            const connectionTimeout = setTimeout(() => {
                if (videoState.ws && videoState.ws.readyState === WebSocket.CONNECTING) {
                    console.error('❌ WebSocket connection timeout');
                    videoState.ws.close();
                    reject(new Error('WebSocket connection timeout'));
                }
            }, 10000);
            
            videoState.ws = new WebSocket(wsUrl);
            
            videoState.ws.onopen = () => {
                console.log('✅ WebSocket connected successfully');
                clearTimeout(connectionTimeout);
                resolve();
            };
            
            videoState.ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    
                    // Handle ping/pong for keepalive
                    if (data.type === 'ping') {
                        if (videoState.ws && videoState.ws.readyState === WebSocket.OPEN) {
                            videoState.ws.send(JSON.stringify({ type: 'pong' }));
                        }
                        return;
                    }
                    
                    // Handle emotion updates
                    if (data.type === 'emotion') {
                        const video = $('#videoStream');
                        const videoWidth = video?.videoWidth || 640;
                        const videoHeight = video?.videoHeight || 480;
                        handleVideoResult(data, videoWidth, videoHeight);
                    }
                } catch (error) {
                    console.error('❌ Failed to parse WebSocket message:', error);
                }
            };
            
            videoState.ws.onerror = (error) => {
                console.error('❌ WebSocket error:', error);
                clearTimeout(connectionTimeout);
                reject(error);
            };
            
            videoState.ws.onclose = () => {
                console.log('🔌 WebSocket closed');
                // Try to reconnect if still recording
                if (videoState.isRecording) {
                    setTimeout(() => {
                        if (videoState.isRecording) {
                            connectVideoWebSocket().catch(err => {
                                console.error('❌ WebSocket reconnection failed:', err);
                            });
                        }
                    }, 2000);
                }
            };
        });
    }

    // Colour palette for multi-face bounding boxes (cycles if > 6 faces)
    const FACE_BOX_COLORS = [
        '#3b82f6', // blue   — face_0 (POV)
        '#10b981', // green  — face_1
        '#f59e0b', // amber  — face_2
        '#ef4444', // red    — face_3
        '#8b5cf6', // violet — face_4
        '#ec4899', // pink   — face_5
    ];

    // Continuous canvas update for smooth video display
    function updateVideoCanvas() {
        const video = $('#videoStream');
        const videoCanvas = $('#videoCanvas');
        const videoCtx = videoCanvas?.getContext('2d');

        if (!video || video.readyState !== video.HAVE_ENOUGH_DATA || !videoCanvas || !videoCtx) return;

        const videoWidth  = video.videoWidth  || 640;
        const videoHeight = video.videoHeight || 480;

        if (videoCanvas.width !== videoWidth || videoCanvas.height !== videoHeight) {
            videoCanvas.width  = videoWidth;
            videoCanvas.height = videoHeight;
        }

        videoCtx.drawImage(video, 0, 0, videoWidth, videoHeight);

        // Draw all detected faces (multi-face support)
        if (videoState.lastFaces && videoState.lastFaces.length > 0) {
            // Scale bboxes from the capture resolution back to the display resolution.
            // captureW/H are set per-frame in captureAndAnalyzeFrame() to match the
            // video's true aspect ratio, so these factors are always correct.
            const scaleX = videoWidth  / (videoState.captureW || 320);
            const scaleY = videoHeight / (videoState.captureH || 240);

            videoState.lastFaces.forEach((face, i) => {
                const { bbox, emotion, confidence, is_pov } = face;
                if (!bbox || bbox.length < 4) return;

                const [x1, y1, x2, y2] = bbox;
                const sx = x1 * scaleX;
                const sy = y1 * scaleY;
                const sw = (x2 - x1) * scaleX;
                const sh = (y2 - y1) * scaleY;

                const color = FACE_BOX_COLORS[i % FACE_BOX_COLORS.length];

                // Bounding box
                videoCtx.strokeStyle = color;
                videoCtx.lineWidth = is_pov ? 4 : 2;
                videoCtx.strokeRect(sx, sy, sw, sh);

                // Human-readable participant label
                const nameTag   = is_pov ? 'You (POV)' : `Guest ${i}`;
                const label = `${nameTag}: ${emotion} ${confidence}%`;
                videoCtx.font = 'bold 13px Arial';
                const textW = videoCtx.measureText(label).width + 10;
                const labelY = Math.max(sy - 22, 4);
                videoCtx.fillStyle = color;
                videoCtx.beginPath();
                videoCtx.roundRect
                    ? videoCtx.roundRect(sx, labelY, textW, 20, 4)
                    : videoCtx.rect(sx, labelY, textW, 20);
                videoCtx.fill();

                // Label text
                videoCtx.fillStyle = '#ffffff';
                videoCtx.fillText(label, sx + 5, labelY + 14);
            });
        } else if (videoState.lastBbox) {
            // Legacy single-face fallback
            const { bbox, emotion, confidence } = videoState.lastBbox;
            if (bbox && Array.isArray(bbox) && bbox.length >= 4) {
                const scaleX = videoWidth  / (videoState.captureW || 320);
                const scaleY = videoHeight / (videoState.captureH || 240);
                const [x1, y1, x2, y2] = bbox;
                const sx = x1 * scaleX;
                const sy = y1 * scaleY;
                const sw = (x2 - x1) * scaleX;
                const sh = (y2 - y1) * scaleY;
                videoCtx.strokeStyle = '#3b82f6';
                videoCtx.lineWidth = 3;
                videoCtx.strokeRect(sx, sy, sw, sh);
                videoCtx.fillStyle = '#3b82f6';
                videoCtx.font = 'bold 16px Arial';
                videoCtx.fillText(`${emotion} (${confidence}%)`, sx, Math.max(sy - 5, 20));
            }
        }
    }

    async function captureAndAnalyzeFrame() {
        const video = $('#videoStream');

        if (!video || video.readyState !== video.HAVE_ENOUGH_DATA) return;

        // Preserve aspect ratio. Rear camera: higher res + quality (faces often farther/smaller).
        const isRear = videoState.facingMode === 'environment';
        const CAPTURE_W = isRear ? 480 : 320;
        const JPEG_QUALITY = isRear ? 0.85 : 0.72;
        const srcW = video.videoWidth  || 640;
        const srcH = video.videoHeight || 480;
        const CAPTURE_H = Math.max(1, Math.round(CAPTURE_W * srcH / srcW));

        videoState.captureW = CAPTURE_W;
        videoState.captureH = CAPTURE_H;

        const tempCanvas = document.createElement('canvas');
        const tempCtx    = tempCanvas.getContext('2d');
        tempCanvas.width  = CAPTURE_W;
        tempCanvas.height = CAPTURE_H;
        tempCtx.drawImage(video, 0, 0, CAPTURE_W, CAPTURE_H);

        const imageData = tempCanvas.toDataURL('image/jpeg', JPEG_QUALITY);
        
        // Send frame via WebSocket if connected, otherwise fallback to HTTP POST
        if (videoState.ws && videoState.ws.readyState === WebSocket.OPEN) {
            try {
                videoState.ws.send(JSON.stringify({
                    type: 'frame',
                    image: imageData
                }));
            } catch (error) {
                console.error('❌ WebSocket send error:', error);
                // Fallback to HTTP POST
                const videoWidth = video.videoWidth || 640;
                const videoHeight = video.videoHeight || 480;
                sendFrameViaHTTP(imageData, videoWidth, videoHeight);
            }
        } else {
            // Fallback to HTTP POST if WebSocket not available
            const videoWidth = video.videoWidth || 640;
            const videoHeight = video.videoHeight || 480;
            sendFrameViaHTTP(imageData, videoWidth, videoHeight);
        }
    }

    async function sendFrameViaHTTP(imageData, videoWidth, videoHeight) {
        try {
            const response = await fetch('/video/emotion', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image: imageData })
            });
            
            if (response.ok) {
                const data = await response.json();
                handleVideoResult(data, videoWidth, videoHeight);
            }
        } catch (error) {
            console.error('❌ Frame analysis error:', error);
        }
    }

    async function updateVideoTelemetry() {
        // Polling endpoint for server-side video analysis
        // This would be implemented if backend supports it
        try {
            const response = await fetch('/get_realtime_data');
            if (response.ok) {
                const data = await response.json();
                handleVideoResult(data);
            }
        } catch (error) {
            console.error('Telemetry update error:', error);
        }
    }

    function handleVideoResult(data, videoWidth = null, videoHeight = null) {
        const success     = data.success !== undefined ? data.success : (data.type === 'emotion' && data.face_detected);
        const faceDetected = data.face_detected !== undefined ? data.face_detected : success;

        // ------------------------------------------------------------------ //
        // Multi-face canvas overlay storage
        // ------------------------------------------------------------------ //
        // Prefer the new `faces` array; fall back to the legacy single-face
        // shape so the canvas loop always has something to draw.
        if (data.faces && data.faces.length > 0) {
            videoState.lastFaces = data.faces.map(f => ({
                bbox:       f.face_bbox,
                emotion:    normalizeEmotion(f.emotion),
                confidence: ((f.confidence || 0) * 100).toFixed(0),
                is_pov:     f.is_pov || false,
            }));
            videoState.lastBbox = null; // disable legacy path
        } else if (data.face_bbox && faceDetected) {
            videoState.lastFaces = null;
            videoState.lastBbox  = {
                bbox:       data.face_bbox,
                emotion:    normalizeEmotion(data.emotion),
                confidence: ((data.confidence || 0) * 100).toFixed(0),
            };
        } else {
            videoState.lastFaces = null;
            videoState.lastBbox  = null;
        }

        if (!success || !faceDetected) {
            $('#currentEmotion').textContent    = 'No Face';
            $('#currentConfidence').textContent = '—';
            // Still update room state even when no face is detected
            const room = data.room;
            if (room) {
                updateHarmonyMeter(room);
                updateGuidanceBox(room.social_prompt || '');
                updateSpikeAlert(data.spike || null, room);
            }
            return;
        }

        // ------------------------------------------------------------------ //
        // Primary face (face_0 / POV) drives the legacy stats widgets
        // ------------------------------------------------------------------ //
        const emotions = data.emotions || {};
        const aus      = data.aus || {};

        // Raw frame: backend aligns emotion + confidence (including neutral override).
        const rawEmotionKey   = (data.emotion || 'neutral').toLowerCase();
        const rawConfidence   = Math.max(0, Math.min(1, Number(data.confidence) || 0));
        const rawEmotionLabel = normalizeEmotion(rawEmotionKey);

        // Smoothed: moving average of emotion vectors, then dominant + its score.
        const smoothedEmotions    = applyEmotionSmoothing(emotions);
        const smoothedEmotionKey  = getDominantEmotion(smoothedEmotions);
        const smoothedEmotionLabel = normalizeEmotion(smoothedEmotionKey);
        const smoothedConfidence = Math.max(
            0,
            Math.min(1, Number(smoothedEmotions[smoothedEmotionKey]) || 0)
        );

        // ---- Face count badge ----
        const faceCount = data.face_count || 1;
        $('#currentEmotion').textContent    = formatEmotionCertainty(
            smoothedEmotionLabel,
            smoothedConfidence
        );
        $('#currentConfidence').textContent = formatEmotionCertainty(
            rawEmotionLabel,
            rawConfidence
        );

        // Disagree button — updates every detected emotion change
        const videoFbRow = $('#videoFeedbackRow');
        if (videoFbRow && window.Feedback && smoothedEmotionLabel && smoothedEmotionLabel !== '-') {
            videoFbRow.innerHTML = '';
            videoFbRow.appendChild(window.Feedback.createDisagreeButton({
                modality: 'video',
                predicted_label: smoothedEmotionKey || smoothedEmotionLabel,
                predicted_confidence: smoothedConfidence,
                session_id: videoState.activeSessionId || null,
            }));
        }

        const auCountEl = $('#auCount');
        if (auCountEl) {
            const facesLabel = faceCount > 1 ? ` | ${faceCount} faces` : '';
            auCountEl.textContent = `AUs: ${Object.keys(aus).length}${facesLabel}`;
        }

        // ---- Timeline & history ----
        const timelineEntry = {
            t:          videoState.duration,
            label:      smoothedEmotionKey,
            confidence: smoothedConfidence,
            scores:     smoothedEmotions,
            aus,
        };
        videoState.timeline.push(timelineEntry);
        videoState.emotionHistory.push({
            emotion: smoothedEmotionKey,
            confidence: smoothedConfidence,
            time: videoState.duration,
        });
        videoState.auHistory.push({ aus, time: videoState.duration });

        // ---- Charts ----
        pushChartPoint(smoothedConfidence);
        updateEmotionBars(smoothedEmotions);
        updateEmotionMultiChart(smoothedEmotions);
        updateAUBars(aus);

        if (data.inference_time_ms) updateModelPerformance(data.inference_time_ms);

        trackEmotionChange(smoothedEmotionKey);
        explainEmotion(smoothedEmotionKey, aus);

        // ---- Room Intelligence updates ----
        const room = data.room;
        if (room) {
            videoState.lastRoom = room;
            updateHarmonyMeter(room);
            updateGuidanceBox(room.social_prompt || '');
            updateSpikeAlert(data.spike || null, room);
            pushRoomComparisonPoint(smoothedConfidence, room, videoState.duration);
        }

        if (data.session_id) {
            videoState.activeSessionId = data.session_id;
        }
        schedulePersistSession();

        // ---- Participant Roster ----
        if (data.faces && data.faces.length > 0) {
            // Annotate each face with spike flag from active_spikes list
            const activeSpikes = new Set(
                (room?.active_spikes || []).map(s => s.is_pov ? 'pov' : s.user_id)
            );
            const rosterFaces = data.faces.map(f => ({
                ...f,
                _spiking: data.spike !== null && f.face_index === 0
                          ? true
                          : (room?.active_spikes || []).some(s => !s.is_pov),
            }));
            updateParticipantRoster(rosterFaces);
        } else if (!faceDetected) {
            updateParticipantRoster([]);
        }
    }
    
    // Emotion smoothing for stability (moving average)
    const emotionHistory = [];
    const SMOOTHING_WINDOW = 5; // Number of frames to average
    
    function applyEmotionSmoothing(currentEmotions) {
        emotionHistory.push(currentEmotions);
        if (emotionHistory.length > SMOOTHING_WINDOW) {
            emotionHistory.shift();
        }
        
        // Calculate average across window
        const smoothed = {};
        const emotionKeys = [
            'happiness', 'sadness', 'anger', 'fear', 'surprise',
            'disgust', 'contempt', 'neutral',
        ];
        
        emotionKeys.forEach(key => {
            const sum = emotionHistory.reduce((acc, frame) => acc + (frame[key] || 0), 0);
            smoothed[key] = sum / emotionHistory.length;
        });
        
        return smoothed;
    }
    
    function getDominantEmotion(emotions) {
        return Object.entries(emotions).reduce((a, b) => emotions[a[0]] > emotions[b[0]] ? a : b)[0];
    }

    // ============================================
    // AUDIO FUNCTIONS
    // ============================================
    async function startAudioRecording() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            audioState.stream = stream;
            
            // Setup MediaRecorder
            audioState.mediaRecorder = new MediaRecorder(stream, {
                mimeType: 'audio/webm;codecs=opus'
            });
            
            audioState.audioChunks = [];
            
            audioState.mediaRecorder.ondataavailable = (event) => {
                if (event.data && event.data.size > 0) {
                    audioState.audioChunks.push(event.data);
                }
            };
            
            audioState.mediaRecorder.onstop = () => {
                // Create Blob from audio chunks
                if (audioState.audioChunks && audioState.audioChunks.length > 0) {
                    try {
                        const blob = new Blob(audioState.audioChunks, { type: 'audio/webm' });
                        console.log('Recording stopped, blob created:', blob.size, 'bytes', 'Type:', blob.constructor.name, 'Is Blob:', blob instanceof Blob);
                        
                        // Validate blob before uploading
                        if (blob instanceof Blob && blob.size > 0) {
                            uploadAudioForAnalysis(blob);
                        } else {
                            console.error('Invalid blob created:', blob, typeof blob);
                            alert('Failed to create audio recording. Please try again.');
                        }
                    } catch (error) {
                        console.error('Error creating blob:', error);
                        alert('Failed to process audio recording. Please try again.');
                    }
                } else {
                    console.error('No audio chunks available');
                    alert('No audio recorded. Please try again.');
                }
            };
            
            // Setup Web Audio API for waveform
            audioState.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            audioState.analyser = audioState.audioCtx.createAnalyser();
            audioState.source = audioState.audioCtx.createMediaStreamSource(stream);
            audioState.source.connect(audioState.analyser);
            
            audioState.analyser.fftSize = 256;
            const bufferLength = audioState.analyser.frequencyBinCount;
            const dataArray = new Uint8Array(bufferLength);
            
            function drawWaveform() {
                if (!audioState.isRecording) return;
                
                audioState.analyser.getByteFrequencyData(dataArray);
                const canvas = $('#waveformCanvas');
                if (canvas) {
                    const ctx = canvas.getContext('2d');
                    const width = canvas.width;
                    const height = canvas.height;
                    
                    ctx.fillStyle = '#0b1220';
                    ctx.fillRect(0, 0, width, height);
                    
                    const barWidth = width / bufferLength * 2.5;
                    let x = 0;
                    
                    for (let i = 0; i < bufferLength; i++) {
                        const barHeight = (dataArray[i] / 255) * height;
                        ctx.fillStyle = `rgb(${barHeight}, 59, 130)`;
                        ctx.fillRect(x, height - barHeight, barWidth, barHeight);
                        x += barWidth + 1;
                    }
                }
                
                audioState.rafId = requestAnimationFrame(drawWaveform);
            }
            
            // Start recording
            audioState.mediaRecorder.start();
            audioState.isRecording = true;
            audioState.recordingStartTime = Date.now();
            
            // Update UI
            $('#startAudioBtn').style.display = 'none';
            $('#stopAudioBtn').style.display = 'inline-flex';
            $('#recordingTimer').style.display = 'block';
            $('#audioStatus').textContent = 'Audio: Recording';
            $('#audioStatus').className = 'badge badge-live';
            
            // Start waveform
            drawWaveform();
            
            // Start timer
            const duration = parseInt($('#recordingDuration')?.value || 5);
            const timer = setInterval(() => {
                const elapsed = Math.floor((Date.now() - audioState.recordingStartTime) / 1000);
                $('#recordingTime').textContent = fmtTime(elapsed);
                
                if (elapsed >= duration) {
                    clearInterval(timer);
                    stopAudioRecording();
                }
            }, 1000);
            
        } catch (error) {
            console.error('Error starting audio recording:', error);
            alert(`Microphone access failed: ${error.message}`);
        }
    }

    function stopAudioRecording() {
        if (audioState.mediaRecorder && audioState.isRecording) {
            audioState.mediaRecorder.stop();
            audioState.isRecording = false;
            
            // Stop waveform
            if (audioState.rafId) {
                cancelAnimationFrame(audioState.rafId);
                audioState.rafId = null;
            }
            
            // Stop stream
            if (audioState.stream) {
                audioState.stream.getTracks().forEach(track => track.stop());
                audioState.stream = null;
            }
            
            // Update UI
            $('#startAudioBtn').style.display = 'inline-flex';
            $('#stopAudioBtn').style.display = 'none';
            $('#recordingTimer').style.display = 'none';
            $('#audioStatus').textContent = 'Audio: Idle';
            $('#audioStatus').className = 'badge badge-idle';
        }
    }

    async function uploadAudioForAnalysis(blob) {
        // Get file if blob not provided
        if (!blob) {
            const fileInput = $('#audioFileInput');
            if (!fileInput?.files || !fileInput.files[0]) {
                alert('Please select an audio file');
                return;
            }
            blob = fileInput.files[0];
        }
        
        // Debug: Log blob details
        console.log('Blob received:', {
            blob: blob,
            type: typeof blob,
            constructor: blob?.constructor?.name,
            isFile: blob instanceof File,
            isBlob: blob instanceof Blob,
            hasSize: blob?.size !== undefined,
            size: blob?.size,
            name: blob?.name
        });
        
        // Validate file extension first (more reliable than instanceof)
        const fileName = (blob.name || '').toLowerCase();
        const supportedExtensions = ['.mp3', '.wav', '.webm', '.ogg', '.m4a', '.mp4', '.flac'];
        const fileExtension = fileName ? fileName.substring(fileName.lastIndexOf('.')) : '';
        const hasValidExtension = fileExtension && supportedExtensions.includes(fileExtension);
        
        // Validate MIME type (if available)
        const supportedMimeTypes = [
            'audio/mpeg', 'audio/mp3', 'audio/mpeg3', 'audio/x-mpeg',
            'audio/wav', 'audio/x-wav', 'audio/wave',
            'audio/webm', 'audio/ogg', 'audio/oga',
            'audio/mp4', 'audio/x-m4a', 'audio/m4a',
            'audio/flac', 'audio/x-flac'
        ];
        const mimeType = (blob.type || '').toLowerCase();
        const hasValidMimeType = !mimeType || supportedMimeTypes.includes(mimeType);
        
        // Validate blob is a File or Blob object
        const isFile = blob instanceof File;
        const isBlob = blob instanceof Blob;
        
        // More lenient check - if it has File-like properties, accept it
        const hasFileProperties = blob && typeof blob === 'object' && 'size' in blob;
        
        console.log('🔍 Validation check:', {
            fileName: fileName,
            fileExtension: fileExtension,
            hasValidExtension: hasValidExtension,
            mimeType: mimeType,
            hasValidMimeType: hasValidMimeType,
            isFile: isFile,
            isBlob: isBlob,
            hasFileProperties: hasFileProperties,
            size: blob.size
        });
        
        // Accept if: valid extension OR valid MIME type OR is File/Blob instance OR has file properties
        // More lenient: If it's a File object with size > 0, accept it (browser already validated it)
        const isAcceptable = hasValidExtension || hasValidMimeType || isFile || isBlob || hasFileProperties;
        
        if (!isAcceptable) {
            console.error('❌ File validation failed:', {
                fileName: fileName,
                extension: fileExtension,
                mimeType: mimeType,
                isFile: isFile,
                isBlob: isBlob,
                hasFileProperties: hasFileProperties,
                supportedExtensions: supportedExtensions,
                supportedMimeTypes: supportedMimeTypes
            });
            alert(`Invalid file type.\n\nFile: ${fileName || 'unknown'}\nExtension: ${fileExtension || 'none'}\nMIME: ${mimeType || 'none'}\n\nPlease select: ${supportedExtensions.join(', ').toUpperCase()}`);
            return;
        }
        
        // If it's a File object from input, trust browser validation and accept it
        if (isFile && blob.size > 0) {
            console.log('✅ File object accepted (browser validated)');
        }
        
        // Additional validation: check if blob has size
        if (!blob.size || blob.size === 0) {
            console.error('❌ Empty file detected:', blob);
            alert('File is empty. Please select a valid audio file.');
            return;
        }
        
        console.log('✅ File validated successfully:', {
            name: blob.name || 'unnamed',
            size: blob.size,
            type: blob.type || 'unknown',
            extension: fileExtension,
            isFile: isFile,
            isBlob: isBlob
        });
        
        // Show loading
        const emptyState = $('#audioEmptyState');
        const results = $('#audioResults');
        const transcriptSection = $('#transcriptSection');
        const vibeSection = $('#vibeSection');
        const metricsSection = $('#metricsSection');
        const jsonViewerSection = $('#jsonViewerSection');
        
        if (emptyState) emptyState.style.display = 'none';
        if (results) results.style.display = 'block';
        if ($('#audioEmotion')) $('#audioEmotion').textContent = 'Analyzing...';
        
        try {
            // Create FormData (blob is already validated above)
            const formData = new FormData();
            
            // Get filename safely - File has .name, Blob might not
            let filename = 'audio.webm';
            if (blob instanceof File && blob.name) {
                filename = blob.name;
            } else if (blob.name) {
                filename = blob.name;
            } else {
                // Try to determine from MIME type
                if (blob.type) {
                    const mimeToExt = {
                        'audio/mpeg': 'audio.mp3',
                        'audio/mp3': 'audio.mp3',
                        'audio/wav': 'audio.wav',
                        'audio/x-wav': 'audio.wav',
                        'audio/webm': 'audio.webm',
                        'audio/ogg': 'audio.ogg',
                        'audio/mp4': 'audio.m4a',
                        'audio/x-m4a': 'audio.m4a'
                    };
                    filename = mimeToExt[blob.type] || 'audio.webm';
                }
            }
            
            // Append to FormData - File or Blob both work
            // FormData.append accepts File or Blob as second parameter
            try {
                formData.append('audio_file', blob, filename);
                console.log('✅ FormData append successful');
            } catch (formError) {
                console.error('❌ FormData append error:', formError);
                alert(`Failed to prepare file for upload: ${formError.message}\n\nPlease try selecting the file again.`);
                return;
            }
            
            console.log('📤 Uploading audio file:', {
                filename: filename,
                size: blob.size,
                type: blob.type || 'unknown',
                constructor: blob.constructor.name,
                isFile: blob instanceof File,
                isBlob: blob instanceof Blob
            });
            
            const response = await fetch('/api/audio/analyze', {
                method: 'POST',
                body: formData
            });
            
            console.log('Response status:', response.status, response.statusText);
            
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ detail: `HTTP ${response.status}` }));
                throw new Error(errorData.detail || `Request failed: ${response.status}`);
            }
            
            const data = await response.json();
            console.log('Audio analysis response:', data);
            
            displayAudioResults(data);
            
        } catch (error) {
            console.error('Audio analysis error:', error);
            
            // Show error in UI
            if ($('#audioEmotion')) {
                $('#audioEmotion').textContent = 'Error';
            }
            if ($('#audioConfidence')) {
                $('#audioConfidence').textContent = 'Failed';
            }
            
            // Show error message
            alert(`Analysis failed: ${error.message}`);
            
            // Show empty state again
            if (emptyState) emptyState.style.display = 'block';
            if (results) results.style.display = 'none';
        }
    }

    function displayAudioResults(data) {
        console.log('Displaying audio results:', data);
        
        // Hide empty state
        const emptyState = $('#audioEmptyState');
        if (emptyState) emptyState.style.display = 'none';
        
        // Show results
        const results = $('#audioResults');
        if (results) results.style.display = 'block';
        
        if (!data || !data.success) {
            if ($('#audioEmotion')) {
                $('#audioEmotion').textContent = 'No Speech Detected';
            }
            if ($('#audioConfidence')) {
                $('#audioConfidence').textContent = '0%';
            }
            return;
        }
        
        // Update result cards
        if ($('#audioEmotion')) {
            $('#audioEmotion').textContent = normalizeEmotion(data.emotion || 'neutral');
        }
        if ($('#audioConfidence')) {
            $('#audioConfidence').textContent = `${((data.confidence || 0) * 100).toFixed(1)}%`;
        }
        if ($('#audioMood')) {
            $('#audioMood').textContent = data.mood_category || 'N/A';
        }
        if ($('#audioEnergy')) {
            $('#audioEnergy').textContent = data.energy_level || 'N/A';
        }
        
        // Update transcript
        const transcriptSection = $('#transcriptSection');
        const transcriptText = $('#audioTranscript');
        if (data.transcript && transcriptText) {
            if (transcriptSection) transcriptSection.style.display = 'block';
            transcriptText.textContent = data.transcript;
        } else if (transcriptSection) {
            transcriptSection.style.display = 'none';
        }
        
        // Update vibe
        const vibeSection = $('#vibeSection');
        const vibeText = $('#audioVibe');
        if (data.overall_vibe && vibeText) {
            if (vibeSection) vibeSection.style.display = 'block';
            vibeText.textContent = data.overall_vibe;
        } else if (vibeSection) {
            vibeSection.style.display = 'none';
        }
        
        // Update metrics
        const metricsSection = $('#metricsSection');
        if (metricsSection) metricsSection.style.display = 'block';
        
        if ($('#audioTone')) {
            $('#audioTone').textContent = data.tone || 'N/A';
        }
        if ($('#audioIntensity')) {
            $('#audioIntensity').textContent = data.emotional_intensity ? `${(data.emotional_intensity * 100).toFixed(0)}%` : 'N/A';
        }
        
        // Update key phrases
        const phrasesContainer = $('#audioKeyPhrases');
        if (phrasesContainer) {
            phrasesContainer.innerHTML = '';
            if (data.key_phrases && Array.isArray(data.key_phrases) && data.key_phrases.length > 0) {
                data.key_phrases.forEach(phrase => {
                    const tag = document.createElement('span');
                    tag.className = 'phrase-tag';
                    tag.textContent = phrase;
                    phrasesContainer.appendChild(tag);
                });
            }
        }
        
        // Update JSON viewer
        const jsonViewerSection = $('#jsonViewerSection');
        const jsonContent = $('#audioJson');
        if (jsonViewerSection && jsonContent) {
            jsonViewerSection.style.display = 'block';
            jsonContent.textContent = JSON.stringify(data, null, 2);
        }

        // Disagree button
        const audioFbRow = $('#audioFeedbackRow');
        if (audioFbRow && window.Feedback) {
            audioFbRow.style.display = 'block';
            audioFbRow.innerHTML = '';
            audioFbRow.appendChild(window.Feedback.createDisagreeButton({
                modality: 'audio',
                predicted_label: data.emotion || 'unknown',
                predicted_confidence: data.confidence || null,
            }));
        }

        console.log('Audio results displayed successfully');
    }

    function switchAudioMode(mode) {
        $$('.mode-btn').forEach(btn => btn.classList.remove('active'));
        $$('.audio-mode-content').forEach(content => content.classList.remove('active'));
        
        if (mode === 'record') {
            $('#audioModeRecord').classList.add('active');
            $('#recordModeContent').classList.add('active');
        } else {
            $('#audioModeUpload').classList.add('active');
            $('#uploadModeContent').classList.add('active');
        }
    }

    function handleAudioFileSelect(e) {
        const file = e.target.files[0];
        if (file) {
            $('#audioFileName').textContent = file.name;
            $('#audioFileSize').textContent = formatFileSize(file.size);
            $('#audioFileInfo').style.display = 'flex';
            $('#uploadAudioBtn').style.display = 'inline-flex';
        }
    }

    // ============================================
    // CHART UPDATE FUNCTIONS
    // ============================================
    function pushChartPoint(confidence) {
        if (!emotionChart) return;
        
        const maxPoints = 120;
        const labels = emotionChart.data.labels;
        const data = emotionChart.data.datasets[0].data;
        
        labels.push(videoState.duration.toString());
        data.push(confidence * 100);
        
        if (labels.length > maxPoints) {
            labels.shift();
            data.shift();
        }
        
        emotionChart.update('none');
    }

    function updateEmotionBars(emotions) {
        if (!emotionBars) return;
        
        // Update stacked histogram (like Visage Technologies)
        const emotionOrder = ['happiness', 'sadness', 'anger', 'fear', 'surprise', 'disgust', 'neutral'];
        emotionBars.data.datasets.forEach((dataset, index) => {
            const emotionKey = emotionOrder[index];
            dataset.data[0] = (emotions[emotionKey] || 0) * 100;
        });
        emotionBars.update('none');
    }

    function updateEmotionMultiChart(emotions) {
        if (!emotionMultiChart) return;
        
        const labels = emotionMultiChart.data.labels;
        labels.push(videoState.duration.toString());
        
        const datasets = emotionMultiChart.data.datasets;
        const emotionMap = {
            'Happiness': 'happiness',
            'Sadness': 'sadness',
            'Anger': 'anger',
            'Fear': 'fear',
            'Surprise': 'surprise',
            'Disgust': 'disgust',
            'Neutral': 'neutral'
        };
        
        datasets.forEach((dataset, idx) => {
            const emotionKey = emotionMap[dataset.label];
            dataset.data.push((emotions[emotionKey] || 0) * 100);
            if (dataset.data.length > 120) dataset.data.shift();
        });
        
        if (labels.length > 120) labels.shift();
        
        emotionMultiChart.update('none');
    }


    // ============================================
    // AU FUNCTIONS
    // ============================================
    function updateAUBars(aus) {
        const container = $('#auBarsContainer');
        if (!container) return;
        
        if (Object.keys(aus).length === 0) {
            container.innerHTML = '<p style="color: var(--subtext); text-align: center; padding: 20px;">No AU data available</p>';
            return;
        }
        
        const sortedAUs = Object.entries(aus)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 12);
        
        container.innerHTML = sortedAUs.map(([name, value]) => `
            <div class="au-bar">
                <span class="au-bar-label">${name}</span>
                <div class="au-bar-track">
                    <div class="au-bar-fill" style="width: ${value * 100}%"></div>
                </div>
                <span class="au-bar-value">${(value * 100).toFixed(1)}%</span>
            </div>
        `).join('');
        
        // Update AU count badge
        $('#auCount').textContent = `AUs: ${Object.keys(aus).length}`;
    }

    function explainEmotion(emotion, aus) {
        const reasoning = $('#auReasoning');
        const topAUs = $('#topAUsDisplay');
        
        if (!reasoning || !topAUs) return;
        
        if (Object.keys(aus).length === 0) {
            reasoning.innerHTML = '<p class="reasoning-text">No AU data available for reasoning.</p>';
            topAUs.innerHTML = '';
            return;
        }
        
        const sortedAUs = Object.entries(aus)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);
        
        const topAUsList = sortedAUs.map(([name, value]) => name).join(', ');
        reasoning.innerHTML = `
            <p class="reasoning-text">
                Detected emotion <strong>${emotion}</strong> is supported by the following Action Units: ${topAUsList}.
                These facial muscle movements indicate the emotional state.
            </p>
        `;
        
        topAUs.innerHTML = sortedAUs.map(([name, value]) => `
            <span class="top-au-badge">${name}: ${(value * 100).toFixed(1)}%</span>
        `).join('');
    }

    function updateAUAnalytics(aus) {
        if (Object.keys(aus).length === 0) return;
        
        auAnalytics.totalFrames++;
        const timestamp = Date.now() - (auAnalytics.startTime || Date.now());
        
        // Add to history
        auAnalytics.history.push({
            timestamp,
            aus: { ...aus }
        });
        
        // Update stats
        Object.entries(aus).forEach(([name, value]) => {
            if (!auAnalytics.stats[name]) {
                auAnalytics.stats[name] = {
                    values: [],
                    mean: 0,
                    max: 0,
                    min: 1,
                    count: 0
                };
            }
            
            const stat = auAnalytics.stats[name];
            stat.values.push(value);
            stat.count++;
            stat.mean = stat.values.reduce((a, b) => a + b, 0) / stat.values.length;
            stat.max = Math.max(stat.max, value);
            stat.min = Math.min(stat.min, value);
        });
        
        // Update dashboard charts (throttled)
        if (auAnalytics.totalFrames % 10 === 0) {
            updateAUDashboardCharts();
            updateAUStatsTable();
        }
    }

    function updateAUDashboardCharts() {
        // Time Series Chart
        if (auTimeSeriesChart && auAnalytics.history.length > 0) {
            const topAUs = Object.entries(auAnalytics.stats)
                .sort((a, b) => b[1].mean - a[1].mean)
                .slice(0, 6)
                .map(([name]) => name);
            
            auTimeSeriesChart.data.labels = auAnalytics.history.map((_, i) => i.toString());
            auTimeSeriesChart.data.datasets = topAUs.map((name, idx) => ({
                label: name,
                data: auAnalytics.history.map(entry => (entry.aus[name] || 0) * 100),
                borderColor: `hsl(${idx * 60}, 70%, 50%)`,
                tension: 0.4
            }));
            auTimeSeriesChart.update('none');
        }
        
        // Distribution Chart
        if (auDistributionChart) {
            const sorted = Object.entries(auAnalytics.stats)
                .sort((a, b) => b[1].mean - a[1].mean)
                .slice(0, 10);
            
            auDistributionChart.data.labels = sorted.map(([name]) => name);
            auDistributionChart.data.datasets[0].data = sorted.map(([, stat]) => stat.mean * 100);
            auDistributionChart.update('none');
        }
        
        // Top Chart
        if (auTopChart) {
            const sorted = Object.entries(auAnalytics.stats)
                .sort((a, b) => b[1].mean - a[1].mean)
                .slice(0, 10);
            
            auTopChart.data.labels = sorted.map(([name]) => name);
            auTopChart.data.datasets[0].data = sorted.map(([, stat]) => stat.mean * 100);
            auTopChart.update('none');
        }
    }

    function updateAUStatsTable() {
        const tbody = $('#auStatsTableBody');
        if (!tbody) return;
        
        const sorted = Object.entries(auAnalytics.stats)
            .sort((a, b) => b[1].mean - a[1].mean);
        
        tbody.innerHTML = sorted.map(([name, stat]) => `
            <tr>
                <td>${name}</td>
                <td>${(stat.mean * 100).toFixed(2)}%</td>
                <td>${(stat.max * 100).toFixed(2)}%</td>
                <td>${(stat.min * 100).toFixed(2)}%</td>
                <td>${stat.count}</td>
            </tr>
        `).join('');
    }


    function exportAUAnalyticsData() {
        const data = {
            history: auAnalytics.history,
            stats: auAnalytics.stats,
            totalFrames: auAnalytics.totalFrames,
            duration: videoState.duration
        };
        
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `au-analytics-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

    function resetAUAnalytics() {
        if (confirm('Reset all AU analytics data?')) {
            auAnalytics.history = [];
            auAnalytics.stats = {};
            auAnalytics.totalFrames = 0;
            updateAUDashboardCharts();
            updateAUStatsTable();
        }
    }

    // ============================================
    // SESSION SUMMARY
    // ============================================
    function generateSessionSummary() {
        if (videoState.timeline.length === 0) return;
        
        // Calculate emotion distribution
        const emotionCounts = {};
        videoState.timeline.forEach(entry => {
            const emotion = entry.label;
            emotionCounts[emotion] = (emotionCounts[emotion] || 0) + 1;
        });
        
        const total = videoState.timeline.length;
        const distribution = Object.entries(emotionCounts).map(([emotion, count]) => ({
            emotion,
            percentage: (count / total) * 100
        }));
        
        // Update pie chart
        if (emotionPie) {
            emotionPie.data.labels = distribution.map(d => d.emotion);
            emotionPie.data.datasets[0].data = distribution.map(d => d.percentage);
            emotionPie.update('none');
        }
        
        // Update summary stats
        const avgConfidence = videoState.timeline.reduce((sum, e) => sum + e.confidence, 0) / total;
        $('#summaryDuration').textContent = fmtTime(videoState.duration);
        $('#summaryAvgConfidence').textContent = `${(avgConfidence * 100).toFixed(1)}%`;
        
        // Count mood changes
        let moodChanges = 0;
        for (let i = 1; i < videoState.timeline.length; i++) {
            if (videoState.timeline[i].label !== videoState.timeline[i - 1].label) {
                moodChanges++;
            }
        }
        $('#summaryMoodChanges').textContent = moodChanges.toString();
    }

    // ============================================
    // UTILITY FUNCTIONS
    // ============================================
    function normalizeEmotion(e) {
        const map = {
            'happy': 'Happy', 'happiness': 'Happy',
            'sad': 'Sad', 'sadness': 'Sad',
            'angry': 'Angry', 'anger': 'Angry',
            'fear': 'Fear', 'fearful': 'Fear',
            'surprise': 'Surprise', 'surprised': 'Surprise',
            'disgust': 'Disgust', 'disgusted': 'Disgust',
            'contempt': 'Contempt',
            'neutral': 'Neutral',
            'frustrated': 'Frustrated',
        };
        return map[e?.toLowerCase()] || e?.charAt(0).toUpperCase() + e?.slice(1) || 'Unknown';
    }

    /** Display label + probability as one readable string (e.g. "Neutral (42% certain)"). */
    function formatEmotionCertainty(displayLabel, confidenceFraction) {
        const pct = Math.round(Math.max(0, Math.min(1, confidenceFraction)) * 100);
        return `${displayLabel} (${pct}% certain)`;
    }

    function fmtTime(s) {
        const mins = Math.floor(s / 60);
        const secs = s % 60;
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    function formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
    }

    function trackEmotionChange(currEmotion) {
        if (videoState.emotionHistory.length < 2) return;
        
        const prev = videoState.emotionHistory[videoState.emotionHistory.length - 2];
        if (prev.emotion === currEmotion) return;
        
        const logEntries = $('#logEntries');
        if (!logEntries) return;
        
        const entry = document.createElement('div');
        entry.className = 'log-entry';
        entry.innerHTML = `
            <span class="log-entry-change">${prev.emotion} → ${currEmotion}</span>
            <span class="log-entry-time">${fmtTime(videoState.duration)}</span>
        `;
        
        logEntries.insertBefore(entry, logEntries.firstChild);
        
        // Keep only last 20 entries
        while (logEntries.children.length > 20) {
            logEntries.removeChild(logEntries.lastChild);
        }
    }

    async function handleCameraChange() {
        const selectEl = $('#cameraSelect');
        const selectedOpt = selectEl?.selectedOptions?.[0];
        if (selectedOpt?.dataset?.facing) {
            const facingSel = $('#cameraFacing');
            if (facingSel) facingSel.value = selectedOpt.dataset.facing;
        }

        const facing = $('#cameraFacing')?.value || 'user';
        const device = selectEl?.value || 'browser';
        console.log('Camera changed:', { device, facing });

        if (!videoState.isRecording || !videoState.useBrowserWebcam) return;

        try {
            stopBrowserWebcam();
            await startBrowserWebcam();
            console.log('📷 Camera stream restarted after lens/device change');
        } catch (err) {
            console.error('Failed to switch camera:', err);
            alert(err.message || 'Could not switch camera. Try stopping and starting again.');
        }
    }

    // ============================================
    // DIAGNOSTIC FUNCTIONS — single cached health fetch
    // ============================================
    const healthCheckCache = {
        data: null,
        fetchedAt: 0,
        promise: null,
    };
    const HEALTH_CACHE_MS = 5000;
    const HEALTH_FETCH_TIMEOUT_MS = 8000;

    async function fetchModelHealth({ force = false } = {}) {
        const now = Date.now();
        if (
            !force
            && healthCheckCache.data
            && now - healthCheckCache.fetchedAt < HEALTH_CACHE_MS
        ) {
            return healthCheckCache.data;
        }
        if (healthCheckCache.promise && !force) {
            return healthCheckCache.promise;
        }

        healthCheckCache.promise = (async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), HEALTH_FETCH_TIMEOUT_MS);
            try {
                const response = await fetch('/health/model', {
                    signal: controller.signal,
                });
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                const data = await response.json();
                healthCheckCache.data = data;
                healthCheckCache.fetchedAt = Date.now();
                return data;
            } finally {
                clearTimeout(timer);
                healthCheckCache.promise = null;
            }
        })();

        return healthCheckCache.promise;
    }

    function applyBackendStatusBadge(data) {
        const badge = $('#backendStatus');
        if (!badge) return;

        const status = data?.status;
        if (status === 'healthy' || status === 'loading') {
            badge.textContent = status === 'loading' ? 'Backend: Loading models…' : 'Backend: Online';
            badge.className = 'badge badge-live';
        } else if (status === 'degraded') {
            badge.textContent = 'Backend: Degraded';
            badge.className = 'badge badge-idle';
        } else {
            badge.textContent = 'Backend: Offline';
            badge.className = 'badge badge-idle';
        }
    }

    function applyModelDashboardFromHealth(data) {
        const hse = data?.models?.hsemotion || {};
        console.log('🤖 Model status:', data);

        const statusEl = $('#modelStatus');
        if (statusEl) {
            if (hse.status === 'healthy' && hse.loaded) {
                statusEl.textContent = '✅ Loaded & Ready';
                statusEl.className = 'status-value badge-healthy';
            } else if (hse.status === 'loading') {
                statusEl.textContent = '⏳ Loading…';
                statusEl.className = 'status-value badge-idle';
            } else {
                statusEl.textContent = '❌ Not Available';
                statusEl.className = 'status-value badge-unhealthy';
            }
        }

        const deviceEl = $('#modelDevice');
        if (deviceEl && hse.device) {
            deviceEl.textContent = String(hse.device).toUpperCase();
        }

        applyModelPerformanceMetrics();
    }

    function applyModelPerformanceMetrics() {
        if (modelPerformance.totalFrames > 0) {
            const avgInferenceTime =
                modelPerformance.totalInferenceTime / modelPerformance.totalFrames;
            const fps = 1000 / avgInferenceTime;

            const inferenceTimeEl = $('#modelInferenceTime');
            if (inferenceTimeEl) {
                inferenceTimeEl.textContent = `${avgInferenceTime.toFixed(1)}ms`;
            }

            const fpsEl = $('#modelFPS');
            if (fpsEl) {
                fpsEl.textContent = `${fps.toFixed(1)} FPS`;
            }
        }

        const totalFramesEl = $('#modelTotalFrames');
        if (totalFramesEl) {
            totalFramesEl.textContent = modelPerformance.totalFrames.toLocaleString();
        }
    }

    async function initializeHealthAndModels() {
        try {
            const data = await fetchModelHealth();
            applyBackendStatusBadge(data);
            applyModelDashboardFromHealth(data);
        } catch (error) {
            console.error('❌ Health check failed:', error);
            applyBackendStatusBadge({ status: 'unhealthy' });
            const statusEl = $('#modelStatus');
            if (statusEl) {
                statusEl.textContent = '❌ Error';
                statusEl.className = 'status-value badge-unhealthy';
            }
        }
    }

    async function updateBackendStatus() {
        const data = await fetchModelHealth({ force: true });
        applyBackendStatusBadge(data);
        return data;
    }

    async function checkBackend() {
        const output = $('#diagnosticOutput');
        if (!output) return;

        output.textContent = 'Checking backend...\n';

        try {
            const data = await fetchModelHealth({ force: true });
            output.textContent = JSON.stringify(data, null, 2);
        } catch (error) {
            output.textContent = `Error: ${error.message}`;
        }
    }

    async function checkCameras() {
        try {
            if (!navigator.mediaDevices?.enumerateDevices) return;

            // Brief permission unlocks real device labels on mobile (iOS/Android)
            try {
                const probe = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 } },
                    audio: false,
                });
                probe.getTracks().forEach((t) => t.stop());
            } catch (_) {
                /* user may deny until Start — still list generic cameras */
            }

            const devices = await navigator.mediaDevices.enumerateDevices();
            const videoDevices = devices.filter((d) => d.kind === 'videoinput');

            const select = $('#cameraSelect');
            if (!select) return;

            select.innerHTML = '<option value="browser">Default (use Lens setting)</option>';
            videoDevices.forEach((device, index) => {
                const option = document.createElement('option');
                const rawLabel = device.label || `Camera ${index + 1}`;
                const isBack = /back|rear|environment|wide|tele/i.test(rawLabel);
                const isFront = /front|user|selfie|face/i.test(rawLabel);
                option.value = device.deviceId
                    ? `device:${device.deviceId}`
                    : 'browser';
                option.textContent = isBack
                    ? `${rawLabel} (Rear)`
                    : isFront
                        ? `${rawLabel} (Front)`
                        : rawLabel;
                if (isBack) option.dataset.facing = 'environment';
                if (isFront) option.dataset.facing = 'user';
                select.appendChild(option);
            });
        } catch (error) {
            console.error('Camera enumeration error:', error);
        }
    }

    function showMacSetup() {
        const output = $('#diagnosticOutput');
        if (!output) return;
        
        output.textContent = `
macOS Setup Help:

1. Install OpenCV:
   brew install opencv

2. Install Python dependencies:
   pip install opencv-python

3. Grant camera permissions:
   System Preferences > Security & Privacy > Camera

4. Test camera access:
   python -c "import cv2; print(cv2.VideoCapture(0).isOpened())"
        `;
    }

    // ============================================
    // HSEmotion MODEL DASHBOARD
    // ============================================
    let modelPerformance = {
        totalFrames: 0,
        totalInferenceTime: 0,
        lastUpdate: Date.now()
    };

    async function refreshModelStatus() {
        try {
            const data = await fetchModelHealth({ force: true });
            applyBackendStatusBadge(data);
            applyModelDashboardFromHealth(data);
        } catch (error) {
            console.error('❌ Failed to fetch model status:', error);
            const statusEl = $('#modelStatus');
            if (statusEl) {
                statusEl.textContent = '❌ Error';
                statusEl.className = 'status-value badge-unhealthy';
            }
        }
    }

    function updateModelPerformance(inferenceTimeMs) {
        modelPerformance.totalFrames++;
        modelPerformance.totalInferenceTime += inferenceTimeMs;
        modelPerformance.lastUpdate = Date.now();

        // Update local FPS metrics only — no network call per 10 frames
        if (modelPerformance.totalFrames % 10 === 0) {
            applyModelPerformanceMetrics();
        }
    }

    // ============================================
    // ANIMAL EMOTION TAB
    // ============================================
    (function initAnimalTab() {
        // Labels from dima806/pets_facial_expression_detection: Angry, happy, Sad, Other
        const EMOJI_MAP = {
            happy:'😄', Happy:'😄',
            angry:'😠', Angry:'😠',
            sad:'😢',   Sad:'😢',
            other:'😐', Other:'😐',
        };
        function emojiFor(lbl) { return EMOJI_MAP[lbl?.toLowerCase()] || '🐾'; }
        function fmtBytes(b) {
            if (!b) return '0 B';
            const k=1024, s=['B','KB','MB'], i=Math.floor(Math.log(b)/Math.log(k));
            return `${(b/Math.pow(k,i)).toFixed(1)} ${s[i]}`;
        }

        let selectedFile = null;

        // -- event wiring (delegated, safe if elements absent) --
        document.addEventListener('click', e => {
            if (e.target.closest('#animalUploadArea')) $('#animalFileInput')?.click();
            if (e.target.closest('#animalAnalyzeBtn'))  runAnalysis();
        });
        document.addEventListener('change', e => {
            if (e.target.id === 'animalFileInput' && e.target.files.length > 0)
                handleFile(e.target.files[0]);
        });
        document.addEventListener('dragover', e => {
            if (e.target.closest('#animalUploadArea')) {
                e.preventDefault();
                const ua = $('#animalUploadArea');
                if (ua) ua.style.borderColor = 'var(--primary)';
            }
        });
        document.addEventListener('dragleave', e => {
            if (e.target.closest('#animalUploadArea')) {
                const ua = $('#animalUploadArea');
                if (ua) ua.style.borderColor = '';
            }
        });
        document.addEventListener('drop', e => {
            if (!e.target.closest('#animalUploadArea')) return;
            e.preventDefault();
            const ua = $('#animalUploadArea');
            if (ua) ua.style.borderColor = '';
            if (e.dataTransfer.files.length > 0) handleFile(e.dataTransfer.files[0]);
        });

        function handleFile(file) {
            const allowedTypes = ['image/jpeg','image/jpg','image/png'];
            const allowedExts  = ['.jpg','.jpeg','.png'];
            const ext = '.' + file.name.split('.').pop().toLowerCase();
            if (!allowedTypes.includes(file.type) && !allowedExts.includes(ext)) {
                showError('Unsupported format. Upload JPEG or PNG.'); return;
            }
            if (file.size > 5 * 1024 * 1024) { showError('File too large. Max 5 MB.'); return; }

            selectedFile = file;
            const fi = $('#animalFileInfo');
            if (fi) {
                fi.style.display = 'flex';
                const fn = $('#animalFileName'); if (fn) fn.textContent = file.name;
                const fs = $('#animalFileSize'); if (fs) fs.textContent = fmtBytes(file.size);
            }
            const ab = $('#animalAnalyzeBtn'); if (ab) ab.style.display = '';
            hideError();
            clearResult();

            const reader = new FileReader();
            reader.onload = ev => {
                const img = $('#animalPreviewImg');
                const wrap = $('#animalPreviewContainer');
                if (img) img.src = ev.target.result;
                if (wrap) wrap.style.display = '';
            };
            reader.readAsDataURL(file);
        }

        async function runAnalysis() {
            if (!selectedFile) return;
            setLoading(true);
            hideError();
            clearResult();
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
                renderResult(await res.json(), elapsed);
            } catch (err) {
                showError(err.message || 'Analysis failed. Please try again.');
            } finally {
                setLoading(false);
            }
        }

        function renderResult(data, elapsed) {
            const empty = $('#animalEmptyState'); if (empty) empty.style.display = 'none';
            const card  = $('#animalResultCard');  if (card)  card.style.display  = '';

            const label = data.label || 'unknown';
            const conf  = data.confidence_score || 0;
            const pct   = (conf * 100).toFixed(1);

            const heroEmoji = $('#animalHeroEmoji'); if (heroEmoji) heroEmoji.textContent = emojiFor(label);
            const heroLabel = $('#animalHeroLabel'); if (heroLabel) heroLabel.textContent = label;
            const heroConf  = $('#animalHeroConf');  if (heroConf)  heroConf.textContent  = `Confidence: ${pct}%`;
            const confFill  = $('#animalConfFill');  if (confFill)  confFill.style.width  = `${pct}%`;

            const distList = $('#animalDistList');
            if (distList) {
                const sorted = Object.entries(data.all_emotions || {}).sort((a,b) => b[1]-a[1]);
                distList.innerHTML = sorted.map(([lbl, score]) => {
                    const p = (score * 100).toFixed(1);
                    return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:9px;">
                        <span style="font-size:.82rem;min-width:90px;text-transform:capitalize;">${emojiFor(lbl)} ${lbl}</span>
                        <div style="flex:1;height:6px;background:var(--muted);border-radius:3px;overflow:hidden;">
                            <div style="height:100%;border-radius:3px;background:var(--primary);width:${p}%;
                                        opacity:${lbl===label?'1':'0.5'};"></div>
                        </div>
                        <span style="font-size:.78rem;color:var(--subtext);min-width:38px;text-align:right;">${p}%</span>
                    </div>`;
                }).join('');
            }

            const metaModel = $('#animalMetaModel'); if (metaModel) {
                const roi = data.roi_method ? ` · crop: ${data.roi_method}` : '';
                metaModel.textContent = (data.backend || 'vit-animal-emotion') + roi;
            }
            const metaTime  = $('#animalMetaTime');  if (metaTime)  metaTime.textContent  = `${elapsed}s`;

            const guideEl = $('#animalGuidanceText');
            if (guideEl) {
                guideEl.textContent = data.guidance || '';
                guideEl.style.display = data.guidance ? 'block' : 'none';
                guideEl.classList.toggle('animal-low-confidence', !!data.low_confidence);
            }

            // Disagree button
            const animalFbRow = $('#animalFeedbackRow');
            if (animalFbRow && window.Feedback) {
                animalFbRow.innerHTML = '';
                animalFbRow.appendChild(window.Feedback.createDisagreeButton({
                    modality: 'animal',
                    predicted_label: data.label || 'unknown',
                    predicted_confidence: data.confidence_score || null,
                }));
            }
        }

        function clearResult() {
            const card  = $('#animalResultCard');  if (card)  card.style.display  = 'none';
            const empty = $('#animalEmptyState');  if (empty) empty.style.display = '';
            const distList = $('#animalDistList'); if (distList) distList.innerHTML = '';
            const confFill = $('#animalConfFill'); if (confFill) confFill.style.width = '0%';
        }
        function setLoading(on) {
            const l = $('#animalLoading'); if (l) l.style.display = on ? '' : 'none';
            const b = $('#animalAnalyzeBtn'); if (b) b.disabled = on;
        }
        function showError(msg) {
            const e = $('#animalErrorMsg'); if (e) { e.textContent = msg; e.style.display = ''; }
        }
        function hideError() {
            const e = $('#animalErrorMsg'); if (e) e.style.display = 'none';
        }
    })();

    // ============================================
    // INITIALIZE ON LOAD
    // ============================================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
