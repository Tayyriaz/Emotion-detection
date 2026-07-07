from typing import Dict, List, Optional

from pydantic import BaseModel


class ImageEmotionResponse(BaseModel):
    """Response model for single image emotion analysis (HSEmotion)."""

    success: bool
    emotion: str
    confidence: float
    emotions: Dict[str, float] = {}
    aus: Dict[str, float]
    backend: str
    # Coaching fields — always Optional so existing callers are unaffected
    reason: Optional[str] = None
    suggestion: Optional[str] = None


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
    # Coaching fields — always Optional so existing callers are unaffected
    reason: Optional[str] = None
    suggestion: Optional[str] = None


class AnimalEmotionResponse(BaseModel):
    """
    Response model for animal (cat/dog) emotion detection.

    Uses dima806/pets_facial_expression_detection via Hugging Face pipeline.
    """

    success: bool
    label: str                        # Top predicted emotion label (lowercase)
    confidence_score: float           # 0.0–1.0
    timestamp: str                    # ISO-8601 UTC timestamp
    all_emotions: Dict[str, float] = {}  # Full probability distribution
    backend: str = "vit-animal-emotion"
    roi_method: str = ""              # opencv_cat_face | center_crop | full_frame
    roi_bbox: List[int] = []          # [x1, y1, x2, y2] crop used for ViT
    guidance: str = ""                # Pet-specific copy (not human harmony rules)
    low_confidence: bool = False
    # Coaching fields — always Optional so existing callers are unaffected
    reason: Optional[str] = None
    suggestion: Optional[str] = None
