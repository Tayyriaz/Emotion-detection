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
        
        # Use best model for accuracy (can be configured later)
        model_name = "enet_b0_8_best_afew"  # Best balance of accuracy and speed
        
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

    def _detect_face_simple(self, image: np.ndarray) -> Optional[tuple]:
        """
        Simple face detection using OpenCV Haar Cascade.
        Returns (x1, y1, x2, y2) bounding box or None.
        """
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        face_cascade = cv2.CascadeClassifier(
            cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        )
        faces = face_cascade.detectMultiScale(
            gray, scaleFactor=1.1, minNeighbors=5, minSize=(40, 40)
        )
        
        if len(faces) == 0:
            return None
        
        # Return largest face
        largest = max(faces, key=lambda f: f[2] * f[3])
        x, y, w, h = largest
        # Convert NumPy int32 to Python int for JSON serialization
        return (int(x), int(y), int(x + w), int(y + h))

    def analyze_image(self, image: np.ndarray) -> Dict[str, Any]:
        """
        Analyze emotion from a face image.
        
        Process:
        1. Detect face in image using OpenCV Haar Cascade
        2. Extract face region
        3. Run HSEmotion model on face region
        4. Get emotion probabilities and select dominant emotion
        
        Args:
            image: BGR numpy array (OpenCV format), shape (H, W, 3)
            
        Returns:
            Dictionary containing:
            - face_detected (bool): Whether a face was found
            - emotions (Dict[str, float]): All emotion scores (0.0-1.0)
            - emotion (str): Dominant emotion label (lowercase)
            - confidence (float): Confidence score of dominant emotion (0.0-1.0)
            - aus (Dict): Empty dict (HSEmotion doesn't provide Action Units)
            - face_bbox (Optional[tuple]): Face bounding box (x1, y1, x2, y2) or None
            
        Example:
            result = detector.analyze_image(image)
            # result = {
            #     "face_detected": True,
            #     "emotion": "happiness",
            #     "confidence": 0.92,
            #     "emotions": {"happiness": 0.92, "neutral": 0.05, ...},
            #     "aus": {},
            #     "face_bbox": (100, 150, 300, 350)
            # }
        """
        # Convert BGR to RGB for HSEmotion
        image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        
        # Detect face
        face_bbox = self._detect_face_simple(image_rgb)
        
        if face_bbox is None:
            logger.debug("No face detected in image")
            return self._no_face_result()
        
        x1, y1, x2, y2 = face_bbox
        face_img = image_rgb[y1:y2, x1:x2]
        
        # Ensure face image is not empty
        if face_img.size == 0:
            logger.debug("Empty face region detected")
            return self._no_face_result(face_bbox)
        
        try:
            # Predict emotions (returns logits=False means probabilities)
            emotion_label, scores = self.recognizer.predict_emotions(face_img, logits=False)
            
            # Map emotion to lowercase
            emotion_map = (
                self.emotion_map_7 if len(scores) == 7 else self.emotion_map
            )
            emotion_lower = emotion_map.get(emotion_label, emotion_label.lower())
            
            # Convert scores array to dict
            emotion_names = list(emotion_map.values())
            emotions_dict = {
                name: float(score) for name, score in zip(emotion_names, scores)
            }
            
            # Get confidence (probability of dominant emotion)
            confidence = float(scores[np.argmax(scores)])
            
            logger.debug(
                f"HSEmotion prediction: {emotion_lower} (confidence: {confidence:.3f})"
            )
            
            return {
                "face_detected": True,
                "emotions": emotions_dict,
                "emotion": emotion_lower,
                "confidence": confidence,
                "aus": {},  # HSEmotion doesn't provide AU scores
                "face_bbox": face_bbox,
            }
            
        except Exception as e:
            logger.error(f"HSEmotion prediction failed: {e}", exc_info=True)
            return self._no_face_result(face_bbox)
    
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
