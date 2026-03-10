"""
Audio Emotion Analysis Service

High-level service functions for emotion detection from audio.
Handles audio processing, transcription, and emotion analysis using Groq API.
"""

import io
import wave
from collections import deque
from typing import Dict, Tuple

import numpy as np

from app.config import get_settings
from app.services.groq_client import GroqClient
from app.utils.logging import get_logger, get_request_id

logger = get_logger(__name__)
settings = get_settings()


class AudioBuffer:
    """Buffer for audio chunks before processing."""
    
    def __init__(self, buffer_seconds: float = 3.0, sample_rate: int = 16000):
        self.buffer_seconds = buffer_seconds
        self.sample_rate = sample_rate
        self.buffer_size = int(buffer_seconds * sample_rate)
        self.buffer: deque = deque(maxlen=self.buffer_size)
        self.chunk_count = 0
    
    def add_chunk(self, audio_array: np.ndarray):
        """Add audio chunk to buffer."""
        self.buffer.extend(audio_array.tolist())
        self.chunk_count += 1
    
    def is_ready(self) -> bool:
        """Check if buffer has enough data."""
        return len(self.buffer) >= self.buffer_size
    
    def get_audio_bytes(self) -> bytes:
        """Get buffered audio as WAV bytes."""
        audio_array = np.array(list(self.buffer), dtype=np.float32)
        
        # Convert to int16
        audio_int16 = (audio_array * 32767.0).astype(np.int16)
        
        # Create WAV file in memory
        wav_buffer = io.BytesIO()
        with wave.open(wav_buffer, 'wb') as wav_file:
            wav_file.setnchannels(1)  # Mono
            wav_file.setsampwidth(2)  # 16-bit
            wav_file.setframerate(self.sample_rate)
            wav_file.writeframes(audio_int16.tobytes())
        
        wav_buffer.seek(0)
        return wav_buffer.read()
    
    def clear(self):
        """Clear buffer."""
        self.buffer.clear()
        self.chunk_count = 0


class EmotionSmoother:
    """Moving average smoother for emotion scores."""
    
    def __init__(self, buffer_size: int = 5):
        self.buffer_size = buffer_size
        self.score_buffers: Dict[str, deque] = {
            emotion: deque(maxlen=buffer_size)
            for emotion in ["happiness", "sadness", "anger", "fear", "surprise", "disgust", "neutral"]
        }
    
    def smooth(self, emotions: Dict[str, float]) -> Dict[str, float]:
        """Apply moving average smoothing."""
        # Add current scores to buffers
        for emotion, score in emotions.items():
            if emotion in self.score_buffers:
                self.score_buffers[emotion].append(score)
        
        # Calculate averages
        smoothed = {}
        for emotion, buffer in self.score_buffers.items():
            if buffer:
                smoothed[emotion] = sum(buffer) / len(buffer)
            else:
                smoothed[emotion] = emotions.get(emotion, 0.0)
        
        return smoothed


# Global instances
_audio_buffers: Dict[str, AudioBuffer] = {}
_emotion_smoothers: Dict[str, EmotionSmoother] = {}


def analyze_audio_emotion(
    audio_array: np.ndarray,
    sample_rate: int = 16000,
    session_id: str = "default"
) -> Dict[str, any]:
    """
    Analyze emotion from audio array.
    
    Process:
    1. Buffer audio chunks (2-3 seconds)
    2. Transcribe using Groq Whisper
    3. Analyze emotion using Groq Llama 3.3
    4. Apply moving average smoothing
    5. Return structured response
    
    Args:
        audio_array: Audio samples as numpy array (float32, normalized to [-1, 1])
        sample_rate: Audio sample rate
        session_id: Session identifier for buffering
        
    Returns:
        Dictionary containing:
        - emotion: Dominant emotion (lowercase)
        - confidence: Confidence score (0.0-1.0)
        - emotions: All 7 emotion scores
        - success: Whether analysis succeeded
    """
    try:
        # Initialize buffer and smoother for session
        if session_id not in _audio_buffers:
            _audio_buffers[session_id] = AudioBuffer(
                buffer_seconds=settings.AUDIO_BUFFER_SECONDS,
                sample_rate=sample_rate
            )
            _emotion_smoothers[session_id] = EmotionSmoother(buffer_size=5)
        
        buffer = _audio_buffers[session_id]
        smoother = _emotion_smoothers[session_id]
        
        # Add chunk to buffer
        buffer.add_chunk(audio_array)
        
        # Check if buffer is ready
        if not buffer.is_ready():
            # Return neutral while buffering
            return {
                "success": False,
                "emotion": "neutral",
                "confidence": 0.0,
                "emotions": {
                    "happiness": 0.0,
                    "sadness": 0.0,
                    "anger": 0.0,
                    "fear": 0.0,
                    "surprise": 0.0,
                    "disgust": 0.0,
                    "neutral": 1.0
                }
            }
        
        # Get Groq client
        if not GroqClient.is_available():
            raise RuntimeError("Groq API not available. Set GROQ_API_KEY in environment.")
        
        groq_client = GroqClient.instance()
        
        # Get buffered audio
        audio_bytes = buffer.get_audio_bytes()
        
        # Transcribe audio
        transcript = groq_client.transcribe_audio(audio_bytes, sample_rate)
        
        if not transcript or len(transcript.strip()) < 3:
            logger.debug("No speech detected in audio")
            return {
                "success": False,
                "emotion": "neutral",
                "confidence": 0.0,
                "emotions": {
                    "happiness": 0.0,
                    "sadness": 0.0,
                    "anger": 0.0,
                    "fear": 0.0,
                    "surprise": 0.0,
                    "disgust": 0.0,
                    "neutral": 1.0
                }
            }
        
        # Analyze emotion
        emotion_result = groq_client.analyze_emotion(transcript)
        
        # Apply smoothing
        smoothed_emotions = smoother.smooth(emotion_result["emotions"])
        
        # Get dominant emotion
        dominant_emotion = max(smoothed_emotions.items(), key=lambda x: x[1])
        emotion_name = dominant_emotion[0]
        confidence = dominant_emotion[1]
        
        # Clear buffer for next cycle
        buffer.clear()
        
        logger.debug(
            f"Audio emotion: {emotion_name} (confidence: {confidence:.3f}), "
            f"transcript: {transcript[:50]}..."
        )
        
        return {
            "success": True,
            "emotion": emotion_name,
            "confidence": confidence,
            "emotions": smoothed_emotions
        }
        
    except Exception as e:
        logger.error(f"Audio emotion analysis failed: {e}", exc_info=True)
        return {
            "success": False,
            "emotion": "neutral",
            "confidence": 0.0,
            "emotions": {
                "happiness": 0.0,
                "sadness": 0.0,
                "anger": 0.0,
                "fear": 0.0,
                "surprise": 0.0,
                "disgust": 0.0,
                "neutral": 1.0
            }
        }


def analyze_audio_file(audio_bytes: bytes, filename: str = "audio.webm") -> Dict[str, any]:
    """
    Analyze emotion from audio file bytes.
    
    Process:
    1. Convert audio bytes to WAV format if needed
    2. Transcribe using Groq Whisper
    3. Analyze emotion using Groq Llama 3.3
    4. Return structured response
    
    Args:
        audio_bytes: Audio file bytes (WAV, MP3, WebM, etc.)
        
    Returns:
        Dictionary containing:
        - emotion: Dominant emotion (lowercase)
        - confidence: Confidence score (0.0-1.0)
        - emotions: All 7 emotion scores
        - success: Whether analysis succeeded
    """
    try:
        request_id = get_request_id() or "unknown"
        file_size_mb = len(audio_bytes) / (1024 * 1024)
        
        logger.info(
            f"[{request_id}] 📊 Starting audio file emotion analysis | "
            f"filename='{filename}' | size={file_size_mb:.2f}MB"
        )
        
        # Get Groq client
        if not GroqClient.is_available():
            logger.error(f"[{request_id}] ❌ Groq API not available")
            raise RuntimeError("Groq API not available. Set GROQ_API_KEY in environment.")
        
        groq_client = GroqClient.instance()
        
        # Transcribe audio
        transcript = groq_client.transcribe_audio(audio_bytes, filename=filename)
        
        if not transcript or len(transcript.strip()) < 3:
            logger.warning(
                f"[{request_id}] ⚠️ No speech detected in audio | "
                f"filename='{filename}' | transcript_length={len(transcript) if transcript else 0}"
            )
            return {
                "success": False,
                "emotion": "neutral",
                "confidence": 0.0,
                "emotions": {
                    "happiness": 0.0,
                    "sadness": 0.0,
                    "anger": 0.0,
                    "fear": 0.0,
                    "surprise": 0.0,
                    "disgust": 0.0,
                    "neutral": 1.0
                }
            }
        
        # Analyze emotion
        emotion_result = groq_client.analyze_emotion(transcript)
        
        # Get dominant emotion
        emotions = emotion_result["emotions"]
        dominant_emotion = max(emotions.items(), key=lambda x: x[1])
        emotion_name = dominant_emotion[0]
        confidence = dominant_emotion[1]
        
        # Derive additional metadata
        mood_category = "Positive" if emotion_name in ["happiness", "surprise"] else ("Negative" if emotion_name in ["sadness", "anger", "fear", "disgust"] else "Neutral")
        energy_level = "High" if confidence > 0.7 else ("Medium" if confidence > 0.4 else "Low")
        tone = "Casual"  # Can be enhanced with LLM analysis
        emotional_intensity = confidence
        
        # Extract key phrases (simple: first few words)
        words = transcript.split()[:5]
        key_phrases = words if len(words) > 0 else []
        
        # Generate overall vibe and explanation
        emotion_display = emotion_name.capitalize()
        overall_vibe = f"The speaker appears {emotion_display.lower()} with {confidence:.0%} confidence."
        explanation = f"Analysis indicates {emotion_display.lower()} as the dominant emotion based on speech patterns and content."
        
        logger.info(
            f"[{request_id}] ✅ Audio emotion analysis successful | "
            f"emotion='{emotion_name}' | confidence={confidence:.3f} | "
            f"transcript_preview='{transcript[:50]}...'"
        )
        
        return {
            "success": True,
            "emotion": emotion_name,
            "confidence": confidence,
            "emotions": emotions,
            "transcript": transcript,
            "mood_category": mood_category,
            "energy_level": energy_level,
            "tone": tone,
            "emotional_intensity": emotional_intensity,
            "key_phrases": key_phrases,
            "overall_vibe": overall_vibe,
            "explanation": explanation
        }
        
    except Exception as e:
        logger.error(f"Audio file emotion analysis failed: {e}", exc_info=True)
        return {
            "success": False,
            "emotion": "neutral",
            "confidence": 0.0,
            "emotions": {
                "happiness": 0.0,
                "sadness": 0.0,
                "anger": 0.0,
                "fear": 0.0,
                "surprise": 0.0,
                "disgust": 0.0,
                "neutral": 1.0
            }
        }
