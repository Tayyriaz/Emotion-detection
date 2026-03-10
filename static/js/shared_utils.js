/**
 * Shared Utilities for Emotion Detection App
 * Common functions used across all emotion detection features
 */

const SharedUtils = {
    // Emotion emoji mapping (consistent across all features)
    EMOTION_EMOJIS: {
        'anger': '😠',
        'contempt': '😤',
        'disgust': '🤢',
        'fear': '😨',
        'happiness': '😊',
        'neutral': '😐',
        'sadness': '😢',
        'surprise': '😲'
    },

    /**
     * Show error message to user
     * @param {string} message - Error message to display
     * @param {HTMLElement} errorElement - Error container element
     * @param {number} duration - Display duration in ms (default: 5000)
     */
    showError(message, errorElement, duration = 5000) {
        if (!errorElement) {
            errorElement = document.getElementById('errorMessage');
        }
        
        if (errorElement) {
            errorElement.textContent = message;
            errorElement.style.display = 'block';
            errorElement.setAttribute('role', 'alert');
            errorElement.setAttribute('aria-live', 'assertive');
            
            setTimeout(() => {
                this.hideError(errorElement);
            }, duration);
        } else {
            console.error('Error:', message);
        }
    },

    /**
     * Hide error message
     * @param {HTMLElement} errorElement - Error container element
     */
    hideError(errorElement) {
        if (!errorElement) {
            errorElement = document.getElementById('errorMessage');
        }
        
        if (errorElement) {
            errorElement.style.display = 'none';
            errorElement.removeAttribute('role');
            errorElement.removeAttribute('aria-live');
        }
    },

    /**
     * Display emotion result in UI
     * @param {Object} data - Result data from API
     * @param {Object} elements - UI elements object
     */
    displayEmotionResult(data, elements) {
        const emotion = data.emotion || 'neutral';
        const confidence = (data.confidence || 0) * 100;
        const emoji = this.EMOTION_EMOJIS[emotion] || '😐';
        const emotionLabel = emotion.charAt(0).toUpperCase() + emotion.slice(1);

        // Update icon
        if (elements.icon) {
            elements.icon.textContent = emoji;
            elements.icon.setAttribute('aria-label', `Emotion: ${emotionLabel}`);
        }

        // Update label
        if (elements.label) {
            elements.label.textContent = emotionLabel;
        }

        // Update confidence bar
        if (elements.confidenceFill) {
            elements.confidenceFill.style.width = `${confidence}%`;
            elements.confidenceFill.setAttribute('aria-valuenow', confidence.toFixed(1));
            elements.confidenceFill.setAttribute('aria-valuemin', 0);
            elements.confidenceFill.setAttribute('aria-valuemax', 100);
        }

        // Update confidence text
        if (elements.confidence) {
            elements.confidence.textContent = `Confidence: ${confidence.toFixed(1)}%`;
        }

        // Update status
        if (elements.statusText) {
            elements.statusText.textContent = '✓ Analyzed';
        }

        // Show result section
        if (elements.result) {
            elements.result.style.display = 'block';
            // Only scroll for image/audio results, not for video (video is already visible)
            // Video results update frequently, scrolling would be annoying
            const isVideoResult = elements.result.id && elements.result.id.includes('video');
            if (!isVideoResult) {
                setTimeout(() => {
                    elements.result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }, 100);
            }
        }

        // Hide empty state if exists
        if (elements.emptyState) {
            elements.emptyState.style.display = 'none';
        }

        // Animate result icon
        if (elements.icon) {
            elements.icon.style.animation = 'none';
            setTimeout(() => {
                elements.icon.style.animation = 'bounceIn 0.6s ease';
            }, 10);
        }
    },

    /**
     * Show loading state
     * @param {Object} elements - UI elements object
     * @param {string} message - Loading message
     */
    showLoading(elements, message = 'Analyzing...') {
        if (elements.status) {
            elements.status.textContent = message;
            elements.status.style.color = 'var(--text-secondary)';
        }

        if (elements.result) {
            elements.result.style.display = 'none';
        }

        if (elements.emptyState) {
            elements.emptyState.style.display = 'none';
        }
    },

    /**
     * Show empty state
     * @param {Object} elements - UI elements object
     */
    showEmptyState(elements) {
        if (elements.result) {
            elements.result.style.display = 'none';
        }

        if (elements.emptyState) {
            elements.emptyState.style.display = 'block';
        }
    },

    /**
     * Format file size for display
     * @param {number} bytes - File size in bytes
     * @returns {string} Formatted file size
     */
    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
    },

    /**
     * Validate file type
     * @param {File} file - File object
     * @param {Array<string>} allowedTypes - Allowed MIME types
     * @param {Array<string>} allowedExtensions - Allowed file extensions
     * @returns {boolean} Whether file is valid
     */
    validateFileType(file, allowedTypes, allowedExtensions) {
        const isValidType = allowedTypes.includes(file.type);
        const isValidExtension = allowedExtensions.some(ext => 
            file.name.toLowerCase().endsWith(ext.toLowerCase())
        );
        return isValidType || isValidExtension;
    },

    /**
     * Validate file size
     * @param {File} file - File object
     * @param {number} maxSizeMB - Maximum size in MB
     * @returns {boolean} Whether file size is valid
     */
    validateFileSize(file, maxSizeMB) {
        return file.size <= maxSizeMB * 1024 * 1024;
    },

};

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SharedUtils;
}
