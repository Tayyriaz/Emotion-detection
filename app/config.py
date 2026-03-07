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

    # Logging / limits
    LOG_LEVEL: str = "INFO"
    MAX_IMAGE_SIZE_MB: int = 8

    # Model warmup (runs dummy inference on startup to avoid cold start)
    MODEL_WARMUP: bool = True

    # Video processing settings
    VIDEO_FRAME_SKIP: int = 3  # Process every Nth frame (1 = all frames, 3 = every 3rd frame)
    VIDEO_MIN_CONFIDENCE_DELTA: float = 0.1  # Minimum confidence change to send update

    # Audio processing settings
    GROQ_API_KEY: str = ""  # Groq API key for audio emotion detection
    AUDIO_SAMPLE_RATE: int = 16000
    AUDIO_BUFFER_SECONDS: float = 3.0  # Buffer audio chunks before processing
    AUDIO_CHUNK_SKIP: int = 1  # Process every Nth chunk
    GROQ_WHISPER_MODEL: str = "whisper-large-v3"
    GROQ_LLAMA_MODEL: str = "llama-3.3-70b-versatile"

    # CORS
    CORS_ORIGINS: List[AnyHttpUrl] = Field(default_factory=list)

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


@lru_cache()
def get_settings() -> Settings:
    """
    Cached access to settings so that constructing them (including env parsing)
    only happens once per process.
    """

    return Settings()

