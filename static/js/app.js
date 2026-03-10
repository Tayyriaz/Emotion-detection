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
        useBrowserWebcam: true,
        sessionCount: 0,
        timeline: [],
        emotionHistory: [],
        auHistory: []
    };

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

    // ============================================
    // INITIALIZATION
    // ============================================
    function init() {
        console.log('Initializing Multimodal Emotion Analyzer...');
        
        setupTabs();
        setupEvents();
        initCharts();
        initImageTab();
        updateBackendStatus();
        checkCameras();
        refreshModelStatus(); // Load model status on startup
        
        console.log('✅ Initialization complete');
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
        $('#stopVideoBtn')?.addEventListener('click', stopVideoRecording);
        $('#pauseVideoBtn')?.addEventListener('click', pauseVideoRecording);
        $('#cameraSelect')?.addEventListener('change', handleCameraChange);
        
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
    }

    // ============================================
    // VIDEO FUNCTIONS
    // ============================================
    async function startVideoRecording() {
        try {
            videoState.useBrowserWebcam = $('#cameraSelect')?.value === 'browser';
            
            if (videoState.useBrowserWebcam) {
                await startBrowserWebcam();
            }
            
            videoState.isRecording = true;
            videoState.startTs = Date.now();
            videoState.sessionCount++;
            videoState.timeline = [];
            videoState.emotionHistory = [];
            videoState.auHistory = [];
            
            // Update UI
            $('#startVideoBtn').style.display = 'none';
            $('#stopVideoBtn').style.display = 'inline-flex';
            $('#pauseVideoBtn').style.display = 'inline-flex';
            $('#videoStatus').textContent = 'Video: Recording';
            $('#videoStatus').className = 'badge badge-live';
            $('#sessionCount').textContent = `Session: ${videoState.sessionCount}`;
            
            // Start polling
            videoState.pollId = setInterval(() => {
                if (videoState.useBrowserWebcam) {
                    captureAndAnalyzeFrame();
                } else {
                    updateVideoTelemetry();
                }
            }, parseInt($('#frameInterval')?.value || 400));
            
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
        
        // Stop browser webcam
        if (videoState.useBrowserWebcam) {
            stopBrowserWebcam();
        }
        
        // Update UI
        $('#startVideoBtn').style.display = 'inline-flex';
        $('#stopVideoBtn').style.display = 'none';
        $('#pauseVideoBtn').style.display = 'none';
        $('#videoStatus').textContent = 'Video: Idle';
        $('#videoStatus').className = 'badge badge-idle';
        
        // Generate session summary
        generateSessionSummary();
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
            }, parseInt($('#frameInterval')?.value || 400));
            $('#pauseVideoBtn').textContent = 'Pause';
        }
    }

    async function startBrowserWebcam() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { width: 640, height: 480, facingMode: 'user' }
            });
            
            const video = $('#videoStream');
            if (video) {
                video.srcObject = stream;
                video.style.display = 'block';
                $('#videoPlaceholder')?.classList.add('hidden');
                
                // Setup canvas
                video.addEventListener('loadedmetadata', () => {
                    const canvas = $('#videoCanvas');
                    if (canvas) {
                        canvas.width = video.videoWidth;
                        canvas.height = video.videoHeight;
                    }
                });
            }
            
            videoState.stream = stream;
        } catch (error) {
            throw new Error(`Camera access failed: ${error.message}`);
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

    async function captureAndAnalyzeFrame() {
        const video = $('#videoStream');
        const videoCanvas = $('#videoCanvas');
        const videoCtx = videoCanvas?.getContext('2d');
        
        if (!video || video.readyState !== video.HAVE_ENOUGH_DATA || !videoCanvas || !videoCtx) return;
        
        // Get video dimensions
        const videoWidth = video.videoWidth || videoCanvas.width;
        const videoHeight = video.videoHeight || videoCanvas.height;
        
        // Set canvas size to match video
        if (videoCanvas.width !== videoWidth || videoCanvas.height !== videoHeight) {
            videoCanvas.width = videoWidth;
            videoCanvas.height = videoHeight;
        }
        
        // Draw video frame to canvas (will be updated with bounding box in handleVideoResult)
        videoCtx.drawImage(video, 0, 0, videoWidth, videoHeight);
        
        // Create temporary canvas for analysis (smaller size for faster processing)
        const tempCanvas = document.createElement('canvas');
        const tempCtx = tempCanvas.getContext('2d');
        tempCanvas.width = 320;
        tempCanvas.height = 240;
        tempCtx.drawImage(video, 0, 0, 320, 240);
        
        const imageData = tempCanvas.toDataURL('image/jpeg', 0.6);
        
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
            console.error('Frame analysis error:', error);
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
        const videoCanvas = $('#videoCanvas');
        const videoCtx = videoCanvas?.getContext('2d');
        
        // Clear previous bounding box
        if (videoCtx && videoWidth && videoHeight) {
            // Redraw video frame (will be done in next frame capture)
        }
        
        if (!data.success || !data.face_detected) {
            $('#currentEmotion').textContent = 'No Face';
            $('#currentConfidence').textContent = '0%';
            
            // Clear bounding box if no face
            if (videoCtx && videoWidth && videoHeight) {
                const video = $('#videoStream');
                if (video && video.readyState === video.HAVE_ENOUGH_DATA) {
                    videoCtx.drawImage(video, 0, 0, videoWidth, videoHeight);
                }
            }
            return;
        }
        
        const emotion = normalizeEmotion(data.emotion);
        const confidence = (data.confidence || 0) * 100;
        const emotions = data.emotions || {};
        const aus = data.aus || {};
        const faceBbox = data.face_bbox || null;
        
        // Draw bounding box on video canvas if available
        if (videoCtx && faceBbox && Array.isArray(faceBbox) && faceBbox.length >= 4 && videoWidth && videoHeight) {
            const video = $('#videoStream');
            if (video && video.readyState === video.HAVE_ENOUGH_DATA) {
                // Redraw video frame
                videoCtx.drawImage(video, 0, 0, videoWidth, videoHeight);
                
                // Calculate scale factors (bbox is from 320x240 analysis, need to scale to actual video size)
                const scaleX = videoWidth / 320;
                const scaleY = videoHeight / 240;
                
                // Draw bounding box
                const [x1, y1, x2, y2] = faceBbox;
                const scaledX1 = x1 * scaleX;
                const scaledY1 = y1 * scaleY;
                const scaledX2 = x2 * scaleX;
                const scaledY2 = y2 * scaleY;
                const width = scaledX2 - scaledX1;
                const height = scaledY2 - scaledY1;
                
                // Draw rectangle
                videoCtx.strokeStyle = '#3b82f6';
                videoCtx.lineWidth = 3;
                videoCtx.strokeRect(scaledX1, scaledY1, width, height);
                
                // Draw emotion label above bounding box
                videoCtx.fillStyle = '#3b82f6';
                videoCtx.font = 'bold 16px Arial';
                videoCtx.fillText(`${emotion} (${confidence.toFixed(0)}%)`, scaledX1, Math.max(scaledY1 - 5, 20));
            }
        }
        
        // Apply smoothing for stability
        const smoothedEmotions = applyEmotionSmoothing(emotions);
        const smoothedEmotion = getDominantEmotion(smoothedEmotions);
        const smoothedConfidence = smoothedEmotions[smoothedEmotion] || confidence / 100;
        
        // Update current emotion (use smoothed values)
        $('#currentEmotion').textContent = normalizeEmotion(smoothedEmotion);
        $('#currentConfidence').textContent = `${(smoothedConfidence * 100).toFixed(1)}%`;
        
        // Update AU count
        const auCount = Object.keys(aus).length;
        $('#auCount').textContent = `AUs: ${auCount}`;
        
        // Add to timeline (use smoothed values for stability)
        const timelineEntry = {
            t: videoState.duration,
            label: smoothedEmotion,
            confidence: smoothedConfidence,
            scores: smoothedEmotions,
            aus: aus
        };
        videoState.timeline.push(timelineEntry);
        videoState.emotionHistory.push({ emotion: smoothedEmotion, confidence: smoothedConfidence, time: videoState.duration });
        videoState.auHistory.push({ aus, time: videoState.duration });
        
        // Update charts (use smoothed emotions for stacked histogram)
        pushChartPoint(smoothedConfidence);
        updateEmotionBars(smoothedEmotions);  // Stacked histogram
        updateEmotionMultiChart(smoothedEmotions);
        updateAUBars(aus);
        
        // Update model performance if inference time available
        if (data.inference_time_ms) {
            updateModelPerformance(data.inference_time_ms);
        }
        
        // Track emotion changes
        trackEmotionChange(smoothedEmotion);
        
        // Update AU reasoning
        explainEmotion(smoothedEmotion, aus);
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
        const emotionKeys = ['happiness', 'sadness', 'anger', 'fear', 'surprise', 'disgust', 'neutral'];
        
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
            'neutral': 'Neutral'
        };
        return map[e?.toLowerCase()] || e?.charAt(0).toUpperCase() + e?.slice(1) || 'Unknown';
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

    function handleCameraChange() {
        // Camera change handler
        console.log('Camera changed:', $('#cameraSelect')?.value);
    }

    // ============================================
    // DIAGNOSTIC FUNCTIONS
    // ============================================
    async function updateBackendStatus() {
        try {
            const response = await fetch('/health/model');
            const data = await response.json();
            
            const badge = $('#backendStatus');
            if (badge) {
                if (data.status === 'healthy') {
                    badge.textContent = 'Backend: Online';
                    badge.className = 'badge badge-live';
                } else {
                    badge.textContent = 'Backend: Offline';
                    badge.className = 'badge badge-idle';
                }
            }
        } catch (error) {
            const badge = $('#backendStatus');
            if (badge) {
                badge.textContent = 'Backend: Error';
                badge.className = 'badge badge-idle';
            }
        }
    }

    async function checkBackend() {
        const output = $('#diagnosticOutput');
        if (!output) return;
        
        output.textContent = 'Checking backend...\n';
        
        try {
            const response = await fetch('/health/model');
            const data = await response.json();
            output.textContent = JSON.stringify(data, null, 2);
        } catch (error) {
            output.textContent = `Error: ${error.message}`;
        }
    }

    async function checkCameras() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const videoDevices = devices.filter(d => d.kind === 'videoinput');
            
            const select = $('#cameraSelect');
            if (select) {
                select.innerHTML = '<option value="browser">Browser Webcam</option>';
                videoDevices.forEach((device, index) => {
                    const option = document.createElement('option');
                    option.value = index.toString();
                    option.textContent = device.label || `Camera ${index + 1}`;
                    select.appendChild(option);
                });
            }
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
            const response = await fetch('/health/model');
            const data = await response.json();
            
            console.log('🤖 Model status:', data);
            
            // Update model status
            const statusEl = $('#modelStatus');
            if (statusEl) {
                if (data.status === 'healthy' && data.available) {
                    statusEl.textContent = '✅ Loaded & Ready';
                    statusEl.className = 'status-value badge-healthy';
                } else {
                    statusEl.textContent = '❌ Not Available';
                    statusEl.className = 'status-value badge-unhealthy';
                }
            }
            
            // Update model device
            if (data.device) {
                const deviceEl = $('#modelDevice');
                if (deviceEl) {
                    deviceEl.textContent = data.device.toUpperCase();
                }
            }
            
            // Calculate performance metrics
            if (modelPerformance.totalFrames > 0) {
                const avgInferenceTime = modelPerformance.totalInferenceTime / modelPerformance.totalFrames;
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
            
            // Update total frames
            const totalFramesEl = $('#modelTotalFrames');
            if (totalFramesEl) {
                totalFramesEl.textContent = modelPerformance.totalFrames.toLocaleString();
            }
            
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
        
        // Update performance display every 10 frames
        if (modelPerformance.totalFrames % 10 === 0) {
            refreshModelStatus();
        }
    }

    // ============================================
    // INITIALIZE ON LOAD
    // ============================================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
