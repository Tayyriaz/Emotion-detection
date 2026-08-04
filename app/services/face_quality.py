"""
Face quality assessment — lighting, sharpness, size, and angle heuristics.

Returns actionable hints for the client when conditions hurt accuracy.
"""
from __future__ import annotations

from typing import Any, Dict, List, Tuple

import cv2
import numpy as np

from app.config import get_settings


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


def assess_face_quality(
    face_rgb: np.ndarray,
    bbox: Tuple[int, int, int, int],
    frame_shape: Tuple[int, ...],
) -> Dict[str, Any]:
    """
    Score face capture quality from 0 (unusable) to 1 (ideal).

    Parameters
    ----------
    face_rgb : cropped face in RGB
    bbox : (x1, y1, x2, y2) in full-frame coordinates
    frame_shape : (H, W, ...) of the source frame
    """
    settings = get_settings()
    frame_h, frame_w = int(frame_shape[0]), int(frame_shape[1])
    x1, y1, x2, y2 = bbox
    issues: List[str] = []
    hints: List[str] = []

    gray = cv2.cvtColor(face_rgb, cv2.COLOR_RGB2GRAY)
    brightness = float(np.mean(gray))
    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())

    face_area = max(1, (x2 - x1) * (y2 - y1))
    frame_area = max(1, frame_w * frame_h)
    size_ratio = face_area / frame_area

    cx = (x1 + x2) / 2.0
    cy = (y1 + y2) / 2.0
    offset_x = abs(cx - frame_w / 2.0) / max(frame_w / 2.0, 1.0)
    offset_y = abs(cy - frame_h / 2.0) / max(frame_h / 2.0, 1.0)
    center_offset = (offset_x + offset_y) / 2.0

    aspect = (x2 - x1) / max(y2 - y1, 1)
    aspect_dev = abs(aspect - 0.85)  # frontal faces ~ square-ish in bbox

    # Sub-scores
    if brightness < settings.FACE_MIN_BRIGHTNESS:
        issues.append("too_dark")
        hints.append("Move to brighter lighting or face a light source.")
        bright_score = brightness / settings.FACE_MIN_BRIGHTNESS
    elif brightness > settings.FACE_MAX_BRIGHTNESS:
        issues.append("too_bright")
        hints.append("Reduce backlight or lower screen/window glare on your face.")
        bright_score = max(0.0, 1.0 - (brightness - settings.FACE_MAX_BRIGHTNESS) / 80.0)
    else:
        mid = (settings.FACE_MIN_BRIGHTNESS + settings.FACE_MAX_BRIGHTNESS) / 2.0
        bright_score = 1.0 - abs(brightness - mid) / (mid - settings.FACE_MIN_BRIGHTNESS + 1e-6)
        bright_score = _clamp01(bright_score)

    sharp_score = _clamp01(sharpness / settings.FACE_MIN_SHARPNESS)
    if sharpness < settings.FACE_MIN_SHARPNESS:
        issues.append("blurry")
        hints.append("Hold still and clean the camera lens.")

    size_score = _clamp01(size_ratio / settings.FACE_MIN_SIZE_RATIO)
    if size_ratio < settings.FACE_MIN_SIZE_RATIO:
        issues.append("face_too_small")
        hints.append("Move closer so your face fills more of the frame.")

    angle_score = _clamp01(1.0 - center_offset * 0.9 - aspect_dev * 0.6)
    if center_offset > settings.FACE_MAX_CENTER_OFFSET or aspect_dev > settings.FACE_MAX_ASPECT_DEV:
        issues.append("face_angled")
        hints.append("Face the camera more directly — extreme angles reduce accuracy.")

    overall = _clamp01(
        bright_score * 0.35
        + sharp_score * 0.25
        + size_score * 0.20
        + angle_score * 0.20
    )

    if not hints and overall >= 0.75:
        hints.append("Good capture conditions.")

    return {
        "score": round(overall, 3),
        "brightness": round(brightness, 1),
        "sharpness": round(sharpness, 1),
        "size_ratio": round(size_ratio, 4),
        "angle_score": round(angle_score, 3),
        "issues": issues,
        "hints": hints,
        "reliable": overall >= settings.FACE_QUALITY_MIN_RELIABLE,
    }
