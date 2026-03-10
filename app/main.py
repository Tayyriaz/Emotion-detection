"""
FastAPI Emotion Detection Backend

Main application entry point for emotion detection service.
Uses HSEmotion (EfficientNet-based model) for high-accuracy emotion recognition.

Architecture:
- FastAPI web framework
- HSEmotion detector (singleton pattern)
- Structured logging with request tracking
- Metrics collection
- Health check endpoints
- Static file serving for frontend
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from app.config import get_settings
from app.middleware.request_tracking import RequestTrackingMiddleware
from app.routes.audio import router as audio_router
from app.routes.image import router as image_router
from app.routes.video import router as video_router
from app.utils.logging import configure_logging, get_logger
from app.utils.metrics import get_metrics

logger = get_logger(__name__)


def create_app() -> FastAPI:
    """
    Application factory.

    Keeps configuration and router inclusion in one place so that
    tests and ASGI servers can import the same callable.
    """
    settings = get_settings()

    # Configure structured logging first (before other components initialize)
    configure_logging(settings.LOG_LEVEL)

    app = FastAPI(title="Emotion Backend", version="1.0.0")

    # Request tracking middleware (adds request IDs, logs, metrics)
    app.add_middleware(RequestTrackingMiddleware)

    # CORS configuration
    # For production: Set CORS_ORIGINS environment variable with specific domains
    # Example: CORS_ORIGINS=https://yourdomain.com,https://www.yourdomain.com
    cors_origins = settings.CORS_ORIGINS if settings.CORS_ORIGINS else ["*"]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
        expose_headers=["X-Request-ID"],
    )

    # Routers
    app.include_router(image_router)
    app.include_router(video_router)
    app.include_router(audio_router)

    # Serve static files (frontend HTML, CSS, JS)
    app.mount("/static", StaticFiles(directory="static"), name="static")

    @app.on_event("startup")
    async def startup_event() -> None:
        """
        Initialize and warm up emotion detection model on startup.
        
        This ensures the model is loaded and ready before handling requests,
        avoiding cold-start latency on the first API call.
        """
        logger.info("Starting up Emotion Detection Backend...")
        
        try:
            from app.services.models.hsemotion_detector import HSEmotionDetector
            
            if not HSEmotionDetector.is_available():
                logger.error(
                    "❌ HSEmotion not available. Install with: pip install hsemotion"
                )
                logger.error("Backend will fail on first request.")
                return
            
            # Load model (singleton pattern - loaded once, reused)
            detector = HSEmotionDetector.instance()
            logger.info("✅ HSEmotion model loaded successfully")
            
            # Optional warmup: run dummy inference to initialize PyTorch
            # This pre-compiles operations and loads weights into memory
            if settings.MODEL_WARMUP:
                import numpy as np
                import cv2
                # Create a more realistic dummy image (with a simple face-like pattern)
                dummy_image = np.ones((224, 224, 3), dtype=np.uint8) * 128
                # Add some structure to help with warmup
                cv2.rectangle(dummy_image, (50, 50), (174, 174), (200, 200, 200), -1)
                try:
                    # Run warmup inference (will fail face detection but initializes model)
                    _ = detector.analyze_image(dummy_image)
                    logger.info("✅ Model warmup completed (ready for requests)")
                except Exception as warmup_exc:
                    # Warmup failure is non-critical - model will work on first real request
                    logger.warning(
                        f"⚠️ Model warmup failed (non-critical): {warmup_exc}"
                    )
            else:
                logger.info("ℹ️ Model warmup skipped (MODEL_WARMUP=false)")

        except Exception as exc:
            logger.error(
                f"❌ Failed to initialize emotion detection model: {exc}",
                exc_info=True,
            )
            logger.warning(
                "⚠️ Model will be loaded on first request. This may cause a delay."
            )
            # Don't crash startup - error will be caught on first request

        logger.info("🚀 Application startup complete")

    @app.get("/", response_class=HTMLResponse, summary="Unified frontend page")
    async def root():
        """Serve the unified frontend page matching client architecture."""
        return FileResponse("templates/index.html")
    
    @app.get("/legacy", summary="Legacy unified frontend page")
    async def legacy_root():
        """Serve the legacy unified frontend page."""
        return FileResponse("static/index.html")
    
    @app.get("/audio", summary="Audio emotion detection page")
    async def audio_page():
        """Serve the standalone audio emotion detection page."""
        return FileResponse("static/audio_emotion.html")
    
    @app.get("/video", summary="Video emotion detection page")
    async def video_page():
        """Serve the standalone video emotion detection page."""
        return FileResponse("static/video_emotion.html")
    
    @app.get("/image", summary="Image emotion detection page (legacy)")
    async def image_page():
        """Serve the image emotion detection page (legacy)."""
        return FileResponse("static/image_emotion.html")

    @app.get("/health", summary="Basic health check")
    async def health_check() -> dict:
        """Basic health check endpoint."""
        return {"status": "ok"}

    @app.get("/health/model", summary="Model health check")
    async def model_health_check() -> dict:
        """
        Check if emotion detection model is loaded and ready.
        
        Returns:
            Dictionary with model status, device, and availability.
        """
        try:
            from app.services.models.hsemotion_detector import HSEmotionDetector
            
            if not HSEmotionDetector.is_available():
                return {
                    "status": "unhealthy",
                    "model": "hsemotion",
                    "available": False,
                    "message": "HSEmotion library not installed. Install with: pip install hsemotion",
                }
            
            detector = HSEmotionDetector.instance()
            
            return {
                "status": "healthy",
                "model": "hsemotion",
                "available": True,
                "loaded": True,
                "device": detector.recognizer.device,
            }
                    
        except Exception as exc:
            logger.error(f"Model health check failed: {exc}", exc_info=True)
            return {
                "status": "unhealthy",
                "model": "hsemotion",
                "error": str(exc),
            }

    @app.get("/metrics", summary="Request metrics")
    async def get_metrics_endpoint() -> dict:
        """
        Get current request metrics (latency, error rates, etc.).

        Useful for monitoring and debugging.
        """
        metrics = get_metrics()
        return {
            "metrics": metrics.get_all_metrics(),
        }

    return app


app = create_app()

