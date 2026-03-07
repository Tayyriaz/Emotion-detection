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
        
        console.log('Video elements found:', {
            video: !!this.video,
            canvas: !!this.canvas,
            startBtn: !!this.startBtn,
            stopBtn: !!this.stopBtn
        });
        
        this.stream = null;
        this.ws = null;
        this.isRunning = false;
        this.frameInterval = null;
        this.currentBbox = null;  // Current bounding box
        this.ctx = null;
        
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
        
        // Draw bounding box
        this.ctx.strokeStyle = '#3b82f6';  // Blue color
        this.ctx.lineWidth = 3;
        this.ctx.setLineDash([]);
        this.ctx.strokeRect(scaledX1, scaledY1, width, height);
        
        // Draw label background
        const labelText = `${emotion.charAt(0).toUpperCase() + emotion.slice(1)} (${(confidence * 100).toFixed(0)}%)`;
        this.ctx.font = 'bold 14px Arial';
        const textMetrics = this.ctx.measureText(labelText);
        const textWidth = textMetrics.width;
        const textHeight = 20;
        
        // Label background
        this.ctx.fillStyle = 'rgba(59, 130, 246, 0.9)';
        this.ctx.fillRect(scaledX1, scaledY1 - textHeight - 4, textWidth + 8, textHeight);
        
        // Label text
        this.ctx.fillStyle = '#ffffff';
        this.ctx.fillText(labelText, scaledX1 + 4, scaledY1 - 8);
        
        this.currentBbox = bbox;
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
            // Request camera access
            this.stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width: { ideal: 640 },
                    height: { ideal: 480 },
                    facingMode: 'user'
                }
            });
            
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
            
            // Connect WebSocket
            await this.connectWebSocket();
            
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
            if (this.videoResult) {
                this.videoResult.style.display = 'block';
            }
            if (this.videoEmptyState) {
                this.videoEmptyState.style.display = 'none';
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
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${protocol}//${window.location.host}/video/emotion`;
            
            this.ws = new WebSocket(wsUrl);
            
            this.ws.onopen = () => {
                console.log('WebSocket connected');
                resolve();
            };
            
            this.ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    this.handleMessage(data);
                } catch (error) {
                    console.error('Failed to parse WebSocket message:', error);
                }
            };
            
            this.ws.onerror = (error) => {
                console.error('WebSocket error:', error);
                this.showError('Connection error. Please try again.');
                reject(error);
            };
            
            this.ws.onclose = () => {
                console.log('WebSocket disconnected');
                
                if (this.isRunning) {
                    // Try to reconnect after 2 seconds
                    setTimeout(() => {
                        if (this.isRunning) {
                            this.connectWebSocket().catch(console.error);
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
        const canvas = document.createElement('canvas');
        canvas.width = this.video.videoWidth;
        canvas.height = this.video.videoHeight;
        
        const ctx = canvas.getContext('2d');
        ctx.drawImage(this.video, 0, 0);
        
        // Convert to base64 JPEG (quality 0.8 for smaller size)
        const imageData = canvas.toDataURL('image/jpeg', 0.8);
        
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
            if (data.success && data.face_detected) {
                // Update emotion display
                const emotion = data.emotion || 'neutral';
                const confidence = data.confidence || 0;
                const bbox = data.face_bbox;  // [x1, y1, x2, y2]
                
                // Use shared utility to display emotion result
                this.Utils.displayEmotionResult(data, {
                    icon: this.videoEmotionIcon,
                    label: this.videoEmotionLabel,
                    confidenceFill: this.videoConfidenceFill,
                    confidence: this.videoConfidence,
                    statusText: this.videoStatusText,
                    result: this.videoResult,
                    emptyState: this.videoEmptyState
                });
                
                // Draw bounding box if available
                if (bbox && Array.isArray(bbox) && bbox.length === 4) {
                    this.drawBoundingBox(bbox, emotion, confidence);
                } else {
                    this.clearBoundingBox();
                }
                
                // Animate icon
                this.videoEmotionIcon.style.animation = 'none';
                setTimeout(() => {
                    this.videoEmotionIcon.style.animation = 'bounceIn 0.3s ease';
                }, 10);
            } else {
                // No face detected
                this.videoEmotionIcon.textContent = '😐';
                this.videoEmotionLabel.textContent = 'No Face';
                this.videoConfidenceFill.style.width = '0%';
                this.videoConfidence.textContent = '0%';
                this.videoStatus.textContent = 'Waiting for face...';
                this.clearBoundingBox();
            }
        }
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
            this.ws.send(JSON.stringify({ type: 'stop' }));
            this.ws.close();
            this.ws = null;
        }
        
        // Stop camera stream
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }
        
        this.video.srcObject = null;
        
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
