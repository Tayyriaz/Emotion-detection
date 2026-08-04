"""
Application Configuration

Centralized configuration management using pydantic-settings.
All settings can be overridden via environment variables or .env file.
"""

from functools import lru_cache
from typing import Literal, List

from pydantic import AnyHttpUrl, Field
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """
    Application configuration settings.
    
    All settings can be overridden via environment variables or .env file.
    Used throughout the application for consistent configuration.
    """

    # Emotion detection model
    # Uses HSEmotion (EfficientNet-based, high accuracy ~85-90%)
    # Model is loaded as singleton on first use

    # Device for model execution
    MODEL_DEVICE: Literal["cpu", "cuda"] = "cpu"

    # HSEmotion model variant.
    # "enet_b0_8_best_vgaf" → trained on VGGFace2 (balanced, better Neutral accuracy)
    # "enet_b0_8_best_afew" → fine-tuned on AFEW drama clips (biased toward Angry/Sad)
    EMOTION_MODEL_NAME: str = "enet_b0_8_best_vgaf"

    # Minimum softmax confidence required to accept a non-Neutral prediction.
    # 0.48 balances false stress flags vs showing real expressions (client feedback).
    # Tune between 0.42 (looser) and 0.55 (stricter).
    NEUTRAL_CONFIDENCE_THRESHOLD: float = 0.48

    # Logging / limits
    LOG_LEVEL: str = "INFO"
    MAX_IMAGE_SIZE_MB: int = 8

    # Model warmup (runs dummy inference on startup to avoid cold start)
    MODEL_WARMUP: bool = True

    # Network / load timeouts (seconds) — prevent hung threads on slow networks
    MODEL_DOWNLOAD_TIMEOUT_SECONDS: float = 90.0
    GROQ_REQUEST_TIMEOUT_SECONDS: float = 60.0

    # Video processing settings
    VIDEO_FRAME_SKIP: int = 5  # Process every Nth frame (lower = faster emotion change detection)
    VIDEO_MIN_CONFIDENCE_DELTA: float = 0.05  # Minimum confidence change to send update (lower = more responsive)

    # Audio processing settings
    GROQ_API_KEY: str = ""  # Groq API key for audio emotion detection
    AUDIO_SAMPLE_RATE: int = 16000
    AUDIO_BUFFER_SECONDS: float = 3.0  # Buffer audio chunks before processing
    AUDIO_CHUNK_SKIP: int = 1  # Process every Nth chunk
    GROQ_WHISPER_MODEL: str = "whisper-large-v3"
    GROQ_LLAMA_MODEL: str = "llama-3.3-70b-versatile"

    # Animal emotion detection (Hugging Face ViT)
    ANIMAL_MODEL_NAME: str = "dima806/pets_facial_expression_detection"

    # Testing / development only.
    # When True the WebSocket endpoint accepts {"type":"inject_emotion","emotions":{...}}
    # messages so test scripts can simulate arbitrary emotion vectors without a real camera.
    # NEVER set this to True in production.
    ALLOW_EMOTION_INJECTION: bool = False

    # Feedback / calibration collection
    # Set ENABLE_FEEDBACK=false to disable the /feedback/calibration endpoint.
    ENABLE_FEEDBACK: bool = True

    # Body Language Analysis (Phase 1: MediaPipe Tasks PoseLandmarker)
    # Default OFF — set ENABLE_BODY_LANGUAGE=true in .env to activate.
    # Zero overhead when False: posture code is never called in video pipeline.
    ENABLE_BODY_LANGUAGE: bool = False

    # MediaPipe Pose Landmarker (Tasks API — same stack as face detection on 0.10.35)
    MEDIAPIPE_POSE_MODEL_PATH: str = "data/mediapipe_models/pose_landmarker_lite.task"
    MEDIAPIPE_POSE_MODEL_URL: str = (
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
        "pose_landmarker_lite/float16/1/pose_landmarker_lite.task"
    )
    POSTURE_INFERENCE_MAX_WIDTH: int = 480       # downscale before inference (CPU savings)
    POSTURE_FRAME_SKIP: int = 6                  # run every N processed emotion frames
    POSTURE_SMOOTHING_ALPHA: float = 0.35        # EMA factor (lower = smoother, more lag)
    POSTURE_LABEL_STABLE_FRAMES: int = 2         # consecutive frames before label switch
    POSTURE_MIN_LANDMARK_VISIBILITY: float = 0.50
    POSTURE_MIN_DETECTION_CONFIDENCE: float = 0.50
    POSTURE_MIN_PRESENCE_CONFIDENCE: float = 0.50
    POSTURE_MIN_TRACKING_CONFIDENCE: float = 0.50
    POSTURE_SLOUCH_RATIO: float = 0.32           # torso_h / shoulder_w below → slouch
    POSTURE_HEAD_DROP_RATIO: float = 0.55        # nose below shoulders (normalised)
    POSTURE_LEAN_DELTA: float = 0.05             # shoulder vs hip mid-line offset
    POSTURE_CROSS_MARGIN: float = 0.025          # wrist cross body centre margin
    POSTURE_ARMS_RAISED_MARGIN: float = 0.06     # wrist above shoulder line (normalised y)

    # Face robustness — lighting, angles, liveness (client Phase 2 feedback)
    ENABLE_FACE_LIGHTING_NORMALIZE: bool = True   # CLAHE on face crop before HSEmotion
    ENABLE_FACE_QUALITY_GATE: bool = True         # score lighting/sharpness/angle
    ENABLE_LIVENESS_CHECK: bool = True              # video-only motion liveness
    ENABLE_FACE_DETECTION_RETRY: bool = True        # second pass with enhanced frame
    FACE_MIN_BRIGHTNESS: float = 45.0               # 0–255 mean gray on face crop
    FACE_MAX_BRIGHTNESS: float = 215.0
    FACE_MIN_SHARPNESS: float = 45.0                # Laplacian variance
    FACE_MIN_SIZE_RATIO: float = 0.06               # face area / frame area
    FACE_MAX_CENTER_OFFSET: float = 0.42            # 0–1 from frame centre
    FACE_MAX_ASPECT_DEV: float = 0.55               # bbox aspect deviation from frontal
    FACE_QUALITY_MIN_RELIABLE: float = 0.45         # below → warn in UI
    LIVENESS_MIN_MOTION_SCORE: float = 0.012        # frame-to-frame face motion
    LIVENESS_FRAMES_REQUIRED: int = 6               # frames before pass
    LIVENESS_STATIC_FAIL_FRAMES: int = 14           # static → likely photo

    # Session Manager — multi-participant emotion tracking
    # SPIKE_THRESHOLD: min per-dimension emotion delta (0–1) to flag a spike
    # SPIKE_MAX_WEIGHT: ceiling multiplier for a fully-spiked participant
    # SPIKE_DECAY: per-update decay factor driving spike_weight back to 1.0
    # HISTORY_WINDOW: rolling-average window length (frames) per participant
    SESSION_SPIKE_THRESHOLD: float = 0.20
    SESSION_SPIKE_MAX_WEIGHT: float = 3.0
    SESSION_SPIKE_DECAY: float = 0.85
    SESSION_HISTORY_WINDOW: int = 10

    # On-disk session checkpoints (Issue #2 — survive unexpected disconnects)
    SESSION_BACKUP_PATH: str = "data/sessions_backup.json"
    SESSION_BACKUP_MAX_CHECKPOINTS: int = 20

    # Session catalog: stores human-readable names alongside the backup store
    SESSION_CATALOG_PATH: str = "data/session_catalog.json"

    # Face detection: auto prefers MediaPipe when installed, else OpenCV Haar
    FACE_DETECTION_BACKEND: Literal["auto", "mediapipe", "opencv"] = "auto"
    MEDIAPIPE_MIN_DETECTION_CONFIDENCE: float = 0.40
    FACE_BBOX_PADDING_RATIO: float = 0.10
    MEDIAPIPE_FACE_MODEL_PATH: str = "data/mediapipe_models/blaze_face_full_range.tflite"
    MEDIAPIPE_FACE_MODEL_URL: str = (
        "https://storage.googleapis.com/mediapipe-models/face_detector/"
        "blaze_face_full_range/float16/1/blaze_face_full_range.tflite"
    )

    # Animal ViT (separate from human NEUTRAL_CONFIDENCE_THRESHOLD)
    ANIMAL_MIN_CONFIDENCE: float = 0.30
    ANIMAL_ROI_PADDING_RATIO: float = 0.12

    # CORS
    CORS_ORIGINS: List[AnyHttpUrl] = Field(default_factory=list)

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"


@lru_cache()
def get_settings() -> Settings:
    """
    Cached access to settings so that constructing them (including env parsing)
    only happens once per process.
    """

    return Settings()

