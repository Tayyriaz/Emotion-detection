"""
Background model loading — keeps FastAPI startup non-blocking.

Models load in a daemon thread so Uvicorn can accept HTTP/WebSocket traffic
immediately.  Health checks read bootstrap state without triggering a blocking
load on the request thread (unless inference endpoints call .instance()).
"""
from __future__ import annotations

import threading
from typing import Any, Dict, Optional

from app.utils.logging import get_logger

logger = get_logger(__name__)

_lock = threading.Lock()
_started = False

_hsemotion_ready = False
_hsemotion_loading = False
_hsemotion_error: Optional[str] = None

_animal_ready = False
_animal_loading = False
_animal_error: Optional[str] = None


def start_background_model_load(
    *,
    warmup_hsemotion: bool = True,
    load_animal: bool = True,
) -> None:
    """Spawn a single daemon thread to load ML models (idempotent)."""
    global _started, _hsemotion_loading, _animal_loading
    with _lock:
        if _started:
            return
        _started = True
        if warmup_hsemotion:
            _hsemotion_loading = True
        if load_animal:
            _animal_loading = True

    thread = threading.Thread(
        target=_worker,
        args=(warmup_hsemotion, load_animal),
        name="model-bootstrap",
        daemon=True,
    )
    thread.start()
    logger.info("Background model bootstrap started (server will not block on load)")


def get_status() -> Dict[str, Any]:
    """Snapshot of bootstrap progress for /health/model."""
    with _lock:
        return {
            "hsemotion": {
                "ready": _hsemotion_ready,
                "loading": _hsemotion_loading,
                "error": _hsemotion_error,
            },
            "animal": {
                "ready": _animal_ready,
                "loading": _animal_loading,
                "error": _animal_error,
            },
        }


def _worker(warmup_hsemotion: bool, load_animal: bool) -> None:
    global _hsemotion_ready, _hsemotion_loading, _hsemotion_error
    global _animal_ready, _animal_loading, _animal_error

    if warmup_hsemotion:
        try:
            from app.services.models.hsemotion_detector import HSEmotionDetector

            if not HSEmotionDetector.is_available():
                raise RuntimeError("HSEmotion not installed (pip install hsemotion)")

            detector = HSEmotionDetector.instance()
            logger.info("✅ HSEmotion model loaded (background)")

            from app.config import get_settings

            if get_settings().MODEL_WARMUP:
                import numpy as np

                try:
                    dummy = np.ones((224, 224, 3), dtype=np.uint8) * 128
                    detector.analyze_image(dummy)
                    logger.info("✅ HSEmotion warmup completed (background)")
                except Exception as warmup_exc:
                    logger.warning(
                        "HSEmotion warmup skipped (model still ready): %s",
                        warmup_exc,
                    )

            with _lock:
                _hsemotion_ready = True
                _hsemotion_error = None
        except Exception as exc:
            logger.error(f"❌ HSEmotion background load failed: {exc}", exc_info=True)
            with _lock:
                _hsemotion_error = str(exc)
        finally:
            with _lock:
                _hsemotion_loading = False

    if load_animal:
        try:
            from app.utils.models import AnimalEmotionModel

            if not AnimalEmotionModel.is_available():
                raise RuntimeError("transformers not installed")

            AnimalEmotionModel.instance()
            logger.info("✅ Animal ViT model loaded (background)")

            with _lock:
                _animal_ready = True
                _animal_error = None
        except Exception as exc:
            logger.warning(
                f"⚠️ Animal model background load failed: {exc} — "
                "will retry on first /api/animal/analyze",
                exc_info=True,
            )
            with _lock:
                _animal_error = str(exc)
        finally:
            with _lock:
                _animal_loading = False

    logger.info("Background model bootstrap finished")
