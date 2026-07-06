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
    # If the top emotion scores below this value the result is overridden to "neutral",
    # preventing ambiguous / tired faces from being mis-labelled as Angry/Fear/Sad.
    # Tune between 0.45 (looser) and 0.65 (stricter). Default 0.55 reduces false stress flags.
    NEUTRAL_CONFIDENCE_THRESHOLD: float = 0.55

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
    MEDIAPIPE_MIN_DETECTION_CONFIDENCE: float = 0.5
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

