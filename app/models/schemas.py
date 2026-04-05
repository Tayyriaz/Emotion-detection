from typing import Dict, List

from pydantic import BaseModel


class ImageEmotionResponse(BaseModel):
    """
    Response model for single image emotion analysis.

    Mirrors the contract defined in FUNCTION1_SINGLE_IMAGE_EMOTION_FLOW.md.
    """

    success: bool
    emotion: str
    confidence: float
    emotions: Dict[str, float] = {}  # All emotion scores (for visualization)
    aus: Dict[str, float]
    backend: str


class AudioEmotionResponse(BaseModel):
    """
    Response model for audio emotion analysis.
    
    Returns 7 emotion categories with confidence scores and additional metadata.
    """

    success: bool
    emotion: str
    confidence: float
    emotions: Dict[str, float]  # All 7 emotion scores
    backend: str
    transcript: str = ""  # Transcription text
    mood_category: str = ""  # Positive/Negative/Neutral
    energy_level: str = ""  # High/Medium/Low
    tone: str = ""  # Casual/Formal/etc
    emotional_intensity: float = 0.0  # 0.0-1.0
    key_phrases: list = []  # List of key phrases
    overall_vibe: str = ""  # Overall description
    explanation: str = ""  # Detailed explanation


class PetDetection(BaseModel):
    """Single pet detection result (one bounding box)."""

    label: str  # "cat" or "dog"
    confidence: float  # 0.0–1.0
    bbox: List[int]  # [x1, y1, x2, y2] in original image pixels


class PetDetectionResponse(BaseModel):
    """
    Response model for pet (cat/dog) detection from a single image.

    success=False means no pets were detected or the image could not be decoded.
    """

    success: bool
    count: int  # Total number of pets detected
    detections: List[PetDetection]  # One entry per bounding box
    backend: str = "yolo"