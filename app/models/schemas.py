from typing import Dict

from pydantic import BaseModel


class ImageEmotionResponse(BaseModel):
    """
    Response model for single image emotion analysis.

    Mirrors the contract defined in FUNCTION1_SINGLE_IMAGE_EMOTION_FLOW.md.
    """

    success: bool
    emotion: str
    confidence: float
    aus: Dict[str, float]
    backend: str


class AudioEmotionResponse(BaseModel):
    """
    Response model for audio emotion analysis.
    
    Returns 7 emotion categories with confidence scores.
    """

    success: bool
    emotion: str
    confidence: float
    emotions: Dict[str, float]  # All 7 emotion scores
    backend: str
