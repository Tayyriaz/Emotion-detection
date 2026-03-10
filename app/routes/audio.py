"""
Audio Emotion Detection API Routes

REST endpoint for audio file upload and emotion detection.
Supports audio recording upload and file upload.
"""

import time

from fastapi import APIRouter, File, UploadFile, HTTPException, status

from app.config import get_settings
from app.models.schemas import AudioEmotionResponse
from app.services.audio_emotion_service import analyze_audio_file
from app.utils.logging import get_logger, get_request_id
from app.utils.metrics import get_metrics

logger = get_logger(__name__)
settings = get_settings()

router = APIRouter(tags=["Audio Emotion"])


async def _validate_and_read_audio(file: UploadFile) -> bytes:
    """
    Validate file type and read audio bytes.
    
    Returns:
        Audio bytes
        
    Raises:
        HTTPException: If file type is invalid or file is empty
    """
    filename = file.filename or "unknown"
    content_type = file.content_type or ""
    
    logger.info(f"Validating audio file: filename='{filename}', content_type='{content_type}'")
    
    # Accept common audio formats (MP3 fully supported)
    allowed_types = {
        "audio/wav", "audio/x-wav", "audio/wave",
        "audio/mpeg", "audio/mp3", "audio/mpeg3", "audio/x-mpeg",  # MP3 formats
        "audio/webm", "audio/ogg", "audio/oga",
        "audio/x-m4a", "audio/mp4", "audio/m4a",
        "audio/flac", "audio/x-flac"  # Additional formats
    }
    
    # Supported file extensions
    supported_extensions = [".wav", ".mp3", ".webm", ".ogg", ".m4a", ".mp4", ".flac"]
    
    if content_type not in allowed_types:
        # Also check filename extension (MP3 support)
        if not any(filename.lower().endswith(ext) for ext in supported_extensions):
            logger.warning(f"Unsupported file type: filename='{filename}', content_type='{content_type}'")
            raise HTTPException(
                status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                detail=f"Unsupported file type. Please upload a supported audio file: {', '.join(supported_extensions).upper()}",
            )
    
    audio_bytes = await file.read()
    file_size_mb = len(audio_bytes) / (1024 * 1024)
    
    if not audio_bytes:
        logger.warning(f"Empty file uploaded: filename='{filename}'")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Empty file uploaded",
        )
    
    # Check file size (max 10MB)
    max_size_mb = 10
    if len(audio_bytes) > max_size_mb * 1024 * 1024:
        logger.warning(f"File too large: filename='{filename}', size={file_size_mb:.2f}MB, max={max_size_mb}MB")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"File too large. Maximum size is {max_size_mb}MB.",
        )
    
    logger.info(f"Audio file validated: filename='{filename}', size={file_size_mb:.2f}MB, type='{content_type}'")
    return audio_bytes


@router.post(
    "/api/audio/analyze",
    response_model=AudioEmotionResponse,
    summary="Analyze emotion from uploaded audio file (client API)",
)
async def audio_emotion_analyze(audio_file: UploadFile = File(..., alias="audio_file")) -> AudioEmotionResponse:
    """
    Analyze emotion from uploaded audio file.
    
    Supports:
    - WAV, MP3, WebM, OGG audio formats
    - Recorded audio from microphone
    - Uploaded audio files
    
    Returns dominant emotion, confidence score, and all emotion scores.
    """
    filename = audio_file.filename or "audio.webm"
    request_id = get_request_id() or "unknown"
    
    try:
        logger.info(f"[{request_id}] Starting audio emotion analysis: filename='{filename}'")
        
        # Validate file parameter
        if not audio_file:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No audio file provided. Please upload an audio file."
            )
        
        audio_bytes = await _validate_and_read_audio(audio_file)
        file_size_mb = len(audio_bytes) / (1024 * 1024)

        # Track inference time
        start_time = time.time()
        result = analyze_audio_file(audio_bytes, filename=filename)
        inference_time_ms = (time.time() - start_time) * 1000
        get_metrics().record_model_inference(inference_time_ms)

        # Extract result details
        success = result.get("success", False)
        emotion = result.get("emotion", "neutral")
        confidence = result.get("confidence", 0.0)
        emotions = result.get("emotions", {})
        
        # Professional logging with structured data
        if success:
            logger.info(
                f"[{request_id}] ✅ Audio emotion analysis completed successfully | "
                f"emotion='{emotion}' | confidence={confidence:.3f} | "
                f"file_size={file_size_mb:.2f}MB | processing_time={inference_time_ms:.1f}ms"
            )
        else:
            logger.warning(
                f"[{request_id}] ⚠️ Audio emotion analysis completed but no speech detected | "
                f"filename='{filename}' | file_size={file_size_mb:.2f}MB | processing_time={inference_time_ms:.1f}ms"
            )
        
        return AudioEmotionResponse(
            success=success,
            emotion=emotion,
            confidence=confidence,
            emotions=emotions,
            backend="groq",
            transcript=result.get("transcript", ""),
            mood_category=result.get("mood_category", ""),
            energy_level=result.get("energy_level", ""),
            tone=result.get("tone", ""),
            emotional_intensity=result.get("emotional_intensity", 0.0),
            key_phrases=result.get("key_phrases", []),
            overall_vibe=result.get("overall_vibe", ""),
            explanation=result.get("explanation", "")
        )
        
    except HTTPException:
        raise
    except ValueError as exc:
        logger.warning(f"[{request_id}] ⚠️ Validation error: {str(exc)} | filename='{filename}'")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except Exception as exc:
        logger.error(
            f"[{request_id}] ❌ Audio emotion analysis failed | "
            f"filename='{filename}' | error={str(exc)}",
            exc_info=True
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to analyze audio emotion: {exc}",
        ) from exc


@router.post(
    "/audio/emotion",
    response_model=AudioEmotionResponse,
    summary="Analyze emotion from uploaded audio file (legacy endpoint)",
)
async def audio_emotion(file: UploadFile = File(...)) -> AudioEmotionResponse:
    """
    Legacy endpoint - use /api/audio/analyze instead.
    """
    return await audio_emotion_analyze(file)
