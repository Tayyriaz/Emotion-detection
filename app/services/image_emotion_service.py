"""
Image Emotion Analysis Service

High-level service functions for emotion detection from images.
Handles image decoding, emotion analysis, and response formatting.

This module provides the main business logic between API routes and
the emotion detection model (HSEmotion).
"""

from __future__ import annotations

from typing import Tuple

import cv2
import numpy as np

from app.models.schemas import ImageEmotionResponse
from app.services.models.hsemotion_detector import HSEmotionDetector
from app.utils.logging import get_logger

logger = get_logger(__name__)


def _bytes_to_ndarray(image_bytes: bytes) -> np.ndarray:
    """
    Decode raw image bytes into a BGR NumPy array using OpenCV.
    Optimized: Resize large images immediately for faster processing.
    """
    byte_array = np.frombuffer(image_bytes, dtype=np.uint8)
    image = cv2.imdecode(byte_array, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(
            "Unable to decode image. Please upload a valid JPG or PNG (HEIC/WEBP may not be supported)."
        )
    
    # Resize very large images for faster processing (max 1920px width)
    # This speeds up both face detection and emotion analysis
    max_width = 1920
    if image.shape[1] > max_width:
        scale = max_width / image.shape[1]
        new_width = max_width
        new_height = int(image.shape[0] * scale)
        image = cv2.resize(image, (new_width, new_height), interpolation=cv2.INTER_LINEAR)
        logger.debug(f"Resized image from {image.shape[1]}x{image.shape[0]} to {new_width}x{new_height} for faster processing")
    
    return image


def _select_dominant_emotion(emotions: dict) -> Tuple[str, float]:
    """
    Select the dominant emotion label and its confidence score.
    """

    if not emotions:
        return "unknown", 0.0

    label, score = max(emotions.items(), key=lambda item: item[1])
    return label, float(score)


def analyze_image_emotion(image_bytes: bytes) -> ImageEmotionResponse:
    """
    Analyze emotion from an uploaded image.
    
    Process:
    1. Decode image bytes to NumPy array (BGR format)
    2. Use HSEmotion detector to analyze facial expression
    3. Extract dominant emotion and confidence score
    4. Return structured response
    
    Args:
        image_bytes: Raw image file bytes (JPG/PNG)
        
    Returns:
        ImageEmotionResponse with emotion, confidence, and metadata
        
    Raises:
        ValueError: If image cannot be decoded
        RuntimeError: If HSEmotion model is not available
    """
    # Decode image from bytes
    image = _bytes_to_ndarray(image_bytes)
    logger.debug(f"Decoded image: shape={image.shape}, dtype={image.dtype}")

    # Get HSEmotion detector instance (singleton, loaded once)
    if not HSEmotionDetector.is_available():
        raise RuntimeError(
            "HSEmotion library not available. Install with: pip install hsemotion"
        )
    
    detector = HSEmotionDetector.instance()
    result = detector.analyze_image(image)

    # Extract results
    face_detected = bool(result.get("face_detected", False))
    emotions = result.get("emotions", {}) or {}
    emotion, confidence = _select_dominant_emotion(emotions)
    
    logger.debug(
        f"Analysis complete: face_detected={face_detected}, "
        f"emotion={emotion}, confidence={confidence:.3f}"
    )

    return ImageEmotionResponse(
        success=face_detected,
        emotion=emotion,
        confidence=confidence,
        emotions=emotions,  # All emotion scores for visualization
        aus={},  # HSEmotion doesn't provide AU scores
        backend="hsemotion",
    )


def analyze_image_emotion_debug(image_bytes: bytes) -> dict:
    """
    Debug endpoint: returns full detector output including all emotion scores.
    
    Returns raw detector output with full emotion distribution for debugging.
    """
    # Reuse main function logic
    image = _bytes_to_ndarray(image_bytes)
    logger.debug(f"Debug analysis: image shape={image.shape}")

    if not HSEmotionDetector.is_available():
        raise RuntimeError("HSEmotion library not available")
    
    detector = HSEmotionDetector.instance()
    result = detector.analyze_image(image)

    # Return full detector output
    return {
        "success": result.get("face_detected", False),
        "backend": "hsemotion",
        "emotion": result.get("emotion", "unknown"),
        "confidence": result.get("confidence", 0.0),
        "aus": {},
        "emotions": result.get("emotions", {}),  # Full distribution
        "face_detected": result.get("face_detected", False),
        "face_bbox": result.get("face_bbox"),
    }

