"""
Pydantic schemas for Body Language / Posture Detection (Phase 1).

All fields are Optional-friendly so the response can be returned even
when landmarks are partially missing — existing API contracts unaffected.
"""
from typing import List, Optional

from pydantic import BaseModel


class PostureResponse(BaseModel):
    """Response model for single-image posture analysis (MediaPipe Pose Lite)."""

    success: bool
    # "upright" | "slouching" | "leaning_left" | "leaning_right" | "crossed_arms" | "no_pose"
    posture_label: str = "no_pose"
    posture_confidence: float = 0.0          # 0.0–1.0 (based on landmark visibility)
    signals: List[str] = []                  # all detected signals (may be >1)
    landmarks_detected: bool = False
    backend: str = "mediapipe-tasks-pose-lite"
    processing_time_ms: float = 0.0
