"""
Animal Emotion Detection Model — Singleton

Wraps milad-mousavi/vit-base-patch16-224-animal-emotion-recognition
(Vision Transformer, fine-tuned on cat/dog emotion images) via the
Hugging Face transformers image-classification pipeline.

Design decisions:
- Singleton pattern with double-checked locking (thread-safe, same as HSEmotionDetector)
- Lazy initialization: loads on first request, not on startup
- torch.no_grad() applied at inference time to reduce memory pressure
- CPU-only: Render Starter plan has no GPU; CPU torch is pre-installed
"""

from __future__ import annotations

import io
from threading import Lock
from typing import Any, Dict, List

import torch

from app.utils.logging import get_logger

logger = get_logger(__name__)

try:
    from transformers import pipeline as hf_pipeline
    from PIL import Image as PILImage

    TRANSFORMERS_AVAILABLE = True
except ImportError:
    TRANSFORMERS_AVAILABLE = False
    hf_pipeline = None  # type: ignore[assignment]
    PILImage = None  # type: ignore[assignment]


class AnimalEmotionModel:
    """
    Singleton ViT-based animal emotion classifier.

    Usage:
        model = AnimalEmotionModel.instance()
        results = model.predict(image_bytes)
        # [{"label": "happy", "score": 0.91}, {"label": "sad", "score": 0.06}, ...]
    """

    _instance: "AnimalEmotionModel | None" = None
    _lock: Lock = Lock()

    def __init__(self) -> None:
        if not TRANSFORMERS_AVAILABLE:
            raise RuntimeError(
                "transformers or Pillow not installed. "
                "Run: pip install transformers pillow"
            )

        from app.config import get_settings

        model_name = get_settings().ANIMAL_MODEL_NAME
        logger.info(f"Loading animal emotion model: {model_name}")

        try:
            self._pipe = hf_pipeline(
                "image-classification",
                model=model_name,
                device="cpu",
                top_k=None,  # return full probability distribution
            )
            logger.info("✅ Animal emotion model loaded successfully")
        except Exception as exc:
            logger.error(
                f"Failed to load animal emotion model '{model_name}': {exc}",
                exc_info=True,
            )
            raise

    # ------------------------------------------------------------------
    # Singleton accessor
    # ------------------------------------------------------------------

    @classmethod
    def instance(cls) -> "AnimalEmotionModel":
        """Thread-safe lazy singleton accessor."""
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    @staticmethod
    def is_available() -> bool:
        """Return True if transformers + Pillow are importable."""
        return TRANSFORMERS_AVAILABLE

    # ------------------------------------------------------------------
    # Inference
    # ------------------------------------------------------------------

    def predict(self, image_bytes: bytes) -> List[Dict[str, Any]]:
        """
        Run ViT inference on raw image bytes.

        Args:
            image_bytes: Raw JPEG/PNG bytes.

        Returns:
            List of dicts sorted by score descending:
            [{"label": "happy", "score": 0.91}, ...]
        """
        img = PILImage.open(io.BytesIO(image_bytes)).convert("RGB")

        with torch.no_grad():
            results: List[Dict[str, Any]] = self._pipe(img)

        # Sort highest score first (pipeline usually returns sorted, but ensure it)
        results.sort(key=lambda x: x["score"], reverse=True)
        logger.debug(
            f"Animal emotion top result: {results[0]['label']} "
            f"({results[0]['score']:.1%})"
        )
        return results
