"""
Animal Emotion Detection Model — Singleton

Wraps dima806/pets_facial_expression_detection (ViT-base, 4 labels:
Angry / happy / Sad / Other) via Hugging Face transformers pipeline.

Performance optimisations applied:
- torch.inference_mode() — faster than no_grad(), disables autograd engine
- Pre-resize to 224×224 before pipeline — cuts internal preprocessing time
- torch.set_num_threads() — use all CPU cores available on Render
- Eager load at startup (called from main.py) — zero cold-start on first request
"""

from __future__ import annotations

import io
import os
from threading import Lock
from typing import Any, Dict, List

import torch

from app.utils.logging import get_logger

logger = get_logger(__name__)

# Use all available CPU threads for inference (Render has 1–2 vCPUs)
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

# ViT input size — pre-resizing to this avoids redundant work inside pipeline
_MODEL_INPUT_SIZE = (224, 224)


class AnimalEmotionModel:
    """
    Thread-safe singleton for ViT-based pet facial expression detection.

    Eager-loaded at startup via AnimalEmotionModel.instance() in main.py
    so the first user request experiences no cold-start delay.
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
        logger.info(f"Loading animal emotion model: {model_name} (threads={_cpu_threads})")

        try:
            self._pipe = hf_pipeline(
                "image-classification",
                model=model_name,
                device="cpu",
                top_k=None,
            )

            # Warm-up pass: primes torch JIT and fills caches so first real
            # request doesn't pay that cost.
            with torch.inference_mode():
                _dummy = PILImage.new("RGB", _MODEL_INPUT_SIZE, color=(128, 128, 128))
                self._pipe(_dummy)

            logger.info("✅ Animal emotion model loaded and warmed up successfully")
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
        """Thread-safe singleton accessor."""
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    @staticmethod
    def is_available() -> bool:
        return TRANSFORMERS_AVAILABLE

    # ------------------------------------------------------------------
    # Inference
    # ------------------------------------------------------------------

    def predict(self, image_bytes: bytes) -> List[Dict[str, Any]]:
        """
        Run ViT inference on raw image bytes.

        Pre-resizes to 224×224 (model input size) before entering the
        pipeline so the pipeline skips its own resize step.

        Returns list sorted by score descending:
            [{"label": "happy", "score": 0.91}, ...]
        """
        img = PILImage.open(io.BytesIO(image_bytes)).convert("RGB")

        # Pre-resize — avoids redundant work inside the pipeline processor
        if img.size != _MODEL_INPUT_SIZE:
            img = img.resize(_MODEL_INPUT_SIZE, PILImage.BILINEAR)

        with torch.inference_mode():
            results: List[Dict[str, Any]] = self._pipe(img)

        results.sort(key=lambda x: x["score"], reverse=True)
        logger.debug(
            f"Animal emotion: {results[0]['label']} ({results[0]['score']:.1%})"
        )
        return results
