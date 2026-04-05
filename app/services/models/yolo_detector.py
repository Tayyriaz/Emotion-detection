"""
YOLO Pet Detection Service

Singleton YOLO detector for cat/dog detection using Ultralytics YOLOv8n/YOLO11n.
Filters detections to COCO classes 15 (cat) and 16 (dog) only.

Architecture mirrors HSEmotionDetector:
- Singleton pattern (loaded once per process, reused across requests)
- Thread-safe with double-checked locking
- Graceful degradation when ultralytics is not installed
"""

from __future__ import annotations

from threading import Lock
from typing import Any, Dict, List

import numpy as np

from app.config import get_settings
from app.utils.logging import get_logger

logger = get_logger(__name__)

# COCO dataset class IDs for pets
PET_CLASS_IDS = {15: "cat", 16: "dog"}

try:
    from ultralytics import YOLO as _YOLO

    YOLO_AVAILABLE = True
except ImportError:
    YOLO_AVAILABLE = False
    _YOLO = None  # type: ignore[assignment]


class YOLOPetDetector:
    """
    Pet Detection Service using Ultralytics YOLO (YOLOv8n / YOLO11n).

    Detects cats and dogs from images using COCO pretrained weights.
    Only class IDs 15 (cat) and 16 (dog) are returned; all other COCO
    detections are silently discarded.

    Architecture:
    - Singleton pattern: model loaded once, reused for all requests
    - Thread-safe: double-checked locking (same pattern as HSEmotionDetector)
    - Confidence threshold is configurable via PET_CONFIDENCE_THRESHOLD env var

    Usage:
        detector = YOLOPetDetector.instance()
        detections = detector.detect(bgr_image)
        # Returns: [{"label": "dog", "confidence": 0.93, "bbox": [x1, y1, x2, y2]}, ...]
    """

    _instance: "YOLOPetDetector | None" = None
    _lock: Lock = Lock()

    def __init__(self) -> None:
        if not YOLO_AVAILABLE:
            raise RuntimeError(
                "ultralytics not installed. "
                "Install with: pip install ultralytics"
            )

        settings = get_settings()
        model_name = settings.PET_MODEL_NAME

        logger.info(f"Loading YOLO model: {model_name}")

        try:
            self.model = _YOLO(model_name)

            # Warm-up: run one dummy inference so PyTorch JIT compiles the graph
            # before the first real request arrives
            dummy = np.zeros((640, 640, 3), dtype=np.uint8)
            self.model(dummy, verbose=False)

            logger.info("✅ YOLO pet detection model loaded and warmed up successfully")
        except Exception as exc:
            logger.error(f"Failed to load YOLO model '{model_name}': {exc}", exc_info=True)
            raise

    # ------------------------------------------------------------------
    # Singleton accessor
    # ------------------------------------------------------------------

    @classmethod
    def instance(cls) -> "YOLOPetDetector":
        """Thread-safe lazy singleton accessor."""
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    @staticmethod
    def is_available() -> bool:
        """Check if ultralytics is installed."""
        return YOLO_AVAILABLE

    # ------------------------------------------------------------------
    # Detection
    # ------------------------------------------------------------------

    def detect(self, image: np.ndarray) -> List[Dict[str, Any]]:
        """
        Run YOLO inference and return cat/dog detections only.

        Strategy:
        - Run YOLO with a very low internal threshold (0.01) so ALL objects
          come through, then apply our configurable threshold in Python.
        - This lets us log every detection at INFO level for easy debugging.

        Args:
            image: BGR or RGB numpy array (H, W, 3).  YOLO handles both.

        Returns:
            List of detection dicts, each with:
            - label (str): "cat" or "dog"
            - confidence (float): 0.0–1.0
            - bbox (list[int]): [x1, y1, x2, y2] in original image pixels
        """
        settings = get_settings()
        threshold = settings.PET_CONFIDENCE_THRESHOLD

        # Run at very low conf so YOLO returns everything; we filter in Python
        results = self.model(image, verbose=False, conf=0.01)

        all_labels: List[str] = []
        detections: List[Dict[str, Any]] = []

        for result in results:
            for box in result.boxes:
                cls_id = int(box.cls[0])
                conf = round(float(box.conf[0]), 3)
                cls_name = result.names.get(cls_id, str(cls_id))

                # Log every detection so we can diagnose missed pets
                all_labels.append(f"{cls_name}({conf:.2f})")

                if cls_id not in PET_CLASS_IDS:
                    continue  # not a cat or dog

                if conf < threshold:
                    logger.info(
                        f"YOLO skipped {cls_name} — conf {conf:.2f} "
                        f"below threshold {threshold:.2f}"
                    )
                    continue

                x1, y1, x2, y2 = (int(v) for v in box.xyxy[0].tolist())
                detections.append(
                    {
                        "label": PET_CLASS_IDS[cls_id],
                        "confidence": conf,
                        "bbox": [x1, y1, x2, y2],
                    }
                )

        logger.info(
            f"YOLO raw detections: [{', '.join(all_labels) or 'none'}] → "
            f"{len(detections)} pet(s) above threshold {threshold}"
        )
        return detections
