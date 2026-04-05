from typing import Dict, List

from pydantic import BaseModel


class ImageEmotionResponse(BaseModel):
    """Response model for single image emotion analysis (HSEmotion)."""

    success: bool
    emotion: str
    confidence: float
    emotions: Dict[str, float] = {}
    aus: Dict[str, float]
    backend: str


class AudioEmotionResponse(BaseModel):
    """Response model for audio emotion analysis (Groq Whisper + LLaMA)."""

    success: bool
    emotion: str
    confidence: float
    emotions: Dict[str, float]
    backend: str
    transcript: str = ""
    mood_category: str = ""
    energy_level: str = ""
    tone: str = ""
    emotional_intensity: float = 0.0
    key_phrases: list = []
    overall_vibe: str = ""
    explanation: str = ""


class AnimalEmotionResponse(BaseModel):
    """
    Response model for animal (cat/dog) emotion detection.

    Uses milad-mousavi/vit-base-patch16-224-animal-emotion-recognition
    via Hugging Face transformers pipeline.
    """

    success: bool
    label: str                        # Top predicted emotion label
    confidence_score: float           # 0.0–1.0
    timestamp: str                    # ISO-8601 UTC timestamp
    all_emotions: Dict[str, float] = {}  # Full probability distribution
    backend: str = "vit-animal-emotion"
