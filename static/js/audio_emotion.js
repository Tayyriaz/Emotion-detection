/**
 * Audio Emotion Detection
 * Handles audio recording, file upload, and emotion analysis
 */

(function() {
    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
    
    function init() {
    console.log('Audio emotion detection initializing...');
    const API_ENDPOINT = '/audio/emotion';
    
    // Get elements - Unified Interface
    const fileInput = document.getElementById('audioFileInput');
    const uploadArea = document.getElementById('audioUploadArea');
    
    console.log('Audio elements found:', {
        fileInput: !!fileInput,
        uploadArea: !!uploadArea,
        recordBtn: !!document.getElementById('audioRecordBtn')
    });
    const audioDefaultContent = document.getElementById('audioDefaultContent');
    const audioWavesContainer = document.getElementById('audioWavesContainer');
    const recordedAudioPreview = document.getElementById('recordedAudioPreview');
    const recordedAudioPlayer = document.getElementById('recordedAudioPlayer');
    const uploadRecordedBtn = document.getElementById('uploadRecordedBtn');
    const recordAgainBtn = document.getElementById('recordAgainBtn');
    const recordBtn = document.getElementById('audioRecordBtn');
    const audioResult = document.getElementById('audioResult');
    const audioEmptyState = document.getElementById('audioEmptyState');
    const audioEmotionIcon = document.getElementById('audioEmotionIcon');
    const audioEmotionLabel = document.getElementById('audioEmotionLabel');
    const audioConfidenceFill = document.getElementById('audioConfidenceFill');
    const audioConfidence = document.getElementById('audioConfidence');
    const audioStatus = document.getElementById('audioStatus');
    const audioStatusText = document.getElementById('audioStatusText');
    const errorMessage = document.getElementById('errorMessage');
    
    let mediaRecorder = null;
    let audioChunks = [];
    let isRecording = false;
    let recordedAudioBlob = null;
    let currentStream = null;
    
    // Use shared utilities
    const Utils = typeof SharedUtils !== 'undefined' ? SharedUtils : {
        EMOTION_EMOJIS: {
            'anger': '😠', 'contempt': '😤', 'disgust': '🤢', 'fear': '😨',
            'happiness': '😊', 'neutral': '😐', 'sadness': '😢', 'surprise': '😲'
        },
        showError: (msg, el) => {
            if (el) { el.textContent = msg; el.style.display = 'block'; }
        },
        hideError: (el) => { if (el) el.style.display = 'none'; },
        displayEmotionResult: () => {},
        showLoading: () => {},
        showEmptyState: () => {}
    };
    
    function showError(message) {
        const errEl = document.getElementById('errorMessage');
        if (errEl) {
            Utils.showError(message, errEl);
        } else {
            console.error('Error:', message);
        }
    }
    
    function hideError() {
        const errEl = document.getElementById('errorMessage');
        if (errEl) {
            Utils.hideError(errEl);
        }
    }
    
    // Record button click
    if (recordBtn) {
        recordBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('Record button clicked, isRecording:', isRecording);
            if (!isRecording) {
                // Hide recorded preview if showing
                hideRecordedAudioPreview();
                await startRecording();
            } else {
                stopRecording();
            }
        });
        console.log('Audio record button listener attached');
    } else {
        console.error('Audio record button not found!');
    }
    
    // Upload recorded audio button
    if (uploadRecordedBtn) {
        uploadRecordedBtn.addEventListener('click', async () => {
            if (recordedAudioBlob) {
                await analyzeAudio(recordedAudioBlob);
            }
        });
    }
    
    // Record again button
    if (recordAgainBtn) {
        recordAgainBtn.addEventListener('click', () => {
            hideRecordedAudioPreview();
            if (audioStatus) {
                audioStatus.textContent = 'Ready to record or upload';
            }
        });
    }
    
    // File input change handler - Use once flag to prevent duplicates
    let audioFileInputListenerAttached = false;
    function setupAudioFileInput() {
        const fileInput = document.getElementById('audioFileInput');
        if (fileInput && !audioFileInputListenerAttached) {
            fileInput.addEventListener('change', function handleAudioFileChange(e) {
                console.log('Audio file input changed:', e.target.files);
                if (e.target.files && e.target.files.length > 0) {
                    handleFileUpload(e.target.files);
                }
            });
            audioFileInputListenerAttached = true;
            console.log('✅ Audio file input listener attached');
        } else if (!fileInput) {
            console.warn('Audio file input not found, retrying...');
            setTimeout(setupAudioFileInput, 500);
        }
    }
    
    // Drag and drop handlers - Use once flag to prevent duplicates
    let audioDragDropListenerAttached = false;
    function setupAudioDragAndDrop() {
        const uploadArea = document.getElementById('audioUploadArea');
        if (uploadArea && !audioDragDropListenerAttached) {
            uploadArea.addEventListener('dragover', function handleAudioDragOver(e) {
                e.preventDefault();
                e.stopPropagation();
                uploadArea.classList.add('dragover');
            });
            
            uploadArea.addEventListener('dragleave', function handleAudioDragLeave(e) {
                e.preventDefault();
                e.stopPropagation();
                uploadArea.classList.remove('dragover');
            });
            
            uploadArea.addEventListener('drop', function handleAudioDrop(e) {
                e.preventDefault();
                e.stopPropagation();
                uploadArea.classList.remove('dragover');
                if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                    handleFileUpload(e.dataTransfer.files);
                }
            });
            
            audioDragDropListenerAttached = true;
            console.log('✅ Audio drag & drop handlers attached');
        } else if (!uploadArea) {
            console.warn('Audio upload area not found, retrying...');
            setTimeout(setupAudioDragAndDrop, 500);
        }
    }
    
    // Setup both handlers immediately
    setupAudioFileInput();
    setupAudioDragAndDrop();
    
    async function startRecording() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorder = new MediaRecorder(stream, {
                mimeType: 'audio/webm;codecs=opus'
            });
            
            audioChunks = [];
            
            currentStream = stream; // Save stream reference
            
            mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    audioChunks.push(event.data);
                }
            };
            
            mediaRecorder.onstop = () => {
                recordedAudioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                
                // Show recorded audio preview instead of auto-analyzing
                showRecordedAudioPreview();
                
                // Stop all tracks
                if (currentStream) {
                    currentStream.getTracks().forEach(track => track.stop());
                    currentStream = null;
                }
            };
            
            mediaRecorder.start();
            isRecording = true;
            
            // Show waves animation
            console.log('Starting recording...', {
                audioWavesContainer: !!audioWavesContainer,
                audioDefaultContent: !!audioDefaultContent
            });
            
            // Hide default content and show waves
            if (audioDefaultContent) {
                audioDefaultContent.style.display = 'none';
            }
            if (audioWavesContainer) {
                // Remove inline style and use class-based display
                audioWavesContainer.style.display = 'flex';
                audioWavesContainer.style.visibility = 'visible';
                audioWavesContainer.style.opacity = '1';
                audioWavesContainer.classList.add('show-waves');
                // Force reflow to ensure display change
                setTimeout(() => {
                    if (audioWavesContainer) {
                        audioWavesContainer.style.display = 'flex';
                    }
                }, 10);
            } else {
                console.error('audioWavesContainer not found!');
            }
            
            if (recordBtn) {
                recordBtn.innerHTML = '<span class="btn-icon">⏹️</span> Stop Recording';
                recordBtn.classList.add('recording');
            }
            if (audioStatus) {
                audioStatus.textContent = 'Recording... Speak now';
                audioStatus.style.color = 'var(--primary-color)';
            }
            hideError();
            
        } catch (error) {
            showError(`Failed to access microphone: ${error.message}`);
            console.error('Microphone error:', error);
        }
    }
    
    function stopRecording() {
        if (mediaRecorder && isRecording) {
            mediaRecorder.stop();
            isRecording = false;
            
            // Hide waves animation
            if (audioWavesContainer) {
                audioWavesContainer.style.display = 'none';
                audioWavesContainer.classList.remove('show-waves');
            }
            
            if (recordBtn) {
                recordBtn.innerHTML = '<span class="btn-icon">🎤</span> Record Audio';
                recordBtn.classList.remove('recording');
            }
            if (audioStatus) {
                audioStatus.textContent = 'Recording stopped. Upload to analyze.';
                audioStatus.style.color = 'var(--text-secondary)';
            }
        }
    }
    
    function showRecordedAudioPreview() {
        if (!recordedAudioBlob) return;
        
        // Hide default content and waves
        if (audioDefaultContent) {
            audioDefaultContent.style.display = 'none';
        }
        if (audioWavesContainer) {
            audioWavesContainer.style.display = 'none';
        }
        
        // Show recorded audio preview
        if (recordedAudioPreview) {
            recordedAudioPreview.style.display = 'block';
        }
        
        // Set audio player source
        if (recordedAudioPlayer) {
            const audioUrl = URL.createObjectURL(recordedAudioBlob);
            recordedAudioPlayer.src = audioUrl;
        }
    }
    
    function hideRecordedAudioPreview() {
        if (recordedAudioPreview) {
            recordedAudioPreview.style.display = 'none';
        }
        if (recordedAudioPlayer) {
            if (recordedAudioPlayer.src) {
                URL.revokeObjectURL(recordedAudioPlayer.src);
            }
            recordedAudioPlayer.src = '';
        }
        // Show default content
        if (audioDefaultContent) {
            audioDefaultContent.style.display = 'block';
        }
        recordedAudioBlob = null;
        audioChunks = [];
    }
    
    function handleFileUpload(files) {
        if (!files || files.length === 0) return;
        
        const file = files[0];
        
        // Validate file type using shared utility
        const allowedTypes = ['audio/wav', 'audio/mpeg', 'audio/mp3', 'audio/webm', 'audio/ogg', 'audio/x-m4a', 'audio/mp4'];
        const allowedExtensions = ['.wav', '.mp3', '.webm', '.ogg', '.m4a', '.mp4'];
        
        if (!Utils.validateFileType(file, allowedTypes, allowedExtensions)) {
            showError('Please upload a WAV, MP3, WebM, OGG, or M4A audio file');
            return;
        }
        
        // Validate file size using shared utility
        if (!Utils.validateFileSize(file, 10)) {
            showError(`File size must be less than 10MB (current: ${Utils.formatFileSize(file.size)})`);
            return;
        }
        
        hideError();
        // Analyze uploaded file using unified function
        analyzeUploadedAudio(file);
    }
    
    // Unified function for analyzing uploaded files
    async function analyzeUploadedAudio(audioFile) {
        // Use the same analyzeAudio function for unified result display
        await analyzeAudio(audioFile);
    }
    
    async function analyzeAudio(audioFile) {
        console.log('Starting audio analysis, sending request to:', API_ENDPOINT);
        
        try {
            // Show loading state using shared utility
            if (typeof SharedUtils !== 'undefined' && SharedUtils.showLoading) {
                SharedUtils.showLoading({
                    status: audioStatus,
                    result: audioResult,
                    emptyState: audioEmptyState
                }, 'Analyzing...');
            } else {
                // Fallback loading state
                if (audioResult) {
                    audioResult.style.display = 'block';
                }
                if (audioEmptyState) {
                    audioEmptyState.style.display = 'none';
                }
                if (audioStatus) {
                    audioStatus.textContent = 'Analyzing...';
                }
            }
            
            // Hide waves if still showing
            if (uploadArea) {
                uploadArea.classList.remove('recording');
            }
            if (audioWavesContainer) {
                audioWavesContainer.style.display = 'none';
                audioWavesContainer.classList.remove('show-waves');
            }
            
            // Hide recorded preview if showing
            hideRecordedAudioPreview();
            
            // Show default content
            if (audioDefaultContent) {
                audioDefaultContent.style.display = 'block';
            }
            
            // Create form data
            const formData = new FormData();
            formData.append('file', audioFile, audioFile.name || 'audio.webm');
            
            console.log('Sending POST request to:', API_ENDPOINT);
            console.log('File details:', {
                name: audioFile.name,
                type: audioFile.type,
                size: audioFile.size
            });
            
            // Send to server
            const response = await fetch(API_ENDPOINT, {
                method: 'POST',
                body: formData
            });
            
            console.log('Response received:', response.status, response.statusText);
            
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                console.error('Request failed:', errorData);
                throw new Error(errorData.detail || `Request failed (${response.status})`);
            }
            
            const data = await response.json();
            console.log('Response data:', data);
            
            if (!data.success) {
                throw new Error('No speech detected in audio');
            }
            
            // Update UI with results using shared utility
            if (typeof SharedUtils !== 'undefined' && SharedUtils.displayEmotionResult) {
                SharedUtils.displayEmotionResult(data, {
                    icon: audioEmotionIcon,
                    label: audioEmotionLabel,
                    confidenceFill: audioConfidenceFill,
                    confidence: audioConfidence,
                    statusText: audioStatusText,
                    result: audioResult,
                    emptyState: audioEmptyState
                });
            } else {
                // Fallback result display
                console.log('SharedUtils not available, using fallback display');
                if (audioEmotionIcon) {
                    audioEmotionIcon.textContent = Utils.EMOTION_EMOJIS[data.emotion] || '😐';
                }
                if (audioEmotionLabel) {
                    audioEmotionLabel.textContent = data.emotion.charAt(0).toUpperCase() + data.emotion.slice(1);
                }
                if (audioConfidenceFill) {
                    audioConfidenceFill.style.width = `${(data.confidence * 100)}%`;
                }
                if (audioConfidence) {
                    audioConfidence.textContent = `Confidence: ${(data.confidence * 100).toFixed(1)}%`;
                }
                if (audioStatusText) {
                    audioStatusText.textContent = '✓ Analyzed';
                }
                if (audioResult) {
                    audioResult.style.display = 'block';
                    console.log('✅ Audio result section shown');
                } else {
                    console.error('❌ audioResult element not found!');
                }
                if (audioEmptyState) {
                    audioEmptyState.style.display = 'none';
                }
            }
            
            if (audioStatus) {
                audioStatus.textContent = 'Analysis complete';
            }
            
            console.log('✅ Audio analysis complete');
            console.log('Result elements:', {
                audioResult: !!audioResult,
                audioEmotionIcon: !!audioEmotionIcon,
                audioEmotionLabel: !!audioEmotionLabel,
                audioConfidenceFill: !!audioConfidenceFill,
                audioConfidence: !!audioConfidence
            });
            
        } catch (error) {
            console.error('Error analyzing audio:', error);
            showError(error.message || 'Failed to analyze audio');
            if (audioStatus) {
                audioStatus.textContent = 'Analysis failed';
            }
            // Show empty state on error
            if (typeof SharedUtils !== 'undefined' && SharedUtils.showEmptyState) {
                SharedUtils.showEmptyState({
                    result: audioResult,
                    emptyState: audioEmptyState
                });
            } else {
                if (audioResult) {
                    audioResult.style.display = 'none';
                }
                if (audioEmptyState) {
                    audioEmptyState.style.display = 'block';
                }
            }
        }
    }
    }
})();
