from __future__ import annotations

import os
import warnings
from threading import Lock
from typing import Any, Dict, Optional

import cv2
import numpy as np

from app.config import get_settings
from app.utils.logging import get_logger

logger = get_logger(__name__)

# Suppress warnings during import
with warnings.catch_warnings():
    warnings.simplefilter("ignore")
    try:
        # Try local copy first (in app folder)
        from app.services.models.hsemotion.facial_emotions import HSEmotionRecognizer
        HSEMOTION_AVAILABLE = True
    except ImportError:
        try:
            # Fallback to installed package
            from hsemotion.facial_emotions import HSEmotionRecognizer
            HSEMOTION_AVAILABLE = True
        except ImportError:
            HSEMOTION_AVAILABLE = False
            HSEmotionRecognizer = None


class HSEmotionDetector:
    """
    Emotion Detection Service using HSEmotion (EfficientNet-based model).
    
    This detector provides high-accuracy emotion recognition (~85-90%) using
    pre-trained EfficientNet models trained on the AffectNet dataset.
    
    Architecture:
    - Singleton pattern: Model loaded once per process, reused for all requests
    - Thread-safe: Safe for concurrent API requests
    - Face detection: Uses OpenCV Haar Cascade (lightweight, fast)
    - Emotion recognition: HSEmotion EfficientNet model
    
    Supported Emotions:
    - Anger, Contempt, Disgust, Fear, Happiness, Neutral, Sadness, Surprise
    
    Usage:
        detector = HSEmotionDetector.instance()
        result = detector.analyze_image(image_array)
        # Returns: {emotion, confidence, emotions dict, face_bbox}
    """

    _instance: "HSEmotionDetector | None" = None
    _lock: Lock = Lock()

    def __init__(self) -> None:
        if not HSEMOTION_AVAILABLE:
            raise RuntimeError(
                "HSEmotion library not available. Install with: pip install hsemotion"
            )

        settings = get_settings()
        device = settings.MODEL_DEVICE
        model_name = settings.EMOTION_MODEL_NAME
        self.neutral_confidence_threshold = settings.NEUTRAL_CONFIDENCE_THRESHOLD
        
        logger.info(f"Loading HSEmotion model: {model_name} on device: {device}")
        
        try:
            self.recognizer = HSEmotionRecognizer(model_name=model_name, device=device)
            logger.info("✅ HSEmotion model loaded successfully")
        except Exception as e:
            logger.error(f"Failed to load HSEmotion model: {e}", exc_info=True)
            raise

        # Map HSEmotion emotions to our standard format (lowercase)
        self.emotion_map = {
            "Anger": "anger",
            "Contempt": "contempt",
            "Disgust": "disgust",
            "Fear": "fear",
            "Happiness": "happiness",
            "Neutral": "neutral",
            "Sadness": "sadness",
            "Surprise": "surprise",
        }
        
        # For models with 7 emotions (no Contempt)
        self.emotion_map_7 = {
            "Anger": "anger",
            "Disgust": "disgust",
            "Fear": "fear",
            "Happiness": "happiness",
            "Neutral": "neutral",
            "Sadness": "sadness",
            "Surprise": "surprise",
        }

    @classmethod
    def instance(cls) -> "HSEmotionDetector":
        """
        Thread-safe lazy singleton accessor.
        """
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    @staticmethod
    def is_available() -> bool:
        """Check if HSEmotion library is available."""
        return HSEMOTION_AVAILABLE

    # Cache Haar Cascade classifier (load once, reuse)
    _face_cascade = None
    
    @classmethod
    def _get_face_cascade(cls):
        """Get cached Haar Cascade classifier."""
        if cls._face_cascade is None:
            cls._face_cascade = cv2.CascadeClassifier(
                cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
            )
        return cls._face_cascade
    
    # Maximum number of faces to run inference on per frame.
    # Faces are kept largest-first; extras are silently skipped.
    MAX_FACES_PER_FRAME: int = 6

    def _detect_all_faces(self, image: np.ndarray) -> list:
        """
        Detect ALL faces in an RGB image using OpenCV Haar Cascade.

        Returns a list of (x1, y1, x2, y2) tuples in original image
        coordinates, sorted left-to-right by x1 (stable spatial order,
        critical for per-tile tracking in gallery views).

        Performance guard: at most MAX_FACES_PER_FRAME faces are returned;
        the smallest are discarded first to keep CPU load bounded.
        """
        max_dimension = 800
        scale = 1.0

        working = image
        if image.shape[1] > max_dimension or image.shape[0] > max_dimension:
            scale = max_dimension / max(image.shape[1], image.shape[0])
            working = cv2.resize(
                image,
                (int(image.shape[1] * scale), int(image.shape[0] * scale)),
                interpolation=cv2.INTER_LINEAR,
            )

        gray = (
            cv2.cvtColor(working, cv2.COLOR_RGB2GRAY)
            if len(working.shape) == 3
            else working
        )

        faces = self._get_face_cascade().detectMultiScale(
            gray, scaleFactor=1.2, minNeighbors=4, minSize=(30, 30)
        )

        if len(faces) == 0:
            return []

        # Cap to MAX_FACES_PER_FRAME (keep the largest ones)
        if len(faces) > self.MAX_FACES_PER_FRAME:
            faces = sorted(faces, key=lambda f: f[2] * f[3], reverse=True)[: self.MAX_FACES_PER_FRAME]

        # Scale back to original coords and sort left-to-right
        inv = 1.0 / scale if scale < 1.0 else 1.0
        result = []
        for (x, y, w, h) in faces:
            x1 = int(x * inv)
            y1 = int(y * inv)
            x2 = int((x + w) * inv)
            y2 = int((y + h) * inv)
            result.append((x1, y1, x2, y2))

        result.sort(key=lambda b: b[0])  # left-to-right spatial order
        return result

    def _detect_face_simple(self, image: np.ndarray) -> Optional[tuple]:
        """
        Single-face detection: returns the largest face bbox or None.
        Kept for backwards compatibility with non-gallery callers.
        """
        faces = self._detect_all_faces(image)
        if not faces:
            return None
        # Return the largest by area among the already-capped list
        return max(faces, key=lambda b: (b[2] - b[0]) * (b[3] - b[1]))

    def _run_inference_on_crop(
        self, face_img: np.ndarray, face_bbox: tuple
    ) -> Optional[Dict[str, Any]]:
        """
        Run HSEmotion inference on a single pre-cropped face (RGB).

        Returns a result dict or None when inference fails / image is empty.
        This is the shared hot-path used by both analyze_image() and
        analyze_faces() so the neutral-fallback and emotion-map logic
        live in exactly one place.
        """
        if face_img.size == 0:
            return None
        try:
            emotion_label, scores = self.recognizer.predict_emotions(
                face_img, logits=False
            )
            emotion_map = self.emotion_map_7 if len(scores) == 7 else self.emotion_map
            emotion_lower = emotion_map.get(emotion_label, emotion_label.lower())
            emotion_names = list(emotion_map.values())
            emotions_dict = {
                name: float(score)
                for name, score in zip(emotion_names, scores)
            }
            confidence = float(scores[np.argmax(scores)])

            if emotion_lower != "neutral" and confidence < self.neutral_confidence_threshold:
                logger.debug(
                    f"HSEmotion: overriding '{emotion_lower}' ({confidence:.3f})"
                    f" → 'neutral' (below threshold {self.neutral_confidence_threshold})"
                )
                emotion_lower = "neutral"

            return {
                "face_detected": True,
                "emotions": emotions_dict,
                "emotion": emotion_lower,
                "confidence": confidence,
                "aus": {},
                "face_bbox": list(face_bbox),
            }
        except Exception as exc:
            logger.error(f"HSEmotion inference failed: {exc}", exc_info=True)
            return None

    def analyze_image(self, image: np.ndarray) -> Dict[str, Any]:
        """
        Analyze emotion for the single largest face in a BGR image.

        Kept for backward compatibility.  New multi-participant callers
        should use analyze_faces() instead.

        Args:
            image: BGR numpy array (OpenCV format).

        Returns:
            Single result dict with keys: face_detected, emotion,
            confidence, emotions, aus, face_bbox.
        """
        image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        face_bbox = self._detect_face_simple(image_rgb)

        if face_bbox is None:
            logger.debug("No face detected in image")
            return self._no_face_result()

        x1, y1, x2, y2 = face_bbox
        face_img = image_rgb[y1:y2, x1:x2]
        result = self._run_inference_on_crop(face_img, face_bbox)
        if result is None:
            return self._no_face_result(face_bbox)

        logger.debug(
            f"HSEmotion: {result['emotion']} (confidence: {result['confidence']:.3f})"
        )
        return result

    def analyze_faces(self, image: np.ndarray) -> list:
        """
        Detect ALL faces in a BGR frame and return emotion results for each.

        Designed for gallery-view scenarios (Zoom, multi-participant webcam)
        where multiple people appear in a single frame.

        Performance characteristics
        ---------------------------
        * Detection runs once per frame (shared Haar scan).
        * At most MAX_FACES_PER_FRAME faces are processed (CPU guard).
        * Faces are returned sorted left-to-right (stable spatial order)
          so callers can use x-position as a proxy participant ID.

        Args:
            image: BGR numpy array (OpenCV format), shape (H, W, 3).

        Returns:
            List of result dicts (one per detected face), each containing:
              face_detected  True
              emotion        dominant emotion label (str)
              confidence     dominant emotion probability (float)
              emotions       full emotion scores dict (str → float)
              aus            {} (HSEmotion does not provide AUs)
              face_bbox      [x1, y1, x2, y2] in original image coordinates
              face_index     0-based left-to-right position in the frame

            Empty list when no faces are detected.
        """
        image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        bboxes = self._detect_all_faces(image_rgb)

        if not bboxes:
            return []

        results = []
        for idx, bbox in enumerate(bboxes):
            x1, y1, x2, y2 = bbox
            face_img = image_rgb[y1:y2, x1:x2]
            result = self._run_inference_on_crop(face_img, bbox)
            if result is None:
                continue
            result["face_index"] = idx
            results.append(result)
            logger.debug(
                f"Face {idx}: {result['emotion']} "
                f"(conf={result['confidence']:.3f}, bbox={bbox})"
            )

        return results
    
    def _no_face_result(self, face_bbox: Optional[tuple] = None) -> Dict[str, Any]:
        """Return standardized result when no face is detected."""
        return {
            "face_detected": False,
            "emotions": {"neutral": 1.0},
            "emotion": "neutral",
            "confidence": 0.0,
            "aus": {},
            "face_bbox": face_bbox,
        }
