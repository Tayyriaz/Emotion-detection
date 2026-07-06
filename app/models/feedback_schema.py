"""
Feedback / Calibration Schemas

All request fields are Optional so the API is tolerant of partial
payloads from different frontend contexts (image, video, audio, animal).
Response is a simple acknowledgement — no breaking change to existing routes.
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, Literal, Optional

from pydantic import BaseModel, Field


# ── Supported modalities ────────────────────────────────────────────────────

MODALITY = Literal["image", "video", "audio", "animal"]

# Canonical emotion options per modality shown in the frontend dropdown
EMOTION_OPTIONS: Dict[str, list[str]] = {
    "image":  ["anger", "contempt", "disgust", "fear", "happiness", "neutral", "sadness", "surprise"],
    "video":  ["anger", "contempt", "disgust", "fear", "happiness", "neutral", "sadness", "surprise"],
    "audio":  ["anger", "disgust", "fear", "happiness", "neutral", "sadness", "surprise", "no_speech"],
    "animal": ["angry", "happy", "sad", "other"],
}


# ── Request ──────────────────────────────────────────────────────────────────

class FeedbackRequest(BaseModel):
    """
    Payload sent when a user clicks "I disagree with this result".

    All fields are Optional — the frontend fills what it has available
    at the time the button is clicked.
    """

    modality: MODALITY = Field(
        ...,
        description="Which modality produced the result (image/video/audio/animal)",
    )
    predicted_label: str = Field(
        ...,
        description="The label the model returned (e.g. 'sad')",
    )
    correct_label: Optional[str] = Field(
        None,
        description="What the user believes the correct label should be",
    )
    predicted_confidence: Optional[float] = Field(
        None,
        ge=0.0,
        le=1.0,
        description="Original confidence score (0–1)",
    )
    session_id: Optional[str] = Field(
        None,
        description="WebSocket session ID (video modality)",
    )
    request_id: Optional[str] = Field(
        None,
        description="X-Request-ID from the original inference request",
    )
    extra: Optional[Dict[str, Any]] = Field(
        None,
        description="Any additional context the frontend wants to attach",
    )


# ── Response ──────────────────────────────────────────────────────────────────

class FeedbackResponse(BaseModel):
    """Lightweight acknowledgement — no existing schema is modified."""

    success: bool
    feedback_id: str = Field(
        default_factory=lambda: str(uuid.uuid4()),
        description="Unique ID assigned to this feedback entry",
    )
    message: str = "Feedback received — thank you!"
