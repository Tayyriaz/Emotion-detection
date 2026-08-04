"""
Face / frame preprocessing for robust detection under varied lighting.

Used before HSEmotion inference and as a second-pass face detection retry.
"""
from __future__ import annotations

import cv2
import numpy as np


def normalize_face_lighting(face_rgb: np.ndarray) -> np.ndarray:
    """Apply CLAHE on the L channel to stabilise emotion reads in low light."""
    if face_rgb.size == 0:
        return face_rgb
    lab = cv2.cvtColor(face_rgb, cv2.COLOR_RGB2LAB)
    l_channel, a_channel, b_channel = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    l_channel = clahe.apply(l_channel)
    merged = cv2.merge([l_channel, a_channel, b_channel])
    return cv2.cvtColor(merged, cv2.COLOR_LAB2RGB)


def enhance_frame_for_detection(frame_rgb: np.ndarray) -> np.ndarray:
    """
    Boost contrast/brightness for a second face-detection pass when the
    first pass finds nothing (common in dim or back-lit scenes).
    """
    if frame_rgb.size == 0:
        return frame_rgb
    lab = cv2.cvtColor(frame_rgb, cv2.COLOR_RGB2LAB)
    l_channel, a_channel, b_channel = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
    l_channel = clahe.apply(l_channel)
    enhanced = cv2.cvtColor(
        cv2.merge([l_channel, a_channel, b_channel]), cv2.COLOR_LAB2RGB
    )
    if float(np.mean(l_channel)) < 85:
        enhanced = cv2.convertScaleAbs(enhanced, alpha=1.12, beta=12)
    return enhanced
