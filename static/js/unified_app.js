/**
 * Unified Emotion Detection App
 * Manages tab switching and coordinates image/video features
 */

class UnifiedApp {
    constructor() {
        this.currentTab = 'image';
        this.init();
    }
    
    init() {
        this.setupTabs();
        this.setupImageFeature();
        this.setupVideoFeature();
        this.setupAudioFeature();
    }
    
    setupTabs() {
        console.log('Setting up tabs...');
        const tabButtons = document.querySelectorAll('.tab-btn');
        const methodCards = document.querySelectorAll('.method-card');
        
        console.log('Found elements:', {
            tabButtons: tabButtons.length,
            methodCards: methodCards.length
        });
        
        // Helper function to scroll to detection section
        const scrollToDetectionSection = () => {
            const detectionSection = document.getElementById('features');
            if (detectionSection) {
                setTimeout(() => {
                    const navHeight = 72;
                    const offsetTop = detectionSection.offsetTop - navHeight;
                    window.scrollTo({
                        top: offsetTop,
                        behavior: 'smooth'
                    });
                }, 100);
            }
        };
        
        // Handle tab button clicks
        tabButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const tabId = btn.dataset.tab;
                if (tabId) {
                    this.switchTab(tabId);
                    scrollToDetectionSection();
                }
            });
        });
        
        // Handle method card clicks
        methodCards.forEach(card => {
            card.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const tabId = card.dataset.tab;
                if (tabId) {
                    this.switchTab(tabId);
                    scrollToDetectionSection();
                }
            });
        });
        
        console.log('Tab listeners attached');
    }
    
    switchTab(tabId) {
        // Update tab buttons with accessibility
        document.querySelectorAll('.tab-btn').forEach(btn => {
            const isActive = btn.dataset.tab === tabId;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-selected', isActive);
        });
        
        // Update method cards
        document.querySelectorAll('.method-card').forEach(card => {
            const isActive = card.dataset.tab === tabId;
            card.classList.toggle('active', isActive);
        });
        
        // Update content with accessibility
        document.querySelectorAll('.tab-content').forEach(content => {
            const isActive = content.id === `${tabId}Tab`;
            content.classList.toggle('active', isActive);
            content.setAttribute('aria-hidden', !isActive);
        });
        
        this.currentTab = tabId;
        
        // Stop video if switching away
        if (tabId !== 'video' && window.videoDetector) {
            window.videoDetector.stop();
        }
        
        // Stop audio recording if switching away
        if (tabId !== 'audio' && window.audioDetector) {
            if (typeof window.audioDetector.stop === 'function') {
                window.audioDetector.stop();
            }
        }
    }
    
    setupImageFeature() {
        // Image emotion functionality handled by image_emotion.js
    }
    
    setupVideoFeature() {
        // Initialize video detector when video tab is active
        const videoTab = document.getElementById('videoTab');
        
        // Initialize video detector lazily when tab is switched
        const initVideoDetector = () => {
            if (!window.videoDetector && typeof VideoEmotionDetector !== 'undefined') {
                window.videoDetector = new VideoEmotionDetector();
            }
        };
        
        const observer = new MutationObserver(() => {
            if (videoTab.classList.contains('active')) {
                setTimeout(initVideoDetector, 100);
            } else {
                // Stop video when switching away
                if (window.videoDetector && window.videoDetector.isRunning) {
                    window.videoDetector.stop();
                }
            }
        });
        
        observer.observe(videoTab, {
            attributes: true,
            attributeFilter: ['class']
        });
        
        // Initialize on page load if video tab is active
        if (videoTab.classList.contains('active')) {
            setTimeout(initVideoDetector, 100);
        }
    }
    
    setupAudioFeature() {
        // Audio feature handled by audio_emotion.js
    }
}

// Initialize app when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        console.log('DOM loaded, initializing UnifiedApp...');
        window.unifiedApp = new UnifiedApp();
        console.log('UnifiedApp initialized');
    });
} else {
    console.log('DOM already ready, initializing UnifiedApp...');
    window.unifiedApp = new UnifiedApp();
    console.log('UnifiedApp initialized');
}
