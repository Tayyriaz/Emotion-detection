"""
Region-of-interest extraction for pet emotion (ViT) inference.

Human MediaPipe / Haar detectors must not run on animal images — this module
uses OpenCV cat-face cascades when possible and a safe center crop otherwise.
"""
from __future__ import annotations

from typing import Dict, List, Tuple

import cv2
import numpy as np

from app.config import get_settings
from app.utils.logging import get_logger

logger = get_logger(__name__)

_cat_cascade = None
_cat_extended_cascade = None


def _get_cat_cascades():
    global _cat_cascade, _cat_extended_cascade
    if _cat_cascade is None:
        _cat_cascade = cv2.CascadeClassifier(
            cv2.data.haarcascades + "haarcascade_frontalcatface.xml"
        )
    if _cat_extended_cascade is None:
        _cat_extended_cascade = cv2.CascadeClassifier(
            cv2.data.haarcascades + "haarcascade_frontalcatface_extended.xml"
        )
    return _cat_cascade, _cat_extended_cascade


def _expand_bbox(
    x: int,
    y: int,
    w: int,
    h: int,
    img_w: int,
    img_h: int,
    padding_ratio: float,
) -> Tuple[int, int, int, int]:
    pad_x = int(w * padding_ratio)
    pad_y = int(h * padding_ratio)
    x1 = max(0, x - pad_x)
    y1 = max(0, y - pad_y)
    x2 = min(img_w, x + w + pad_x)
    y2 = min(img_h, y + h + pad_y)
    return x1, y1, x2, y2


def detect_animal_roi_boxes(image_rgb: np.ndarray) -> Tuple[List[Tuple[int, int, int, int]], str]:
    """
    Return (boxes, method) for animal ViT cropping.

    Never calls MediaPipe. Cat haar when found; else centered square crop.
    """
    if image_rgb is None or image_rgb.size == 0:
        return [], "empty"

    height, width = image_rgb.shape[:2]
    gray = (
        cv2.cvtColor(image_rgb, cv2.COLOR_RGB2GRAY)
        if len(image_rgb.shape) == 3
        else image_rgb
    )

    faces: List[Tuple[int, int, int, int]] = []
    padding = get_settings().ANIMAL_ROI_PADDING_RATIO

    for cascade in _get_cat_cascades():
        if cascade.empty():
            continue
        detected = cascade.detectMultiScale(
            gray, scaleFactor=1.1, minNeighbors=3, minSize=(48, 48)
        )
        for (x, y, w, h) in detected:
            x1, y1, x2, y2 = _expand_bbox(x, y, w, h, width, height, padding)
            if x2 > x1 and y2 > y1:
                faces.append((x1, y1, x2, y2))

    if faces:
        faces.sort(key=lambda b: (b[2] - b[0]) * (b[3] - b[1]), reverse=True)
        logger.debug("Animal ROI: opencv_cat_face")
        return faces[:1], "opencv_cat_face"

    side = int(min(width, height) * 0.82)
    cx, cy = width // 2, height // 2
    x1 = max(0, cx - side // 2)
    y1 = max(0, cy - side // 2)
    x2 = min(width, x1 + side)
    y2 = min(height, y1 + side)
    logger.debug("Animal ROI: center_crop")
    return [(x1, y1, x2, y2)], "center_crop"


def crop_animal_roi(image_rgb: np.ndarray) -> Tuple[np.ndarray, Dict]:
    """Crop the primary animal ROI from an RGB numpy image."""
    height, width = image_rgb.shape[:2]
    boxes, method = detect_animal_roi_boxes(image_rgb)

    if not boxes:
        return image_rgb, {"method": "full_frame", "bbox": [0, 0, width, height]}

    x1, y1, x2, y2 = boxes[0]
    crop = image_rgb[y1:y2, x1:x2]
    if crop.size == 0:
        return image_rgb, {"method": "full_frame", "bbox": [0, 0, width, height]}

    return crop, {"method": method, "bbox": [x1, y1, x2, y2]}
