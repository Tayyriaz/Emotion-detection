/**
 * Live Webcam Emotion Detection
 * 
 * Captures webcam video, sends frames to backend via WebSocket,
 * and displays real-time emotion updates.
 */

class VideoEmotionDetector {
    constructor() {
        console.log('VideoEmotionDetector constructor called');
        // Get elements using unified structure IDs
        this.video = document.getElementById('videoStream');
        this.canvas = document.getElementById('videoCanvas');
        this.videoPlaceholder = document.getElementById('videoPlaceholder');
        this.startBtn = document.getElementById('startCameraBtn');
        this.stopBtn = document.getElementById('stopCameraBtn');
        this.videoResult = document.getElementById('videoResult');
        this.videoEmptyState = document.getElementById('videoEmptyState');
        this.videoEmotionIcon = document.getElementById('videoEmotionIcon');
        this.videoEmotionLabel = document.getElementById('videoEmotionLabel');
        this.videoConfidenceFill = document.getElementById('videoConfidenceFill');
        this.videoConfidence = document.getElementById('videoConfidence');
        this.videoStatusText = document.getElementById('videoStatusText');
        this.errorMessage = document.getElementById('errorMessage');
        this.videoHistogramContainer = document.getElementById('videoHistogramContainer');
        this.videoStackedHistogram = document.getElementById('videoStackedHistogram');
        this.showLandmarksToggle = document.getElementById('showLandmarksToggle');
        
        console.log('Video elements found:', {
            video: !!this.video,
            canvas: !!this.canvas,
            startBtn: !!this.startBtn,
            stopBtn: !!this.stopBtn,
            histogramContainer: !!this.videoHistogramContainer,
            landmarksToggle: !!this.showLandmarksToggle
        });
        
        this.stream = null;
        this.ws = null;
        this.isRunning = false;
        this.frameInterval = null;
        this.currentBbox = null;  // Current bounding box
        this.currentEmotions = {};  // Current emotion distribution
        this.showLandmarks = false;  // Facial landmarks overlay flag
        this.ctx = null;
        
        // Smoothing buffers for stable video classification
        this.emotionHistory = [];  // Last N emotion predictions
        this.confidenceHistory = [];  // Last N confidence scores
        this.emotionsHistory = [];  // Last N emotion distributions
        this.maxHistorySize = 5;  // Keep last 5 predictions for smoothing
        
        // Use shared utilities
        this.Utils = typeof SharedUtils !== 'undefined' ? SharedUtils : {
            EMOTION_EMOJIS: {
                'anger': '😠', 'contempt': '😤', 'disgust': '🤢', 'fear': '😨',
                'happiness': '😊', 'neutral': '😐', 'sadness': '😢', 'surprise': '😲'
            },
            showError: () => {},
            hideError: () => {},
            displayEmotionResult: () => {},
            showEmptyState: () => {}
        };
        
        // Setup canvas context
        if (this.canvas) {
            this.ctx = this.canvas.getContext('2d');
        }
        
        // Setup landmarks toggle listener
        if (this.showLandmarksToggle) {
            this.showLandmarksToggle.addEventListener('change', (e) => {
                this.showLandmarks = e.target.checked;
                if (this.currentBbox && this.showLandmarks) {
                    this.drawFacialLandmarks(this.currentBbox);
                } else {
                    this.clearCanvas();
                    if (this.currentBbox) {
                        const emotion = this.videoEmotionLabel ? this.videoEmotionLabel.textContent.toLowerCase() : 'neutral';
                        const confidence = parseFloat(this.videoConfidence ? this.videoConfidence.textContent.replace('Confidence: ', '').replace('%', '') : '0') / 100;
                        this.drawBoundingBox(this.currentBbox, emotion, confidence);
                    }
                }
            });
        }
        
        this.setupEventListeners();
    }
    
    setupCanvasOverlay() {
        // Create canvas overlay for drawing bounding boxes
        const videoWrapper = this.video.parentElement;
        if (!videoWrapper) return;
        
        // Check if canvas already exists
        let canvas = videoWrapper.querySelector('.bbox-canvas');
        if (!canvas) {
            canvas = document.createElement('canvas');
            canvas.className = 'bbox-canvas';
            canvas.style.position = 'absolute';
            canvas.style.top = '0';
            canvas.style.left = '0';
            canvas.style.width = '100%';
            canvas.style.height = '100%';
            canvas.style.pointerEvents = 'none';
            canvas.style.zIndex = '10';
            videoWrapper.style.position = 'relative';
            videoWrapper.appendChild(canvas);
        }
        
        this.bboxCanvas = canvas;
        this.bboxCtx = canvas.getContext('2d');
        
        // Update canvas size when video loads
        this.video.addEventListener('loadedmetadata', () => {
            this.updateCanvasSize();
        });
        
        // Update canvas size on window resize
        window.addEventListener('resize', () => {
            if (this.isRunning) {
                this.updateCanvasSize();
                // Redraw bounding box if exists
                if (this.currentBbox) {
                    // Get last emotion and confidence from display
                    const emotion = this.videoEmotionLabel.textContent.toLowerCase();
                    const confidence = parseFloat(this.videoConfidence.textContent) / 100;
                    this.drawBoundingBox(this.currentBbox, emotion, confidence);
                }
            }
        });
    }
    
    updateCanvasSize() {
        if (!this.bboxCanvas || !this.video) return;
        
        const rect = this.video.getBoundingClientRect();
        this.bboxCanvas.width = rect.width;
        this.bboxCanvas.height = rect.height;
    }
    
    drawBoundingBox(bbox, emotion, confidence) {
        if (!this.bboxCtx || !bbox || bbox.length !== 4) {
            this.clearBoundingBox();
            return;
        }
        
        // Get video dimensions
        const videoRect = this.video.getBoundingClientRect();
        const videoWidth = this.video.videoWidth;
        const videoHeight = this.video.videoHeight;
        
        if (videoWidth === 0 || videoHeight === 0) return;
        
        // Calculate scale factors
        const scaleX = videoRect.width / videoWidth;
        const scaleY = videoRect.height / videoHeight;
        
        // Extract bounding box coordinates (x1, y1, x2, y2)
        const [x1, y1, x2, y2] = bbox;
        
        // Scale to canvas size
        const scaledX1 = x1 * scaleX;
        const scaledY1 = y1 * scaleY;
        const scaledX2 = x2 * scaleX;
        const scaledY2 = y2 * scaleY;
        
        const width = scaledX2 - scaledX1;
        const height = scaledY2 - scaledY1;
        
        // Clear previous drawing
        this.clearCanvas();
        
        // Use bboxCtx for bounding box canvas (overlay canvas)
        const ctx = this.bboxCtx || this.ctx;
        if (!ctx) return;
        
        // Draw bounding box
        ctx.strokeStyle = '#3b82f6';  // Blue color
        ctx.lineWidth = 3;
        ctx.setLineDash([]);
        ctx.strokeRect(scaledX1, scaledY1, width, height);
        
        // Draw facial landmarks if enabled
        if (this.showLandmarks) {
            this.drawFacialLandmarks(bbox, scaleX, scaleY);
        }
        
        // Draw label background
        const labelText = `${emotion.charAt(0).toUpperCase() + emotion.slice(1)} (${(confidence * 100).toFixed(0)}%)`;
        ctx.font = 'bold 14px Arial';
        const textMetrics = ctx.measureText(labelText);
        const textWidth = textMetrics.width;
        const textHeight = 20;
        
        // Label background
        ctx.fillStyle = 'rgba(59, 130, 246, 0.9)';
        ctx.fillRect(scaledX1, scaledY1 - textHeight - 4, textWidth + 8, textHeight);
        
        // Label text
        ctx.fillStyle = '#ffffff';
        ctx.fillText(labelText, scaledX1 + 4, scaledY1 - 8);
        
        this.currentBbox = bbox;
    }
    
    drawFacialLandmarks(bbox, scaleX, scaleY) {
        if (!this.bboxCtx || !bbox || bbox.length !== 4) return;
        
        const ctx = this.bboxCtx || this.ctx;
        if (!ctx) return;
        
        // Get video dimensions
        const videoRect = this.video.getBoundingClientRect();
        const videoWidth = this.video.videoWidth;
        const videoHeight = this.video.videoHeight;
        
        if (videoWidth === 0 || videoHeight === 0) return;
        
        // Use provided scale factors or calculate
        if (!scaleX || !scaleY) {
            scaleX = videoRect.width / videoWidth;
            scaleY = videoRect.height / videoHeight;
        }
        
        const [x1, y1, x2, y2] = bbox;
        const width = x2 - x1;
        const height = y2 - y1;
        
        // Scale coordinates
        const scaledX1 = x1 * scaleX;
        const scaledY1 = y1 * scaleY;
        const scaledWidth = width * scaleX;
        const scaledHeight = height * scaleY;
        
        // Estimate facial landmark positions (68-point model approximation)
        // These are estimated positions based on face bounding box
        // In production, use dlib/mediapipe for accurate landmarks
        const landmarks = this.estimateFacialLandmarks(scaledX1, scaledY1, scaledWidth, scaledHeight);
        
        // Draw landmarks
        ctx.fillStyle = '#10b981';  // Green color for landmarks
        ctx.strokeStyle = '#10b981';
        ctx.lineWidth = 2;
        
        landmarks.forEach((point, index) => {
            const [x, y] = point;
            
            // Draw point
            ctx.beginPath();
            ctx.arc(x, y, 3, 0, 2 * Math.PI);
            ctx.fill();
            
            // Draw connections for key facial features
            if (index < landmarks.length - 1) {
                const nextPoint = landmarks[index + 1];
                // Only draw connections for certain landmark groups
                if (this.shouldConnectLandmarks(index, landmarks.length)) {
                    ctx.beginPath();
                    ctx.moveTo(x, y);
                    ctx.lineTo(nextPoint[0], nextPoint[1]);
                    ctx.stroke();
                }
            }
        });
    }
    
    estimateFacialLandmarks(x, y, width, height) {
        // Estimate 68 facial landmarks based on bounding box
        // This is a simplified estimation - for production, use dlib/mediapipe
        const landmarks = [];
        const centerX = x + width / 2;
        const centerY = y + height / 2;
        
        // Face outline (17 points)
        for (let i = 0; i < 17; i++) {
            const angle = (Math.PI * i) / 16;
            const radiusX = width / 2;
            const radiusY = height / 2;
            landmarks.push([
                centerX + radiusX * Math.cos(angle),
                y + radiusY * (0.3 + 0.7 * Math.sin(angle))
            ]);
        }
        
        // Right eyebrow (5 points)
        for (let i = 0; i < 5; i++) {
            landmarks.push([
                x + width * (0.25 + i * 0.1),
                y + height * 0.25
            ]);
        }
        
        // Left eyebrow (5 points)
        for (let i = 0; i < 5; i++) {
            landmarks.push([
                x + width * (0.45 + i * 0.1),
                y + height * 0.25
            ]);
        }
        
        // Nose (9 points)
        for (let i = 0; i < 3; i++) {
            landmarks.push([
                centerX - width * 0.05 + i * width * 0.05,
                y + height * 0.4
            ]);
        }
        for (let i = 0; i < 3; i++) {
            landmarks.push([
                centerX - width * 0.05 + i * width * 0.05,
                y + height * 0.5
            ]);
        }
        for (let i = 0; i < 3; i++) {
            landmarks.push([
                centerX - width * 0.05 + i * width * 0.05,
                y + height * 0.6
            ]);
        }
        
        // Right eye (6 points)
        const rightEyeX = x + width * 0.3;
        const rightEyeY = y + height * 0.35;
        const eyeWidth = width * 0.15;
        const eyeHeight = height * 0.1;
        for (let i = 0; i < 6; i++) {
            const angle = (2 * Math.PI * i) / 6;
            landmarks.push([
                rightEyeX + eyeWidth / 2 * Math.cos(angle),
                rightEyeY + eyeHeight / 2 * Math.sin(angle)
            ]);
        }
        
        // Left eye (6 points)
        const leftEyeX = x + width * 0.7;
        const leftEyeY = y + height * 0.35;
        for (let i = 0; i < 6; i++) {
            const angle = (2 * Math.PI * i) / 6;
            landmarks.push([
                leftEyeX + eyeWidth / 2 * Math.cos(angle),
                leftEyeY + eyeHeight / 2 * Math.sin(angle)
            ]);
        }
        
        // Mouth (20 points)
        const mouthX = centerX;
        const mouthY = y + height * 0.7;
        const mouthWidth = width * 0.3;
        const mouthHeight = height * 0.15;
        for (let i = 0; i < 10; i++) {
            const t = i / 9;
            landmarks.push([
                mouthX - mouthWidth / 2 + mouthWidth * t,
                mouthY - mouthHeight / 2
            ]);
        }
        for (let i = 0; i < 10; i++) {
            const t = i / 9;
            landmarks.push([
                mouthX - mouthWidth / 2 + mouthWidth * t,
                mouthY + mouthHeight / 2
            ]);
        }
        
        return landmarks;
    }
    
    shouldConnectLandmarks(index, total) {
        // Define which landmarks should be connected
        // Face outline
        if (index < 16) return true;
        // Eyebrows
        if (index >= 17 && index < 26) return (index - 17) % 4 !== 3;
        // Nose
        if (index >= 27 && index < 35) return (index - 27) % 3 !== 2;
        // Eyes - connect in circle
        if (index >= 36 && index < 47) return true;
        // Mouth - connect outer and inner
        if (index >= 48 && index < 67) return (index - 48) < 9 || (index - 48) >= 9;
        return false;
    }
    
    clearCanvas() {
        // Clear bounding box canvas
        if (this.bboxCtx && this.bboxCanvas) {
            this.bboxCtx.clearRect(0, 0, this.bboxCanvas.width, this.bboxCanvas.height);
        }
        // Also clear main canvas if it exists
        if (this.ctx && this.canvas) {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        }
    }
    
    clearBoundingBox() {
        this.currentBbox = null;
        this.clearCanvas();
    }
    
    setupEventListeners() {
        console.log('Setting up video event listeners...', {
            startBtn: !!this.startBtn,
            stopBtn: !!this.stopBtn,
            video: !!this.video,
            canvas: !!this.canvas
        });
        
        if (this.startBtn) {
            this.startBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                console.log('Start camera button clicked');
                this.start();
            });
            console.log('Start button listener attached');
        } else {
            console.error('Start camera button not found!');
        }
        
        if (this.stopBtn) {
            this.stopBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                console.log('Stop camera button clicked');
                this.stop();
            });
            console.log('Stop button listener attached');
        } else {
            console.error('Stop camera button not found!');
        }
        
        // Update canvas size when video loads
        if (this.video) {
            this.video.addEventListener('loadedmetadata', () => {
                this.updateCanvasSize();
            });
        }
        
        // Update canvas size on window resize
        window.addEventListener('resize', () => {
            if (this.isRunning) {
                this.updateCanvasSize();
                // Redraw bounding box if exists
                if (this.currentBbox && this.videoEmotionLabel) {
                    const emotion = this.videoEmotionLabel.textContent.toLowerCase();
                    const confidenceText = this.videoConfidence ? this.videoConfidence.textContent.replace('Confidence: ', '').replace('%', '') : '0';
                    const confidence = parseFloat(confidenceText) / 100;
                    this.drawBoundingBox(this.currentBbox, emotion, confidence);
                }
            }
        });
    }
    
    async start() {
        try {
            // Request camera access with better error handling
            try {
                this.stream = await navigator.mediaDevices.getUserMedia({
                    video: {
                        width: { ideal: 640 },
                        height: { ideal: 480 },
                        facingMode: 'user'
                    }
                });
            } catch (error) {
                // Handle permission errors specifically
                if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
                    throw new Error('Camera permission denied. Please allow camera access in your browser settings and refresh the page.');
                } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
                    throw new Error('No camera found. Please connect a camera and try again.');
                } else if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
                    throw new Error('Camera is already in use by another application. Please close other applications using the camera.');
                } else if (error.name === 'OverconstrainedError' || error.name === 'ConstraintNotSatisfiedError') {
                    throw new Error('Camera does not support the required settings. Trying with default settings...');
                } else {
                    throw new Error(`Camera access failed: ${error.message || 'Unknown error'}`);
                }
            }
            
            this.video.srcObject = this.stream;
            await this.video.play();
            
            // Hide placeholder and show video
            if (this.videoPlaceholder) {
                this.videoPlaceholder.style.display = 'none';
            }
            if (this.video) {
                this.video.style.display = 'block';
            }
            
            // Update canvas size
            this.updateCanvasSize();
            
            // Connect WebSocket (with retry on failure)
            try {
                await this.connectWebSocket();
            } catch (error) {
                console.error('Failed to connect WebSocket:', error);
                this.showError('Failed to connect to server. Please refresh and try again.');
                // Stop camera if WebSocket fails
                if (this.stream) {
                    this.stream.getTracks().forEach(track => track.stop());
                    this.stream = null;
                }
                if (this.video) {
                    this.video.srcObject = null;
                }
                throw error; // Re-throw to prevent starting frame capture
            }
            
            // Verify WebSocket is connected before starting frame capture
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                throw new Error('WebSocket not connected');
            }
            
            // Start frame capture
            this.isRunning = true;
            if (this.startBtn) {
                this.startBtn.disabled = true;
                this.startBtn.style.display = 'none';
            }
            if (this.stopBtn) {
                this.stopBtn.disabled = false;
                this.stopBtn.style.display = 'block';
            }
            
            // Show result section immediately and keep it visible
            if (this.videoResult) {
                this.videoResult.style.display = 'block';
            }
            if (this.videoEmptyState) {
                this.videoEmptyState.style.display = 'none';
            }
            
            // Initialize result display with "waiting" state
            if (this.videoEmotionIcon) {
                this.videoEmotionIcon.textContent = '⏳';
            }
            if (this.videoEmotionLabel) {
                this.videoEmotionLabel.textContent = 'Analyzing...';
            }
            if (this.videoConfidenceFill) {
                this.videoConfidenceFill.style.width = '0%';
            }
            if (this.videoConfidence) {
                this.videoConfidence.textContent = 'Confidence: 0%';
            }
            if (this.videoStatusText) {
                this.videoStatusText.textContent = 'Waiting...';
            }
            
            this.hideError();
            
            // Capture frames at ~10 FPS (every 100ms)
            this.frameInterval = setInterval(() => {
                if (this.isRunning && this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.captureFrame();
                }
            }, 100);
            
        } catch (error) {
            this.showError(`Failed to access camera: ${error.message}`);
            console.error('Camera error:', error);
        }
    }
    
    async connectWebSocket() {
        return new Promise((resolve, reject) => {
            // Ensure WSS protocol on HTTPS (required for Render)
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${protocol}//${window.location.host}/video/emotion`;
            
            console.log('Connecting WebSocket to:', wsUrl);
            
            // Connection timeout (10 seconds)
            const connectionTimeout = setTimeout(() => {
                if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
                    console.error('WebSocket connection timeout');
                    this.ws.close();
                    reject(new Error('Connection timeout. Please check your internet connection.'));
                }
            }, 10000);
            
            this.ws = new WebSocket(wsUrl);
            
            this.ws.onopen = () => {
                console.log('✅ WebSocket connected successfully');
                clearTimeout(connectionTimeout);
                resolve();
            };
            
            this.ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    
                    // Handle ping/pong for keepalive
                    if (data.type === 'ping') {
                        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                            this.ws.send(JSON.stringify({ type: 'pong' }));
                        }
                        return;
                    }
                    
                    this.handleMessage(data);
                } catch (error) {
                    console.error('Failed to parse WebSocket message:', error);
                }
            };
            
            this.ws.onerror = (error) => {
                console.error('❌ WebSocket error:', error);
                clearTimeout(connectionTimeout);
                
                // More specific error messages
                const errorMsg = 'WebSocket connection failed. ';
                if (window.location.protocol === 'https:' && wsUrl.startsWith('ws://')) {
                    this.showError(errorMsg + 'HTTPS requires WSS protocol.');
                } else {
                    this.showError(errorMsg + 'Please check your connection and try again.');
                }
                reject(error);
            };
            
            this.ws.onclose = (event) => {
                console.log('WebSocket disconnected:', {
                    code: event.code,
                    reason: event.reason,
                    wasClean: event.wasClean
                });
                clearTimeout(connectionTimeout);
                
                // Only auto-reconnect if it was an unexpected close and we're still running
                if (this.isRunning && event.code !== 1000) {
                    console.log('Attempting to reconnect in 2 seconds...');
                    setTimeout(() => {
                        if (this.isRunning && (!this.ws || this.ws.readyState === WebSocket.CLOSED)) {
                            this.connectWebSocket().catch((err) => {
                                console.error('Reconnection failed:', err);
                                this.showError('Failed to reconnect. Please refresh the page.');
                            });
                        }
                    }, 2000);
                }
            };
        });
    }
    
    captureFrame() {
        if (!this.video || this.video.readyState !== this.video.HAVE_ENOUGH_DATA) {
            return;
        }
        
        // Create canvas to capture frame
        // Reduce size for faster processing on slow CPU (max 320x240)
        const maxWidth = 320;
        const maxHeight = 240;
        const videoWidth = this.video.videoWidth;
        const videoHeight = this.video.videoHeight;
        
        // Calculate scaled dimensions maintaining aspect ratio
        let canvasWidth = videoWidth;
        let canvasHeight = videoHeight;
        if (videoWidth > maxWidth || videoHeight > maxHeight) {
            const scale = Math.min(maxWidth / videoWidth, maxHeight / videoHeight);
            canvasWidth = Math.floor(videoWidth * scale);
            canvasHeight = Math.floor(videoHeight * scale);
        }
        
        const canvas = document.createElement('canvas');
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;
        
        const ctx = canvas.getContext('2d');
        ctx.drawImage(this.video, 0, 0, canvasWidth, canvasHeight);
        
        // Convert to base64 JPEG (quality 0.6 for faster processing and smaller size)
        // Lower quality + smaller size = faster transmission and processing on slow CPU
        const imageData = canvas.toDataURL('image/jpeg', 0.6);
        
        // Send to server
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                type: 'frame',
                image: imageData
            }));
        }
    }
    
    handleMessage(data) {
        if (data.type === 'error') {
            this.showError(data.message || 'Unknown error');
            return;
        }
        
        if (data.type === 'emotion') {
            // Ensure result section is always visible when receiving updates
            if (this.videoResult) {
                this.videoResult.style.display = 'block';
            }
            if (this.videoEmptyState) {
                this.videoEmptyState.style.display = 'none';
            }
            
            if (data.success && data.face_detected) {
                // Update emotion display
                let emotion = data.emotion || 'neutral';
                let confidence = data.confidence || 0;
                const bbox = data.face_bbox;  // [x1, y1, x2, y2]
                let emotions = data.emotions || {};  // All emotion confidences
                
                // Apply smoothing for stable video classification
                const smoothed = this.applySmoothing(emotion, confidence, emotions);
                emotion = smoothed.emotion;
                confidence = smoothed.confidence;
                emotions = smoothed.emotions;
                
                // Store current emotions for histogram
                this.currentEmotions = emotions;
                
                // Update stacked histogram
                this.updateStackedHistogram(emotions);
                
                // Use shared utility to display emotion result
                if (this.Utils && this.Utils.displayEmotionResult) {
                    this.Utils.displayEmotionResult(data, {
                        icon: this.videoEmotionIcon,
                        label: this.videoEmotionLabel,
                        confidenceFill: this.videoConfidenceFill,
                        confidence: this.videoConfidence,
                        statusText: this.videoStatusText,
                        result: this.videoResult,
                        emptyState: this.videoEmptyState
                    });
                } else {
                    // Fallback if SharedUtils not available
                    if (this.videoEmotionIcon) {
                        this.videoEmotionIcon.textContent = this.Utils.EMOTION_EMOJIS[emotion] || '😐';
                    }
                    if (this.videoEmotionLabel) {
                        this.videoEmotionLabel.textContent = emotion.charAt(0).toUpperCase() + emotion.slice(1);
                    }
                    if (this.videoConfidenceFill) {
                        this.videoConfidenceFill.style.width = `${(confidence * 100)}%`;
                    }
                    if (this.videoConfidence) {
                        this.videoConfidence.textContent = `Confidence: ${(confidence * 100).toFixed(1)}%`;
                    }
                    if (this.videoStatusText) {
                        this.videoStatusText.textContent = '✓ Detected';
                    }
                }
                
                // Draw bounding box if available
                if (bbox && Array.isArray(bbox) && bbox.length === 4) {
                    this.currentBbox = bbox;  // Store for redraw on resize
                    this.drawBoundingBox(bbox, emotion, confidence);
                } else {
                    this.currentBbox = null;
                    this.clearBoundingBox();
                }
                
                // Animate icon (only if element exists)
                if (this.videoEmotionIcon) {
                    this.videoEmotionIcon.style.animation = 'none';
                    setTimeout(() => {
                        if (this.videoEmotionIcon) {
                            this.videoEmotionIcon.style.animation = 'bounceIn 0.3s ease';
                        }
                    }, 10);
                }
            } else {
                // No face detected - show result but with "no face" message
                if (this.videoEmotionIcon) {
                    this.videoEmotionIcon.textContent = '😐';
                }
                if (this.videoEmotionLabel) {
                    this.videoEmotionLabel.textContent = 'No Face Detected';
                }
                if (this.videoConfidenceFill) {
                    this.videoConfidenceFill.style.width = '0%';
                }
                if (this.videoConfidence) {
                    this.videoConfidence.textContent = 'Confidence: 0%';
                }
                if (this.videoStatusText) {
                    this.videoStatusText.textContent = 'Waiting for face...';
                }
                
                // Keep result section visible but show "no face" state
                if (this.videoResult) {
                    this.videoResult.style.display = 'block';
                }
                if (this.videoEmptyState) {
                    this.videoEmptyState.style.display = 'none';
                }
                
                this.clearBoundingBox();
                // Hide histogram when no face detected
                if (this.videoHistogramContainer) {
                    this.videoHistogramContainer.style.display = 'none';
                }
            }
        }
    }
    
    applySmoothing(emotion, confidence, emotions) {
        // Add current prediction to history
        this.emotionHistory.push(emotion);
        this.confidenceHistory.push(confidence);
        this.emotionsHistory.push(emotions);
        
        // Keep only last N predictions
        if (this.emotionHistory.length > this.maxHistorySize) {
            this.emotionHistory.shift();
            this.confidenceHistory.shift();
            this.emotionsHistory.shift();
        }
        
        // Need at least 2 predictions for smoothing
        if (this.emotionHistory.length < 2) {
            return { emotion, confidence, emotions };
        }
        
        // Count emotion occurrences (majority voting)
        const emotionCounts = {};
        this.emotionHistory.forEach(e => {
            emotionCounts[e] = (emotionCounts[e] || 0) + 1;
        });
        
        // Get most frequent emotion
        let smoothedEmotion = emotion;
        let maxCount = 0;
        Object.entries(emotionCounts).forEach(([e, count]) => {
            if (count > maxCount) {
                maxCount = count;
                smoothedEmotion = e;
            }
        });
        
        // Average confidence
        const avgConfidence = this.confidenceHistory.reduce((a, b) => a + b, 0) / this.confidenceHistory.length;
        
        // Average emotion distributions
        const smoothedEmotions = {};
        const emotionKeys = Object.keys(emotions);
        emotionKeys.forEach(key => {
            const values = this.emotionsHistory.map(e => e[key] || 0);
            smoothedEmotions[key] = values.reduce((a, b) => a + b, 0) / values.length;
        });
        
        return {
            emotion: smoothedEmotion,
            confidence: avgConfidence,
            emotions: smoothedEmotions
        };
    }
    
    updateStackedHistogram(emotions) {
        if (!this.videoStackedHistogram || !emotions || Object.keys(emotions).length === 0) {
            if (this.videoHistogramContainer) {
                this.videoHistogramContainer.style.display = 'none';
            }
            return;
        }
        
        // Show histogram container
        if (this.videoHistogramContainer) {
            this.videoHistogramContainer.style.display = 'block';
        }
        
        // Sort emotions by confidence (descending)
        const sortedEmotions = Object.entries(emotions)
            .map(([emotion, confidence]) => ({
                emotion: emotion.toLowerCase(),
                confidence: Math.max(0, Math.min(1, confidence))  // Clamp between 0 and 1
            }))
            .sort((a, b) => b.confidence - a.confidence);
        
        // Clear existing histogram
        this.videoStackedHistogram.innerHTML = '';
        
        // Create stacked bar
        const barContainer = document.createElement('div');
        barContainer.className = 'histogram-bar';
        
        let cumulativeWidth = 0;
        sortedEmotions.forEach(({ emotion, confidence }) => {
            if (confidence > 0.01) {  // Only show emotions with >1% confidence
                const segment = document.createElement('div');
                segment.className = `histogram-segment ${emotion}`;
                const widthPercent = confidence * 100;
                segment.style.width = `${widthPercent}%`;
                
                // Add label and value
                const label = document.createElement('span');
                label.className = 'histogram-label';
                label.textContent = emotion.charAt(0).toUpperCase() + emotion.slice(1);
                
                const value = document.createElement('span');
                value.className = 'histogram-value';
                value.textContent = `${(confidence * 100).toFixed(1)}%`;
                
                segment.appendChild(label);
                segment.appendChild(value);
                barContainer.appendChild(segment);
                cumulativeWidth += widthPercent;
            }
        });
        
        // If no segments, show message
        if (barContainer.children.length === 0) {
            const noDataMsg = document.createElement('div');
            noDataMsg.className = 'histogram-segment';
            noDataMsg.style.width = '100%';
            noDataMsg.style.justifyContent = 'center';
            noDataMsg.textContent = 'No emotion data available';
            barContainer.appendChild(noDataMsg);
        }
        
        this.videoStackedHistogram.appendChild(barContainer);
    }
    
    stop() {
        this.isRunning = false;
        
        // Stop frame capture
        if (this.frameInterval) {
            clearInterval(this.frameInterval);
            this.frameInterval = null;
        }
        
        // Close WebSocket
        if (this.ws) {
            try {
                this.ws.send(JSON.stringify({ type: 'stop' }));
            } catch (e) {
                // Ignore send errors when closing
            }
            this.ws.close();
            this.ws = null;
        }
        
        // Stop camera stream
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }
        
        this.video.srcObject = null;
        
        // Clear smoothing history
        this.emotionHistory = [];
        this.confidenceHistory = [];
        this.emotionsHistory = [];
        
        // Show placeholder if it exists
        if (this.videoPlaceholder) {
            this.videoPlaceholder.style.display = 'flex';
        }
        if (this.video) {
            this.video.style.display = 'none';
        }
        
        if (this.startBtn) {
            this.startBtn.disabled = false;
            this.startBtn.style.display = 'block';
        }
        if (this.stopBtn) {
            this.stopBtn.disabled = true;
            this.stopBtn.style.display = 'none';
        }
        if (this.videoResult) {
            this.videoResult.style.display = 'none';
        }
        if (this.videoHistogramContainer) {
            this.videoHistogramContainer.style.display = 'none';
        }
        this.clearBoundingBox();
    }
    
    showError(message) {
        if (this.errorMessage) {
            this.Utils.showError(message, this.errorMessage);
        }
    }
    
    hideError() {
        if (this.errorMessage) {
            this.Utils.hideError(this.errorMessage);
        }
    }
}

// Export for unified app
window.VideoEmotionDetector = VideoEmotionDetector;
