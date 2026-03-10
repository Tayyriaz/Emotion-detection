/**
 * Video Emotion Detection - Standalone Page
 * Production-ready JavaScript using WebSocket (not polling)
 */

// Global Variables
const btnStart = document.getElementById('btnStart');
const btnStop = document.getElementById('btnStop');
const videoFeed = document.getElementById('videoFeed');
const videoCanvas = document.getElementById('videoCanvas');
const videoPlaceholder = document.getElementById('videoPlaceholder');
const emotionLabel = document.getElementById('emotionLabel');
const confidenceFill = document.getElementById('confidenceFill');
const confidenceText = document.getElementById('confidenceText');
const frameCount = document.getElementById('frameCount');
const duration = document.getElementById('duration');
const status = document.getElementById('status');
const statusIndicator = status.querySelector('.status-indicator');
const statusText = status.querySelector('.status-text');
const histogramContainer = document.getElementById('histogramContainer');
const stackedHistogram = document.getElementById('stackedHistogram');
const showLandmarksToggle = document.getElementById('showLandmarksToggle');

let stream = null;
let ws = null;
let isRecording = false;
let frameInterval = null;
let frameCounter = 0;
let startTime = null;
let durationInterval = null;
let ctx = null;
let showLandmarks = false;

// Smoothing buffers
let emotionHistory = [];
let confidenceHistory = [];
let emotionsHistory = [];
const maxHistorySize = 5;

// ============================================
// INITIALIZATION
// ============================================

// Setup canvas context
if (videoCanvas) {
    ctx = videoCanvas.getContext('2d');
    videoCanvas.width = 640;
    videoCanvas.height = 480;
}

// Landmarks toggle
if (showLandmarksToggle) {
    showLandmarksToggle.addEventListener('change', (e) => {
        showLandmarks = e.target.checked;
        if (showLandmarks && currentBbox) {
            drawFacialLandmarks(currentBbox);
        } else {
            clearCanvas();
            if (currentBbox) {
                drawBoundingBox(currentBbox, currentEmotion, currentConfidence);
            }
        }
    });
}

let currentBbox = null;
let currentEmotion = 'neutral';
let currentConfidence = 0;

// ============================================
// EVENT LISTENERS
// ============================================

btnStart.addEventListener('click', startRecording);
btnStop.addEventListener('click', stopRecording);

// ============================================
// CORE FUNCTIONS
// ============================================

/**
 * Start recording
 */
async function startRecording() {
    try {
        // Request camera access
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width: { ideal: 640 },
                    height: { ideal: 480 },
                    facingMode: 'user'
                }
            });
        } catch (error) {
            if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
                alert('Camera permission denied. Please allow camera access in your browser settings and refresh the page.');
                return;
            } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
                alert('No camera found. Please connect a camera and try again.');
                return;
            } else if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
                alert('Camera is already in use by another application. Please close other applications using the camera.');
                return;
            } else {
                alert(`Camera access failed: ${error.message || 'Unknown error'}`);
                return;
            }
        }
        
        videoFeed.srcObject = stream;
        await videoFeed.play();
        
        // Hide placeholder, show video
        videoPlaceholder.classList.add('hidden');
        videoFeed.style.display = 'block';
        
        // Update canvas size
        updateCanvasSize();
        
        // Connect WebSocket
        await connectWebSocket();
        
        // Start recording
        isRecording = true;
        frameCounter = 0;
        startTime = Date.now();
        
        btnStart.style.display = 'none';
        btnStop.style.display = 'block';
        
        updateStatus('recording');
        startDurationTimer();
        
        // Start frame capture
        frameInterval = setInterval(() => {
            if (isRecording && ws && ws.readyState === WebSocket.OPEN) {
                captureFrame();
            }
        }, 100); // 10 FPS
        
    } catch (error) {
        console.error('Error starting recording:', error);
        alert(`Failed to start recording: ${error.message}`);
    }
}

/**
 * Stop recording
 */
function stopRecording() {
    isRecording = false;
    
    // Stop frame capture
    if (frameInterval) {
        clearInterval(frameInterval);
        frameInterval = null;
    }
    
    // Stop duration timer
    if (durationInterval) {
        clearInterval(durationInterval);
        durationInterval = null;
    }
    
    // Close WebSocket
    if (ws) {
        try {
            ws.send(JSON.stringify({ type: 'stop' }));
        } catch (e) {
            // Ignore
        }
        ws.close();
        ws = null;
    }
    
    // Stop camera stream
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
    }
    
    videoFeed.srcObject = null;
    videoPlaceholder.classList.remove('hidden');
    videoFeed.style.display = 'none';
    
    btnStart.style.display = 'block';
    btnStop.style.display = 'none';
    
    updateStatus('stopped');
    
    // Clear history
    emotionHistory = [];
    confidenceHistory = [];
    emotionsHistory = [];
    
    clearCanvas();
    histogramContainer.style.display = 'none';
}

/**
 * Connect WebSocket
 */
async function connectWebSocket() {
    return new Promise((resolve, reject) => {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/video/emotion`;
        
        ws = new WebSocket(wsUrl);
        
        ws.onopen = () => {
            console.log('WebSocket connected');
            resolve();
        };
        
        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                
                if (data.type === 'ping') {
                    ws.send(JSON.stringify({ type: 'pong' }));
                    return;
                }
                
                if (data.type === 'emotion') {
                    handleEmotionUpdate(data);
                }
            } catch (error) {
                console.error('Error parsing WebSocket message:', error);
            }
        };
        
        ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            reject(error);
        };
        
        ws.onclose = () => {
            console.log('WebSocket closed');
            if (isRecording) {
                // Try to reconnect
                setTimeout(() => {
                    if (isRecording) {
                        connectWebSocket().catch(console.error);
                    }
                }, 2000);
            }
        };
    });
}

/**
 * Capture frame
 */
function captureFrame() {
    if (!videoFeed || videoFeed.readyState !== videoFeed.HAVE_ENOUGH_DATA) {
        return;
    }
    
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(videoFeed, 0, 0, 320, 240);
    
    const imageData = canvas.toDataURL('image/jpeg', 0.6);
    
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'frame',
            image: imageData
        }));
        frameCounter++;
        frameCount.textContent = frameCounter;
    }
}

/**
 * Handle emotion update
 */
function handleEmotionUpdate(data) {
    if (!data.success || !data.face_detected) {
        emotionLabel.textContent = 'No Face';
        confidenceFill.style.width = '0%';
        confidenceText.textContent = '0%';
        histogramContainer.style.display = 'none';
        clearCanvas();
        return;
    }
    
    let emotion = data.emotion || 'neutral';
    let confidence = data.confidence || 0;
    let emotions = data.emotions || {};
    
    // Apply smoothing
    const smoothed = applySmoothing(emotion, confidence, emotions);
    emotion = smoothed.emotion;
    confidence = smoothed.confidence;
    emotions = smoothed.emotions;
    
    // Update UI
    emotionLabel.textContent = emotion.charAt(0).toUpperCase() + emotion.slice(1);
    const confidencePercent = confidence * 100;
    confidenceFill.style.width = `${confidencePercent}%`;
    confidenceText.textContent = `${confidencePercent.toFixed(1)}%`;
    
    // Update histogram
    updateHistogram(emotions);
    
    // Draw bounding box
    if (data.face_bbox && Array.isArray(data.face_bbox) && data.face_bbox.length === 4) {
        currentBbox = data.face_bbox;
        currentEmotion = emotion;
        currentConfidence = confidence;
        drawBoundingBox(data.face_bbox, emotion, confidence);
    }
}

/**
 * Apply smoothing
 */
function applySmoothing(emotion, confidence, emotions) {
    emotionHistory.push(emotion);
    confidenceHistory.push(confidence);
    emotionsHistory.push(emotions);
    
    if (emotionHistory.length > maxHistorySize) {
        emotionHistory.shift();
        confidenceHistory.shift();
        emotionsHistory.shift();
    }
    
    if (emotionHistory.length < 2) {
        return { emotion, confidence, emotions };
    }
    
    // Majority voting for emotion
    const counts = {};
    emotionHistory.forEach(e => counts[e] = (counts[e] || 0) + 1);
    let smoothedEmotion = emotion;
    let maxCount = 0;
    Object.entries(counts).forEach(([e, count]) => {
        if (count > maxCount) {
            maxCount = count;
            smoothedEmotion = e;
        }
    });
    
    // Average confidence
    const avgConfidence = confidenceHistory.reduce((a, b) => a + b, 0) / confidenceHistory.length;
    
    // Average emotions
    const smoothedEmotions = {};
    Object.keys(emotions).forEach(key => {
        const values = emotionsHistory.map(e => e[key] || 0);
        smoothedEmotions[key] = values.reduce((a, b) => a + b, 0) / values.length;
    });
    
    return { emotion: smoothedEmotion, confidence: avgConfidence, emotions: smoothedEmotions };
}

/**
 * Update histogram
 */
function updateHistogram(emotions) {
    if (!emotions || Object.keys(emotions).length === 0) {
        histogramContainer.style.display = 'none';
        return;
    }
    
    histogramContainer.style.display = 'block';
    
    const sorted = Object.entries(emotions)
        .map(([emotion, confidence]) => ({ emotion, confidence: Math.max(0, Math.min(1, confidence)) }))
        .sort((a, b) => b.confidence - a.confidence);
    
    stackedHistogram.innerHTML = '';
    
    const barContainer = document.createElement('div');
    barContainer.className = 'histogram-bar';
    
    sorted.forEach(({ emotion, confidence }) => {
        if (confidence > 0.01) {
            const segment = document.createElement('div');
            segment.className = `histogram-segment ${emotion}`;
            segment.style.width = `${confidence * 100}%`;
            
            const label = document.createElement('span');
            label.className = 'histogram-label';
            label.textContent = emotion.charAt(0).toUpperCase() + emotion.slice(1);
            
            const value = document.createElement('span');
            value.className = 'histogram-value';
            value.textContent = `${(confidence * 100).toFixed(1)}%`;
            
            segment.appendChild(label);
            segment.appendChild(value);
            barContainer.appendChild(segment);
        }
    });
    
    stackedHistogram.appendChild(barContainer);
}

/**
 * Draw bounding box
 */
function drawBoundingBox(bbox, emotion, confidence) {
    if (!ctx || !bbox || bbox.length !== 4) return;
    
    clearCanvas();
    
    const [x1, y1, x2, y2] = bbox;
    const width = x2 - x1;
    const height = y2 - y1;
    
    // Scale to canvas
    const scaleX = videoCanvas.width / videoFeed.videoWidth;
    const scaleY = videoCanvas.height / videoFeed.videoHeight;
    
    const sx1 = x1 * scaleX;
    const sy1 = y1 * scaleY;
    const swidth = width * scaleX;
    const sheight = height * scaleY;
    
    // Draw box
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 3;
    ctx.strokeRect(sx1, sy1, swidth, sheight);
    
    // Draw landmarks if enabled
    if (showLandmarks) {
        drawFacialLandmarks(bbox);
    }
    
    // Draw label
    ctx.fillStyle = 'rgba(59, 130, 246, 0.9)';
    ctx.fillRect(sx1, sy1 - 25, 150, 20);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 12px Arial';
    ctx.fillText(`${emotion} (${(confidence * 100).toFixed(0)}%)`, sx1 + 5, sy1 - 8);
}

/**
 * Draw facial landmarks (simplified)
 */
function drawFacialLandmarks(bbox) {
    if (!ctx || !bbox) return;
    
    const [x1, y1, x2, y2] = bbox;
    const width = x2 - x1;
    const height = y2 - y1;
    const centerX = (x1 + x2) / 2;
    const centerY = (y1 + y2) / 2;
    
    const scaleX = videoCanvas.width / videoFeed.videoWidth;
    const scaleY = videoCanvas.height / videoFeed.videoHeight;
    
    ctx.fillStyle = '#10b981';
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 2;
    
    // Draw estimated landmarks (simplified)
    const landmarks = [
        [centerX - width * 0.2, y1 + height * 0.3], // Left eye
        [centerX + width * 0.2, y1 + height * 0.3], // Right eye
        [centerX, y1 + height * 0.5], // Nose
        [centerX - width * 0.15, y1 + height * 0.7], // Left mouth
        [centerX + width * 0.15, y1 + height * 0.7], // Right mouth
    ];
    
    landmarks.forEach(([x, y]) => {
        const sx = x * scaleX;
        const sy = y * scaleY;
        ctx.beginPath();
        ctx.arc(sx, sy, 3, 0, 2 * Math.PI);
        ctx.fill();
    });
}

/**
 * Clear canvas
 */
function clearCanvas() {
    if (ctx) {
        ctx.clearRect(0, 0, videoCanvas.width, videoCanvas.height);
    }
}

/**
 * Update canvas size
 */
function updateCanvasSize() {
    if (videoCanvas && videoFeed) {
        const rect = videoFeed.getBoundingClientRect();
        videoCanvas.width = rect.width;
        videoCanvas.height = rect.height;
    }
}

/**
 * Start duration timer
 */
function startDurationTimer() {
    durationInterval = setInterval(() => {
        if (startTime) {
            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            duration.textContent = `${elapsed}s`;
        }
    }, 1000);
}

/**
 * Update status
 */
function updateStatus(state) {
    statusIndicator.className = `status-indicator ${state}`;
    statusText.textContent = state === 'recording' ? 'Recording' : 'Stopped';
}

// Update canvas on resize
window.addEventListener('resize', () => {
    if (isRecording) {
        updateCanvasSize();
        if (currentBbox) {
            drawBoundingBox(currentBbox, currentEmotion, currentConfidence);
        }
    }
});
