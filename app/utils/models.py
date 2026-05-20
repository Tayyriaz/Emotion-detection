"""
Animal Emotion Detection Model — Singleton

Wraps dima806/pets_facial_expression_detection (ViT-base, 4 labels:
Angry / happy / Sad / Other) via Hugging Face transformers pipeline.

Pet faces are cropped via app.services.animal_roi before inference —
never through human MediaPipe / HSEmotion detectors.
"""

from __future__ import annotations

import io
import os
from threading import Lock
from typing import Any, Dict, List, Tuple

import numpy as np
import torch

from app.config import get_settings
from app.services.animal_roi import crop_animal_roi
from app.utils.logging import get_logger

logger = get_logger(__name__)

_cpu_threads = int(os.environ.get("TORCH_NUM_THREADS", os.cpu_count() or 2))
torch.set_num_threads(_cpu_threads)

try:
    from transformers import pipeline as hf_pipeline
    from PIL import Image as PILImage

    TRANSFORMERS_AVAILABLE = True
except ImportError:
    TRANSFORMERS_AVAILABLE = False
    hf_pipeline = None  # type: ignore[assignment]
    PILImage = None  # type: ignore[assignment]

_MODEL_INPUT_SIZE = (224, 224)

# Canonical pet labels (model may return mixed case)
_ANIMAL_LABEL_MAP = {
    "angry": "angry",
    "happy": "happy",
    "sad": "sad",
    "other": "other",
}


def normalize_animal_label(label: str) -> str:
    return _ANIMAL_LABEL_MAP.get((label or "").strip().lower(), (label or "other").lower())


def _configure_hf_hub_timeout() -> None:
    """Apply download timeout before Hugging Face hub / pipeline loads."""
    seconds = int(get_settings().MODEL_DOWNLOAD_TIMEOUT_SECONDS)
    os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", str(seconds))
    os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", str(seconds))


class AnimalEmotionModel:
    """
    Thread-safe singleton for ViT-based pet facial expression detection.

    Loaded in the background via model_bootstrap; first request uses the same
    warmed pipeline as startup.
    """

    _instance: "AnimalEmotionModel | None" = None
    _lock: Lock = Lock()

    def __init__(self) -> None:
        if not TRANSFORMERS_AVAILABLE:
            raise RuntimeError(
                "transformers or Pillow not installed. "
                "Run: pip install transformers pillow"
            )

        _configure_hf_hub_timeout()
        model_name = get_settings().ANIMAL_MODEL_NAME
        logger.info(f"Loading animal emotion model: {model_name} (threads={_cpu_threads})")

        try:
            self._pipe = hf_pipeline(
                "image-classification",
                model=model_name,
                device="cpu",
                top_k=None,
            )

            with torch.inference_mode():
                warmup_rgb = np.zeros((224, 224, 3), dtype=np.uint8)
                warmup_rgb[80:144, 72:152] = 180  # coarse “face” patch
                warmup_img = PILImage.fromarray(warmup_rgb)
                crop, _meta = crop_animal_roi(np.array(warmup_img))
                warmup_crop = PILImage.fromarray(crop).resize(
                    _MODEL_INPUT_SIZE, PILImage.BILINEAR
                )
                self._pipe(warmup_crop)

            logger.info("✅ Animal emotion model loaded and warmed up successfully")
        except Exception as exc:
            logger.error(
                f"Failed to load animal emotion model '{model_name}': {exc}",
                exc_info=True,
            )
            raise

    @classmethod
    def instance(cls) -> "AnimalEmotionModel":
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    @staticmethod
    def is_available() -> bool:
        return TRANSFORMERS_AVAILABLE

    def predict(self, image_bytes: bytes) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
        """
        Run ViT on a pet-face crop (not the full frame).

        Returns (predictions sorted by score, metadata with roi method/bbox).
        """
        if not image_bytes:
            raise ValueError("Empty image bytes")

        pil_img = PILImage.open(io.BytesIO(image_bytes)).convert("RGB")
        image_rgb = np.array(pil_img)
        crop_rgb, roi_meta = crop_animal_roi(image_rgb)
        crop_img = PILImage.fromarray(crop_rgb)

        if crop_img.size != _MODEL_INPUT_SIZE:
            crop_img = crop_img.resize(_MODEL_INPUT_SIZE, PILImage.BILINEAR)

        with torch.inference_mode():
            raw: List[Dict[str, Any]] = self._pipe(crop_img)

        if not raw:
            raise RuntimeError("Animal ViT returned no predictions")

        predictions: List[Dict[str, Any]] = []
        for item in raw:
            label = normalize_animal_label(str(item.get("label", "other")))
            score = float(item.get("score", 0.0))
            predictions.append({"label": label, "score": score})

        predictions.sort(key=lambda x: x["score"], reverse=True)
        logger.debug(
            "Animal emotion: %s (%.1f%%) roi=%s",
            predictions[0]["label"],
            predictions[0]["score"] * 100,
            roi_meta.get("method"),
        )
        return predictions, roi_meta
