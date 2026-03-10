/**
 * Audio Emotion Detection - Standalone Page
 * Production-ready JavaScript matching client documentation
 */

// Global Variables
const uploadArea = document.getElementById('uploadArea');
const fileInput = document.getElementById('fileInput');
const fileInfo = document.getElementById('fileInfo');
const fileName = document.getElementById('fileName');
const fileSize = document.getElementById('fileSize');
const btnAnalyze = document.getElementById('btnAnalyze');
const loading = document.getElementById('loading');
const results = document.getElementById('results');
const errorMessage = document.getElementById('errorMessage');

// Result elements
const emotionLabel = document.getElementById('emotionLabel');
const confidenceFill = document.getElementById('confidenceFill');
const confidenceText = document.getElementById('confidenceText');
const transcriptText = document.getElementById('transcriptText');
const moodCategory = document.getElementById('moodCategory');
const energyLevel = document.getElementById('energyLevel');
const tone = document.getElementById('tone');
const emotionalIntensity = document.getElementById('emotionalIntensity');
const keyPhrases = document.getElementById('keyPhrases');
const overallVibe = document.getElementById('overallVibe');
const explanation = document.getElementById('explanation');

let selectedFile = null;

// ============================================
// EVENT LISTENERS
// ============================================

// Upload area click
uploadArea.addEventListener('click', () => {
    fileInput.click();
});

// File input change
fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        handleFileSelect(e.target.files[0]);
    }
});

// Drag & Drop
uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('dragover');
});

uploadArea.addEventListener('dragleave', () => {
    uploadArea.classList.remove('dragover');
});

uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
        handleFileSelect(e.dataTransfer.files[0]);
    }
});

// Analyze button
btnAnalyze.addEventListener('click', () => {
    if (selectedFile) {
        analyzeAudio();
    }
});

// ============================================
// CORE FUNCTIONS
// ============================================

/**
 * Handle file selection
 */
function handleFileSelect(file) {
    // Validate file type
    const allowedTypes = ['audio/wav', 'audio/mpeg', 'audio/mp3', 'audio/webm', 'audio/ogg', 'audio/x-m4a', 'audio/mp4'];
    const allowedExtensions = ['.wav', '.mp3', '.webm', '.ogg', '.m4a', '.mp4'];
    
    const fileExtension = '.' + file.name.split('.').pop().toLowerCase();
    const isValidType = allowedTypes.includes(file.type) || allowedExtensions.includes(fileExtension);
    
    if (!isValidType) {
        showError('Please upload a WAV, MP3, WebM, OGG, or M4A audio file');
        return;
    }
    
    // Validate file size (max 25MB)
    const maxSize = 25 * 1024 * 1024; // 25MB
    if (file.size > maxSize) {
        showError(`File size must be less than 25MB (current: ${formatFileSize(file.size)})`);
        return;
    }
    
    // Check if file is empty
    if (file.size === 0) {
        showError('The selected file is empty. Please select a valid audio file.');
        return;
    }
    
    selectedFile = file;
    
    // Update UI
    fileName.textContent = file.name;
    fileSize.textContent = formatFileSize(file.size);
    fileInfo.classList.add('active');
    btnAnalyze.disabled = false;
    hideError();
    
    // Hide results
    results.classList.remove('active');
}

/**
 * Format file size
 */
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Main analysis function
 */
async function analyzeAudio() {
    if (!selectedFile) {
        showError('Please select an audio file first');
        return;
    }
    
    // Show loading, hide results
    loading.classList.add('active');
    results.classList.remove('active');
    btnAnalyze.disabled = true;
    hideError();
    
    try {
        // Create FormData (matching client documentation: audio_file field)
        const formData = new FormData();
        formData.append('audio_file', selectedFile);
        
        // POST to API (matching client documentation: /api/audio/analyze)
        const response = await fetch('/api/audio/analyze', {
            method: 'POST',
            body: formData
        });
        
        // Handle response
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.detail || `Request failed (${response.status})`);
        }
        
        const data = await response.json();
        
        if (!data.success) {
            throw new Error('No speech detected in audio');
        }
        
        // Display results
        displayResults(data);
        
    } catch (error) {
        console.error('Error analyzing audio:', error);
        showError(error.message || 'Failed to analyze audio');
    } finally {
        loading.classList.remove('active');
        btnAnalyze.disabled = false;
    }
}

/**
 * Display results
 */
function displayResults(data) {
    // Emotion label
    const emotion = data.emotion || 'neutral';
    emotionLabel.textContent = emotion.charAt(0).toUpperCase() + emotion.slice(1);
    
    // Confidence bar
    const confidence = (data.confidence || 0) * 100;
    confidenceFill.style.width = `${confidence}%`;
    confidenceText.textContent = `${confidence.toFixed(1)}%`;
    
    // Transcript
    transcriptText.textContent = data.transcript || 'No transcript available';
    
    // Details
    moodCategory.textContent = data.mood_category || 'N/A';
    energyLevel.textContent = data.energy_level || 'N/A';
    tone.textContent = data.tone || 'N/A';
    emotionalIntensity.textContent = data.emotional_intensity ? `${(data.emotional_intensity * 100).toFixed(0)}%` : 'N/A';
    
    // Key phrases
    keyPhrases.innerHTML = '';
    if (data.key_phrases && data.key_phrases.length > 0) {
        data.key_phrases.forEach(phrase => {
            const tag = document.createElement('span');
            tag.className = 'phrase-tag';
            tag.textContent = phrase;
            keyPhrases.appendChild(tag);
        });
    } else {
        const noPhrases = document.createElement('span');
        noPhrases.textContent = 'No key phrases detected';
        noPhrases.style.color = '#64748b';
        keyPhrases.appendChild(noPhrases);
    }
    
    // Overall vibe
    overallVibe.textContent = data.overall_vibe || 'No analysis available';
    
    // Explanation
    explanation.textContent = data.explanation || 'No explanation available';
    
    // Show results
    results.classList.add('active');
    
    // Scroll to results
    setTimeout(() => {
        results.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
}

/**
 * Show error message
 */
function showError(message) {
    errorMessage.textContent = message;
    errorMessage.classList.add('active');
}

/**
 * Hide error message
 */
function hideError() {
    errorMessage.classList.remove('active');
}
