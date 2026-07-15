from __future__ import annotations

import os
import urllib.request
import warnings
from pathlib import Path
from threading import Lock
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np

from app.config import get_settings
from app.utils.logging import get_logger

logger = get_logger(__name__)

# High-arousal negatives that are often confused with neutral/tired faces.
_NEGATIVE_HIGH_AROUSAL = frozenset({"anger", "fear", "disgust", "contempt"})
# When top score is below this and neutral is within _NEUTRAL_AMBIGUITY_MARGIN, prefer neutral.
_NEUTRAL_AMBIGUITY_CEILING = 0.62
_NEUTRAL_AMBIGUITY_MARGIN = 0.08
# High-arousal labels need threshold + this delta (kept small to avoid over-neutralising)
_HIGH_AROUSAL_EXTRA = 0.03


def apply_neutral_priority_guard(
    emotion: str,
    confidence: float,
    emotions: Dict[str, float],
    threshold: float,
) -> tuple[str, float]:
    """
    Step down to neutral when the winning class is too weak or statistically
    tied with neutral — reduces false stressed/anxious labels on resting faces.

    Used by HSEmotionDetector and image_emotion_service so all paths share
    the same guard logic.
    """
    emotion = (emotion or "neutral").lower()
    neutral_score = float(emotions.get("neutral", 0.0))
    top_score = float(confidence)

    if emotion == "neutral":
        return "neutral", neutral_score if neutral_score > 0 else top_score

    # Guard 1: top non-neutral does not clear the confidence bar
    if top_score < threshold:
        logger.debug(
            f"Neutral guard: '{emotion}' ({top_score:.3f}) < threshold {threshold:.3f}"
        )
        return "neutral", neutral_score

    # Guard 2: high-arousal labels need a slightly higher bar (fear/anger false positives)
    if emotion in _NEGATIVE_HIGH_AROUSAL and top_score < threshold + _HIGH_AROUSAL_EXTRA:
        logger.debug(
            f"Neutral guard: weak high-arousal '{emotion}' ({top_score:.3f})"
        )
        return "neutral", neutral_score

    # Guard 3: neutral is a close second — tired/ambiguous expression
    if (
        top_score < _NEUTRAL_AMBIGUITY_CEILING
        and neutral_score >= top_score - _NEUTRAL_AMBIGUITY_MARGIN
    ):
        logger.debug(
            f"Neutral guard: '{emotion}' ({top_score:.3f}) ≈ neutral ({neutral_score:.3f})"
        )
        return "neutral", neutral_score

    return emotion, top_score


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

# Optional MediaPipe face detection (Issue #1 — obstructions / tilt)
MEDIAPIPE_AVAILABLE = False
MEDIAPIPE_HAS_SOLUTIONS = False
MEDIAPIPE_HAS_TASKS = False
_mp = None
try:
    import mediapipe as _mp  # type: ignore[import-untyped]

    MEDIAPIPE_AVAILABLE = True
    MEDIAPIPE_HAS_SOLUTIONS = hasattr(_mp, "solutions") and hasattr(
        _mp.solutions, "face_detection"
    )
    MEDIAPIPE_HAS_TASKS = hasattr(_mp, "tasks") and hasattr(
        _mp.tasks, "vision"
    )
except ImportError:
    pass


def mediapipe_face_detection_usable() -> bool:
    """True when at least one supported MediaPipe face API is present."""
    return MEDIAPIPE_AVAILABLE and (MEDIAPIPE_HAS_SOLUTIONS or MEDIAPIPE_HAS_TASKS)


class HSEmotionDetector:
    """
    Emotion Detection Service using HSEmotion (EfficientNet-based model).
    
    This detector provides high-accuracy emotion recognition (~85-90%) using
    pre-trained EfficientNet models trained on the AffectNet dataset.
    
    Architecture:
    - Singleton pattern: Model loaded once per process, reused for all requests
    - Thread-safe: Safe for concurrent API requests
    - Face detection: MediaPipe when installed; OpenCV Haar Cascade fallback
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
    _mp_face_detection = None  # legacy mp.solutions.face_detection
    _mp_tasks_detector = None  # mediapipe.tasks.vision.FaceDetector (0.10.31+)
    _mp_tasks_init_failed: bool = False  # e.g. missing libGLESv2 on server
    _mp_lock: Lock = Lock()
    _logged_face_backend = False

    @classmethod
    def mediapipe_available(cls) -> bool:
        return mediapipe_face_detection_usable()

    @classmethod
    def active_face_backend(cls) -> str:
        """Human-readable backend label for logging / health checks."""
        settings = get_settings()
        if settings.FACE_DETECTION_BACKEND == "opencv":
            return "opencv_haar"
        if not mediapipe_face_detection_usable():
            return "opencv_haar"
        if MEDIAPIPE_HAS_TASKS and not cls._mp_tasks_init_failed:
            return "mediapipe_tasks"
        if MEDIAPIPE_HAS_SOLUTIONS:
            return "mediapipe_legacy"
        return "opencv_haar"

    def _prefer_mediapipe(self) -> bool:
        settings = get_settings()
        if settings.FACE_DETECTION_BACKEND == "opencv":
            return False
        if HSEmotionDetector._mp_tasks_init_failed and not MEDIAPIPE_HAS_SOLUTIONS:
            return False
        if settings.FACE_DETECTION_BACKEND == "mediapipe":
            return mediapipe_face_detection_usable() and not HSEmotionDetector._mp_tasks_init_failed
        return mediapipe_face_detection_usable() and not HSEmotionDetector._mp_tasks_init_failed

    def _log_face_backend_once(self) -> None:
        if HSEmotionDetector._logged_face_backend:
            return
        HSEmotionDetector._logged_face_backend = True
        backend = self.active_face_backend()
        if backend.startswith("mediapipe"):
            logger.info(
                f"Face detection: MediaPipe ({backend}); Haar cascade as fallback"
            )
        else:
            logger.info(
                "Face detection: OpenCV Haar cascade "
                "(install mediapipe for improved detection with hats/glasses)"
            )

    @classmethod
    def _get_face_cascade(cls):
        """Get cached Haar Cascade classifier."""
        if cls._face_cascade is None:
            cls._face_cascade = cv2.CascadeClassifier(
                cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
            )
        return cls._face_cascade

    @classmethod
    def _resolve_mediapipe_face_model_path(cls) -> str:
        """Download/cache the full-range BlazeFace TFLite model for the Tasks API."""
        settings = get_settings()
        model_path = Path(settings.MEDIAPIPE_FACE_MODEL_PATH)
        if model_path.is_file():
            return str(model_path.resolve())

        model_path.parent.mkdir(parents=True, exist_ok=True)
        logger.info(f"Downloading MediaPipe face model to {model_path}…")
        timeout = settings.MODEL_DOWNLOAD_TIMEOUT_SECONDS
        with urllib.request.urlopen(settings.MEDIAPIPE_FACE_MODEL_URL, timeout=timeout) as resp:
            model_path.write_bytes(resp.read())
        logger.info("MediaPipe face model cached")
        return str(model_path.resolve())

    @classmethod
    def _get_mediapipe_face_detection_legacy(cls):
        """Lazy singleton for MediaPipe FaceDetection (legacy solutions API, <0.10.31)."""
        if not MEDIAPIPE_HAS_SOLUTIONS or _mp is None:
            return None
        if cls._mp_face_detection is None:
            settings = get_settings()
            cls._mp_face_detection = _mp.solutions.face_detection.FaceDetection(
                model_selection=1,  # full-range (Zoom / gallery views)
                min_detection_confidence=settings.MEDIAPIPE_MIN_DETECTION_CONFIDENCE,
            )
        return cls._mp_face_detection

    @classmethod
    def _get_mediapipe_tasks_detector(cls):
        """Lazy singleton for MediaPipe Tasks FaceDetector (0.10.31+)."""
        if not MEDIAPIPE_HAS_TASKS or _mp is None or cls._mp_tasks_init_failed:
            return None
        if cls._mp_tasks_detector is None:
            settings = get_settings()
            model_path = cls._resolve_mediapipe_face_model_path()
            options = _mp.tasks.vision.FaceDetectorOptions(
                base_options=_mp.tasks.BaseOptions(model_asset_path=model_path),
                running_mode=_mp.tasks.vision.RunningMode.IMAGE,
                min_detection_confidence=settings.MEDIAPIPE_MIN_DETECTION_CONFIDENCE,
            )
            try:
                cls._mp_tasks_detector = _mp.tasks.vision.FaceDetector.create_from_options(
                    options
                )
            except OSError as exc:
                cls._mp_tasks_init_failed = True
                logger.warning(
                    "MediaPipe Tasks unavailable (%s); using OpenCV Haar fallback",
                    exc,
                )
                return None
        return cls._mp_tasks_detector

    # Maximum number of faces to run inference on per frame.
    # Faces are kept largest-first; extras are silently skipped.
    MAX_FACES_PER_FRAME: int = 6

    @staticmethod
    def _bbox_area(bbox: Tuple[int, int, int, int]) -> int:
        x1, y1, x2, y2 = bbox
        return max(0, x2 - x1) * max(0, y2 - y1)

    @staticmethod
    def _expand_and_clamp_bbox(
        x1: int,
        y1: int,
        x2: int,
        y2: int,
        height: int,
        width: int,
        padding_ratio: float,
    ) -> Tuple[int, int, int, int]:
        """Pad face box slightly, then clamp to image bounds for safe crops."""
        bw = max(1, x2 - x1)
        bh = max(1, y2 - y1)
        pad_x = int(bw * padding_ratio)
        pad_y = int(bh * padding_ratio)
        x1 = max(0, x1 - pad_x)
        y1 = max(0, y1 - pad_y)
        x2 = min(width, x2 + pad_x)
        y2 = min(height, y2 + pad_y)
        return x1, y1, x2, y2

    def _finalize_face_boxes(
        self,
        boxes: List[Tuple[int, int, int, int]],
        height: int,
        width: int,
    ) -> List[Tuple[int, int, int, int]]:
        """Drop invalid boxes, cap count, sort left-to-right."""
        padding = get_settings().FACE_BBOX_PADDING_RATIO
        valid: List[Tuple[int, int, int, int]] = []
        for x1, y1, x2, y2 in boxes:
            x1, y1, x2, y2 = self._expand_and_clamp_bbox(
                x1, y1, x2, y2, height, width, padding
            )
            if x2 > x1 and y2 > y1:
                valid.append((x1, y1, x2, y2))
        if not valid:
            return []
        if len(valid) > self.MAX_FACES_PER_FRAME:
            valid = sorted(valid, key=self._bbox_area, reverse=True)[
                : self.MAX_FACES_PER_FRAME
            ]
        valid.sort(key=lambda b: b[0])
        return valid

    def _detect_all_faces_mediapipe_legacy(
        self, image: np.ndarray
    ) -> List[Tuple[int, int, int, int]]:
        """Legacy mp.solutions.face_detection (MediaPipe <0.10.31)."""
        detector = self._get_mediapipe_face_detection_legacy()
        if detector is None:
            return []

        height, width = image.shape[:2]
        rgb = image
        if len(image.shape) == 2:
            rgb = cv2.cvtColor(image, cv2.COLOR_GRAY2RGB)

        with self._mp_lock:
            results = detector.process(rgb)

        if not results.detections:
            return []

        min_conf = get_settings().MEDIAPIPE_MIN_DETECTION_CONFIDENCE
        boxes: List[Tuple[int, int, int, int]] = []
        for detection in results.detections:
            score = detection.score[0] if detection.score else 1.0
            if score < min_conf:
                continue
            bb = detection.location_data.relative_bounding_box
            x1 = int(bb.xmin * width)
            y1 = int(bb.ymin * height)
            x2 = int((bb.xmin + bb.width) * width)
            y2 = int((bb.ymin + bb.height) * height)
            boxes.append((x1, y1, x2, y2))

        return self._finalize_face_boxes(boxes, height, width)

    def _detect_all_faces_mediapipe_tasks(
        self, image: np.ndarray
    ) -> List[Tuple[int, int, int, int]]:
        """MediaPipe Tasks FaceDetector (0.10.31+, no mp.solutions)."""
        detector = self._get_mediapipe_tasks_detector()
        if detector is None:
            return []

        height, width = image.shape[:2]
        rgb = image
        if len(image.shape) == 2:
            rgb = cv2.cvtColor(image, cv2.COLOR_GRAY2RGB)
        rgb = np.ascontiguousarray(rgb)

        mp_image = _mp.Image(image_format=_mp.ImageFormat.SRGB, data=rgb)
        with self._mp_lock:
            result = detector.detect(mp_image)

        if not result.detections:
            return []

        min_conf = get_settings().MEDIAPIPE_MIN_DETECTION_CONFIDENCE
        boxes: List[Tuple[int, int, int, int]] = []
        for detection in result.detections:
            score = (
                float(detection.categories[0].score)
                if detection.categories
                else 1.0
            )
            if score < min_conf:
                continue
            bb = detection.bounding_box
            x1 = int(bb.origin_x)
            y1 = int(bb.origin_y)
            x2 = int(bb.origin_x + bb.width)
            y2 = int(bb.origin_y + bb.height)
            boxes.append((x1, y1, x2, y2))

        return self._finalize_face_boxes(boxes, height, width)

    def _detect_all_faces_mediapipe(self, image: np.ndarray) -> List[Tuple[int, int, int, int]]:
        """
        Detect faces with MediaPipe (RGB input).

        Uses Tasks API on 0.10.31+ wheels; legacy solutions API on older builds.
        Bounding boxes are (x1, y1, x2, y2) for the existing HSEmotion crop path.
        """
        if MEDIAPIPE_HAS_TASKS:
            return self._detect_all_faces_mediapipe_tasks(image)
        if MEDIAPIPE_HAS_SOLUTIONS:
            return self._detect_all_faces_mediapipe_legacy(image)
        return []

    def _detect_all_faces_haar(self, image: np.ndarray) -> List[Tuple[int, int, int, int]]:
        """OpenCV Haar Cascade fallback (RGB input)."""
        height, width = image.shape[:2]
        max_dimension = 800
        scale = 1.0

        working = image
        if width > max_dimension or height > max_dimension:
            scale = max_dimension / max(width, height)
            working = cv2.resize(
                image,
                (int(width * scale), int(height * scale)),
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

        inv = 1.0 / scale if scale < 1.0 else 1.0
        boxes: List[Tuple[int, int, int, int]] = []
        for (x, y, w, h) in faces:
            x1 = int(x * inv)
            y1 = int(y * inv)
            x2 = int((x + w) * inv)
            y2 = int((y + h) * inv)
            boxes.append((x1, y1, x2, y2))

        return self._finalize_face_boxes(boxes, height, width)

    def _detect_all_faces_animal(
        self, image: np.ndarray
    ) -> List[Tuple[int, int, int, int]]:
        """
        Animal ROI boxes — never uses MediaPipe (human-only).

        Delegates to app.services.animal_roi (cat haar + center crop).
        """
        from app.services.animal_roi import detect_animal_roi_boxes

        boxes, _method = detect_animal_roi_boxes(image)
        if not boxes:
            height, width = image.shape[:2]
            return [(0, 0, width, height)]
        return boxes

    def _detect_all_faces(
        self,
        image: np.ndarray,
        *,
        target: str = "human",
    ) -> List[Tuple[int, int, int, int]]:
        """
        Detect face / ROI boxes in an RGB image.

        target="human"  → MediaPipe Tasks or Haar (HSEmotion pipeline).
        target="animal" → pet ROI only (no MediaPipe).

        Returns (x1, y1, x2, y2) tuples in original image coordinates, sorted
        left-to-right. At most MAX_FACES_PER_FRAME faces are returned.
        """
        if target == "animal":
            return self._detect_all_faces_animal(image)

        self._log_face_backend_once()

        if self._prefer_mediapipe():
            mp_boxes = self._detect_all_faces_mediapipe(image)
            if mp_boxes:
                return mp_boxes

        return self._detect_all_faces_haar(image)

    def _detect_face_simple(
        self, image: np.ndarray, *, target: str = "human"
    ) -> Optional[Tuple[int, int, int, int]]:
        """
        Single-face detection: returns the largest face bbox or None.
        Kept for backwards compatibility with non-gallery callers.
        """
        faces = self._detect_all_faces(image, target=target)
        if not faces:
            return None
        return max(faces, key=self._bbox_area)

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
            raw_confidence = float(scores[np.argmax(scores)])
            raw_emotion = emotion_lower
            emotion_lower, confidence = apply_neutral_priority_guard(
                emotion_lower,
                raw_confidence,
                emotions_dict,
                self.neutral_confidence_threshold,
            )
            if emotion_lower != raw_emotion:
                logger.info(
                    "Neutral guard applied: raw=%s (%.2f) -> display=%s (%.2f) bbox=%s",
                    raw_emotion,
                    raw_confidence,
                    emotion_lower,
                    confidence,
                    face_bbox,
                )

            return {
                "face_detected": True,
                "emotions": emotions_dict,
                "emotion": emotion_lower,
                "confidence": confidence,
                "raw_emotion": raw_emotion,
                "raw_confidence": raw_confidence,
                "aus": {},
                "face_bbox": list(face_bbox),
            }
        except Exception as exc:
            logger.error(f"HSEmotion inference failed: {exc}", exc_info=True)
            return None

    def analyze_image(
        self, image: np.ndarray, *, target: str = "human"
    ) -> Dict[str, Any]:
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
        face_bbox = self._detect_face_simple(image_rgb, target=target)

        if face_bbox is None:
            logger.debug("No face detected in image (target=%s)", target)
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

    def analyze_faces(self, image: np.ndarray, *, target: str = "human") -> list:
        """
        Detect ALL faces in a BGR frame and return emotion results for each.

        Designed for gallery-view scenarios (Zoom, multi-participant webcam)
        where multiple people appear in a single frame.

        Performance characteristics
        ---------------------------
        * Detection runs once per frame (MediaPipe or Haar).
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
        bboxes = self._detect_all_faces(image_rgb, target=target)

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
