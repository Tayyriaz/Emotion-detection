"""
Groq API Client Wrapper

Handles Groq API calls for Whisper transcription and Llama emotion analysis.
Production-ready with error handling and retries.
"""

import json
import logging
from typing import Dict, Optional

from groq import Groq

from app.config import get_settings
from app.utils.logging import get_logger, get_request_id

logger = get_logger(__name__)
settings = get_settings()


class GroqClient:
    """
    Groq API client for audio emotion detection.
    
    Uses:
    - Whisper Large v3 for speech-to-text transcription
    - Llama 3.3 70B for emotion analysis from text
    """

    _instance: Optional["GroqClient"] = None

    def __init__(self):
        """Initialize Groq client."""
        api_key = settings.GROQ_API_KEY
        if not api_key:
            raise RuntimeError(
                "GROQ_API_KEY not set. Please set it in environment variables or .env file"
            )
        
        self.client = Groq(api_key=api_key)
        self.whisper_model = settings.GROQ_WHISPER_MODEL
        self.llama_model = settings.GROQ_LLAMA_MODEL
        
        logger.info(f"Groq client initialized: Whisper={self.whisper_model}, Llama={self.llama_model}")

    @classmethod
    def instance(cls) -> "GroqClient":
        """Get singleton instance."""
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @staticmethod
    def is_available() -> bool:
        """Check if Groq API is available."""
        return bool(settings.GROQ_API_KEY)

    def transcribe_audio(self, audio_data: bytes, sample_rate: int = 16000, filename: str = "audio.webm") -> str:
        """
        Transcribe audio to text using Groq Whisper.
        
        Args:
            audio_data: Audio file bytes (WAV, MP3, WebM, OGG, etc.)
            sample_rate: Audio sample rate (not used for file-based API)
            filename: Original filename to determine format
            
        Returns:
            Transcribed text string
        """
        try:
            import io
            import time
            
            request_id = get_request_id() or "unknown"
            file_size_kb = len(audio_data) / 1024
            
            # Determine MIME type from filename
            filename_lower = filename.lower()
            if filename_lower.endswith('.wav'):
                mime_type = 'audio/wav'
            elif filename_lower.endswith('.mp3'):
                mime_type = 'audio/mpeg'
            elif filename_lower.endswith('.webm'):
                mime_type = 'audio/webm'
            elif filename_lower.endswith('.ogg'):
                mime_type = 'audio/ogg'
            elif filename_lower.endswith('.m4a') or filename_lower.endswith('.mp4'):
                mime_type = 'audio/mp4'
            else:
                mime_type = 'audio/webm'  # Default
                logger.debug(f"[{request_id}] Unknown file extension, using default mime_type: {mime_type}")
            
            logger.info(
                f"[{request_id}] 🎤 Starting Whisper transcription | "
                f"filename='{filename}' | size={file_size_kb:.1f}KB | format={mime_type} | model={self.whisper_model}"
            )
            
            # Create file-like object from bytes
            audio_file = io.BytesIO(audio_data)
            audio_file.seek(0)
            
            # Read the bytes to pass to API
            file_bytes = audio_file.read()
            audio_file.close()
            
            # Track transcription time
            transcription_start = time.time()
            
            # Groq API expects file parameter as tuple: (filename, file_bytes, content_type)
            transcription = self.client.audio.transcriptions.create(
                file=(filename, file_bytes, mime_type),
                model=self.whisper_model,
                language="en",  # Can be made configurable
                response_format="text"
            )
            
            transcription_time_ms = (time.time() - transcription_start) * 1000
            
            # Handle response - Groq returns string directly when response_format="text"
            if isinstance(transcription, str):
                text = transcription.strip()
            else:
                text = str(transcription).strip()
            
            text_length = len(text)
            
            if not text or text_length < 1:
                logger.warning(
                    f"[{request_id}] ⚠️ Empty transcription received | "
                    f"filename='{filename}' | transcription_time={transcription_time_ms:.1f}ms"
                )
            else:
                logger.info(
                    f"[{request_id}] ✅ Transcription completed | "
                    f"text_length={text_length} chars | transcription_time={transcription_time_ms:.1f}ms | "
                    f"preview='{text[:50]}...'"
                )
            
            return text
            
        except Exception as e:
            logger.error(f"Transcription failed: {e}", exc_info=True)
            raise

    def analyze_emotion(self, text: str) -> Dict[str, any]:
        """
        Analyze emotion from text using Groq Llama 3.3.
        
        Args:
            text: Input text to analyze
            
        Returns:
            Dictionary with emotion scores and dominant emotion
        """
        if not text or len(text.strip()) < 3:
            # Return neutral if text is too short
            return {
                "emotions": {
                    "happiness": 0.0,
                    "sadness": 0.0,
                    "anger": 0.0,
                    "fear": 0.0,
                    "surprise": 0.0,
                    "disgust": 0.0,
                    "neutral": 1.0
                },
                "dominant_emotion": "neutral",
                "confidence": 1.0
            }

        # Create emotion analysis prompt
        prompt = f"""Analyze the following speech transcript and determine the emotional state.

Transcript: "{text}"

Return a JSON object with emotion scores (0.0 to 1.0) for these 7 emotions:
- happiness
- sadness
- anger
- fear
- surprise
- disgust
- neutral

Also provide:
- dominant_emotion: The emotion with highest score
- confidence: The score of dominant emotion

Format your response as valid JSON only:
{{
    "emotions": {{
        "happiness": 0.0-1.0,
        "sadness": 0.0-1.0,
        "anger": 0.0-1.0,
        "fear": 0.0-1.0,
        "surprise": 0.0-1.0,
        "disgust": 0.0-1.0,
        "neutral": 0.0-1.0
    }},
    "dominant_emotion": "emotion_name",
    "confidence": 0.0-1.0
}}"""

        try:
            import time
            
            request_id = get_request_id() or "unknown"
            text_length = len(text)
            
            logger.info(
                f"[{request_id}] 🧠 Starting Llama emotion analysis | "
                f"text_length={text_length} chars | model={self.llama_model}"
            )
            
            # Track emotion analysis time
            emotion_start = time.time()
            
            # Call Llama 3.3
            response = self.client.chat.completions.create(
                model=self.llama_model,
                messages=[
                    {
                        "role": "system",
                        "content": "You are an expert emotion analysis system. Always respond with valid JSON only."
                    },
                    {
                        "role": "user",
                        "content": prompt
                    }
                ],
                temperature=0.3,  # Lower temperature for more consistent results
                max_tokens=200,
                response_format={"type": "json_object"}
            )
            
            emotion_time_ms = (time.time() - emotion_start) * 1000
            
            # Parse response
            content = response.choices[0].message.content
            result = json.loads(content)
            
            # Validate and normalize emotions
            emotions = result.get("emotions", {})
            dominant_emotion = result.get("dominant_emotion", "neutral")
            confidence = float(result.get("confidence", 0.0))
            
            # Ensure all 7 emotions are present
            required_emotions = ["happiness", "sadness", "anger", "fear", "surprise", "disgust", "neutral"]
            for emotion in required_emotions:
                if emotion not in emotions:
                    emotions[emotion] = 0.0
            
            # Normalize scores to sum to ~1.0
            total = sum(emotions.values())
            if total > 0:
                emotions = {k: v / total for k, v in emotions.items()}
            
            # Ensure dominant emotion matches highest score
            if dominant_emotion not in emotions:
                dominant_emotion = max(emotions.items(), key=lambda x: x[1])[0]
                confidence = emotions[dominant_emotion]
            
            logger.info(
                f"[{request_id}] ✅ Emotion analysis completed | "
                f"emotion='{dominant_emotion}' | confidence={confidence:.3f} | "
                f"emotion_time={emotion_time_ms:.1f}ms"
            )
            
            return {
                "emotions": emotions,
                "dominant_emotion": dominant_emotion.lower(),
                "confidence": confidence
            }
            
        except json.JSONDecodeError as e:
            request_id = get_request_id() or "unknown"
            logger.error(
                f"[{request_id}] ❌ Failed to parse LLM response | "
                f"error={str(e)} | response_preview='{content[:100] if 'content' in locals() else 'N/A'}...'"
            )
            # Return neutral on parse error
            return {
                "emotions": {
                    "happiness": 0.0,
                    "sadness": 0.0,
                    "anger": 0.0,
                    "fear": 0.0,
                    "surprise": 0.0,
                    "disgust": 0.0,
                    "neutral": 1.0
                },
                "dominant_emotion": "neutral",
                "confidence": 1.0
            }
        except Exception as e:
            request_id = get_request_id() or "unknown"
            logger.error(
                f"[{request_id}] ❌ Emotion analysis failed | "
                f"error={str(e)}",
                exc_info=True
            )
            raise
