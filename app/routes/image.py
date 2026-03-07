"""
Image Emotion Detection API Routes

Handles HTTP requests for emotion detection from uploaded images.
Validates input, calls service layer, and returns structured responses.
"""

import time

from fastapi import APIRouter, File, UploadFile
from fastapi import HTTPException, status

from app.models.schemas import ImageEmotionResponse
from app.services.image_emotion_service import analyze_image_emotion, analyze_image_emotion_debug
from app.utils.logging import get_logger, get_request_id
from app.utils.metrics import get_metrics

logger = get_logger(__name__)


router = APIRouter(tags=["Image Emotion"])


async def _validate_and_read_image(file: UploadFile) -> bytes:
    """
    Validate file type and read image bytes.
    
    Returns:
        Image bytes
        
    Raises:
        HTTPException: If file type is invalid or file is empty
    """
    filename = file.filename or "unknown"
    content_type = file.content_type or ""
    
    # Accept common image formats (OpenCV can decode these)
    allowed_types = {
        "image/jpeg", "image/jpg", "image/png", 
        "image/webp"  # WebP support added
    }
    
    # Also check filename extension as fallback
    allowed_extensions = {".jpg", ".jpeg", ".png", ".webp"}
    
    if content_type not in allowed_types:
        # Check filename extension if content_type is not recognized
        if not any(filename.lower().endswith(ext) for ext in allowed_extensions):
            logger.warning(f"Unsupported file type: filename='{filename}', content_type='{content_type}'")
            raise HTTPException(
                status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                detail="Unsupported file type. Please upload a JPG, PNG, or WebP image.",
            )
    
    image_bytes = await file.read()
    file_size_mb = len(image_bytes) / (1024 * 1024)
    
    if not image_bytes:
        logger.warning(f"Empty file uploaded: filename='{filename}'")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Empty file uploaded",
        )
    
    logger.info(f"Image file validated: filename='{filename}', content_type='{content_type}', size={file_size_mb:.2f}MB")
    return image_bytes


@router.post(
    "/image/emotion",
    response_model=ImageEmotionResponse,
    summary="Analyze emotion from a single image",
)
async def image_emotion(file: UploadFile = File(...)) -> ImageEmotionResponse:
    """
    Analyze emotion from uploaded image.
    
    Returns dominant emotion, confidence score, and metadata.
    """
    filename = file.filename or "unknown"
    request_id = get_request_id() or "unknown"
    
    try:
        logger.info(f"[{request_id}] Starting image emotion analysis: filename='{filename}'")
        
        image_bytes = await _validate_and_read_image(file)
        file_size_mb = len(image_bytes) / (1024 * 1024)

        # Track inference time
        start_time = time.time()
        result = analyze_image_emotion(image_bytes)
        inference_time_ms = (time.time() - start_time) * 1000
        get_metrics().record_model_inference(inference_time_ms)

        # Extract result details
        success = result.success
        emotion = result.emotion
        confidence = result.confidence
        
        if success:
            logger.info(
                f"[{request_id}] ✅ Image emotion analysis completed successfully | "
                f"emotion='{emotion}' | confidence={confidence:.3f} | "
                f"file_size={file_size_mb:.2f}MB | processing_time={inference_time_ms:.1f}ms"
            )
        else:
            logger.warning(
                f"[{request_id}] ⚠️ Image emotion analysis completed but no face detected | "
                f"filename='{filename}' | file_size={file_size_mb:.2f}MB | processing_time={inference_time_ms:.1f}ms"
            )
        
        return result
        
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except Exception as exc:
        logger.error(f"Emotion analysis failed: {exc}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to analyze image emotion: {exc}",
        ) from exc


@router.post(
    "/image/emotion/debug",
    summary="Debug endpoint (returns full emotion distribution)",
)
async def image_emotion_debug(file: UploadFile = File(...)) -> dict:
    """
    Debug endpoint: returns full detector output with all emotion scores.
    
    Useful for debugging and understanding model behavior.
    """
    try:
        image_bytes = await _validate_and_read_image(file)

        # Track inference time
        start_time = time.time()
        result = analyze_image_emotion_debug(image_bytes)
        inference_time_ms = (time.time() - start_time) * 1000
        get_metrics().record_model_inference(inference_time_ms)

        logger.debug(f"Debug inference completed in {inference_time_ms:.1f}ms")
        return result
        
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except Exception as exc:
        logger.error(f"Debug analysis failed: {exc}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to analyze image emotion: {exc}",
        ) from exc

