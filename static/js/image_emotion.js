/**
 * Image Emotion Detection
 * Handles image upload, preview, and emotion analysis
 */

(function() {
    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
    
    function init() {
    console.log('Image emotion detection initializing...');
    const API_ENDPOINT = '/image/emotion';
    
    // Get elements (using unified structure IDs)
    const fileInput = document.getElementById('imageFileInput');
    const uploadArea = document.getElementById('imageUploadArea');
    
    console.log('Image elements found:', {
        fileInput: !!fileInput,
        uploadArea: !!uploadArea
    });
    const defaultContent = document.getElementById('imageDefaultContent');
    const previewImage = document.getElementById('imagePreview');
    const imageResult = document.getElementById('imageResult');
    const imageEmptyState = document.getElementById('imageEmptyState');
    const imageEmotionIcon = document.getElementById('imageEmotionIcon');
    const imageEmotionLabel = document.getElementById('imageEmotionLabel');
    const imageConfidenceFill = document.getElementById('imageConfidenceFill');
    const imageConfidence = document.getElementById('imageConfidence');
    const imageStatusText = document.getElementById('imageStatusText');
    const errorMessage = document.getElementById('errorMessage');
    
    let selectedFile = null;
    
    // Use shared utilities - Use SharedUtils directly if available
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
        showEmptyState: () => {},
        validateFileType: (file, allowedTypes, allowedExtensions) => {
            const isValidType = allowedTypes.includes(file.type);
            const isValidExtension = allowedExtensions.some(ext => 
                file.name.toLowerCase().endsWith(ext.toLowerCase())
            );
            return isValidType || isValidExtension;
        },
        validateFileSize: (file, maxSizeMB) => {
            return file.size <= maxSizeMB * 1024 * 1024;
        },
        formatFileSize: (bytes) => {
            if (bytes === 0) return '0 Bytes';
            const k = 1024;
            const sizes = ['Bytes', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
        }
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
    
    // File input change handler - Use once flag to prevent duplicates
    let fileInputListenerAttached = false;
    function setupFileInput() {
        const fileInput = document.getElementById('imageFileInput');
        if (fileInput && !fileInputListenerAttached) {
            fileInput.addEventListener('change', function handleFileChange(e) {
                console.log('File selected:', e.target.files);
                if (e.target.files && e.target.files.length > 0) {
                    handleFiles(e.target.files);
                }
            });
            fileInputListenerAttached = true;
            console.log('✅ Image file input listener attached');
        } else if (!fileInput) {
            console.warn('Image file input not found, retrying...');
            setTimeout(setupFileInput, 500);
        }
    }
    
    // Drag and drop handlers - Use once flag to prevent duplicates
    let dragDropListenerAttached = false;
    function setupDragAndDrop() {
        const uploadArea = document.getElementById('imageUploadArea');
        if (uploadArea && !dragDropListenerAttached) {
            uploadArea.addEventListener('dragover', function handleDragOver(e) {
                e.preventDefault();
                e.stopPropagation();
                uploadArea.classList.add('dragover');
            });
            
            uploadArea.addEventListener('dragleave', function handleDragLeave(e) {
                e.preventDefault();
                e.stopPropagation();
                uploadArea.classList.remove('dragover');
            });
            
            uploadArea.addEventListener('drop', function handleDrop(e) {
                e.preventDefault();
                e.stopPropagation();
                uploadArea.classList.remove('dragover');
                if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                    handleFiles(e.dataTransfer.files);
                }
            });
            
            dragDropListenerAttached = true;
            console.log('✅ Image drag & drop handlers attached');
        } else if (!uploadArea) {
            console.warn('Image upload area not found, retrying...');
            setTimeout(setupDragAndDrop, 500);
        }
    }
    
    // Setup both handlers immediately
    setupFileInput();
    setupDragAndDrop();
    
    function handleFiles(files) {
        if (!files || files.length === 0) {
            console.log('No files selected');
            return;
        }
        
        const file = files[0];
        console.log('File selected:', file.name, file.type, file.size);
        
        // Validate file type
        const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
        const allowedExtensions = ['.jpg', '.jpeg', '.png', '.webp'];
        
        const fileExtension = '.' + file.name.split('.').pop().toLowerCase();
        const isValidType = allowedTypes.includes(file.type) || allowedExtensions.includes(fileExtension);
        
        if (!isValidType) {
            console.error('Invalid file type:', file.type, fileExtension);
            showError('Please upload a JPG, PNG, or WebP image');
            return;
        }
        
        // Validate file size (max 8MB)
        const maxSizeMB = 8;
        const maxSizeBytes = maxSizeMB * 1024 * 1024;
        
        if (file.size > maxSizeBytes) {
            const fileSizeMB = (file.size / (1024 * 1024)).toFixed(2);
            console.error('File too large:', fileSizeMB, 'MB');
            showError(`Image size must be less than ${maxSizeMB}MB (current: ${fileSizeMB}MB)`);
            return;
        }
        
        console.log('File validated successfully, proceeding with upload');
        selectedFile = file;
        updatePreview(file);
        hideError();
        
        // Auto-analyze after preview
        setTimeout(() => {
            console.log('Starting image analysis...');
            analyzeImage();
        }, 300);
    }
    
    function updatePreview(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            if (previewImage) {
                previewImage.src = e.target.result;
                previewImage.style.display = 'block';
            }
            if (defaultContent) {
                defaultContent.style.display = 'none';
            }
            if (imageResult) {
                imageResult.style.display = 'none';
            }
            if (imageEmptyState) {
                imageEmptyState.style.display = 'none';
            }
        };
        reader.readAsDataURL(file);
    }
    
    async function analyzeImage() {
        if (!selectedFile) {
            console.error('No file selected for analysis');
            return;
        }
        
        console.log('Starting image analysis, sending request to:', API_ENDPOINT);
        
        try {
            // Show loading state
            if (imageEmptyState) {
                imageEmptyState.style.display = 'none';
            }
            
            if (imageResult) {
                imageResult.style.display = 'block';
                // Show loading message in result section
                if (imageEmotionIcon) {
                    imageEmotionIcon.textContent = '⏳';
                }
                if (imageEmotionLabel) {
                    imageEmotionLabel.textContent = 'Analyzing...';
                }
                if (imageConfidenceFill) {
                    imageConfidenceFill.style.width = '0%';
                }
                if (imageConfidence) {
                    imageConfidence.textContent = 'Please wait...';
                }
                if (imageStatusText) {
                    imageStatusText.textContent = 'Processing';
                }
            }
            
            const formData = new FormData();
            formData.append('file', selectedFile);
            
            console.log('Sending POST request to:', API_ENDPOINT);
            console.log('File details:', {
                name: selectedFile.name,
                type: selectedFile.type,
                size: selectedFile.size
            });
            
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
                throw new Error('No face detected in the image');
            }
            
            // Update UI with results using shared utility
            if (typeof SharedUtils !== 'undefined' && SharedUtils.displayEmotionResult) {
                SharedUtils.displayEmotionResult(data, {
                    icon: imageEmotionIcon,
                    label: imageEmotionLabel,
                    confidenceFill: imageConfidenceFill,
                    confidence: imageConfidence,
                    statusText: imageStatusText,
                    result: imageResult,
                    emptyState: imageEmptyState
                });
            } else {
                // Fallback result display
                console.log('SharedUtils not available, using fallback display');
                const emotion = data.emotion || 'neutral';
                const confidence = (data.confidence || 0) * 100;
                
                if (imageEmotionIcon) {
                    imageEmotionIcon.textContent = Utils.EMOTION_EMOJIS[emotion] || '😐';
                }
                if (imageEmotionLabel) {
                    imageEmotionLabel.textContent = emotion.charAt(0).toUpperCase() + emotion.slice(1);
                }
                if (imageConfidenceFill) {
                    imageConfidenceFill.style.width = `${confidence}%`;
                }
                if (imageConfidence) {
                    imageConfidence.textContent = `Confidence: ${confidence.toFixed(1)}%`;
                }
                if (imageStatusText) {
                    imageStatusText.textContent = '✓ Analyzed';
                }
                
                // Show result and hide empty state
                if (imageResult) {
                    imageResult.style.display = 'block';
                    // Scroll result into view smoothly
                    setTimeout(() => {
                        imageResult.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    }, 100);
                }
                if (imageEmptyState) {
                    imageEmptyState.style.display = 'none';
                }
            }
            
            console.log('✅ Image analysis complete');
            
        } catch (error) {
            console.error('Error analyzing image:', error);
            showError(error.message || 'Failed to analyze image');
            if (typeof SharedUtils !== 'undefined' && SharedUtils.showEmptyState) {
                SharedUtils.showEmptyState({
                    result: imageResult,
                    emptyState: imageEmptyState
                });
            } else {
                if (imageResult) {
                    imageResult.style.display = 'none';
                }
                if (imageEmptyState) {
                    imageEmptyState.style.display = 'block';
                }
            }
        }
    }
    
    // Click on preview to remove and reset
    if (previewImage) {
        previewImage.addEventListener('click', () => {
            selectedFile = null;
            if (fileInput) fileInput.value = '';
            if (previewImage) previewImage.style.display = 'none';
            if (defaultContent) defaultContent.style.display = 'block';
            if (imageResult) imageResult.style.display = 'none';
            if (imageEmptyState) imageEmptyState.style.display = 'block';
        });
    }
    }
})();
