"""
FastAPI Emotion Detection Backend

Multimodal emotion analysis platform supporting:
- Human face emotion (HSEmotion / EfficientNet)
- Audio speech emotion (Groq Whisper + LLaMA)
- Animal (cat/dog) emotion (Hugging Face ViT)
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from app.config import get_settings
from app.middleware.request_tracking import RequestTrackingMiddleware
from app.routes.animal_emotion import router as animal_emotion_router
from app.routes.audio import router as audio_router
from app.routes.image import router as image_router
from app.routes.video import router as video_router
from app.utils.logging import configure_logging, get_logger
from app.utils.metrics import get_metrics

logger = get_logger(__name__)


def create_app() -> FastAPI:
    """Application factory — keeps configuration and router registration in one place."""
    settings = get_settings()
    configure_logging(settings.LOG_LEVEL)

    app = FastAPI(title="Multimodal Emotion Backend", version="2.0.0")

    app.add_middleware(RequestTrackingMiddleware)

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
    app.include_router(animal_emotion_router)

    app.mount("/static", StaticFiles(directory="static"), name="static")

    # ------------------------------------------------------------------
    # Startup
    # ------------------------------------------------------------------

    @app.on_event("startup")
    async def startup_event() -> None:
        """
        Eagerly load HSEmotion on startup (fast, ~2 s).
        Animal ViT model loads lazily on first /api/animal/analyze request.
        """
        logger.info("Starting up Emotion Detection Backend…")

        # --- HSEmotion (eager) ---
        try:
            from app.services.models.hsemotion_detector import HSEmotionDetector

            if not HSEmotionDetector.is_available():
                logger.error("❌ HSEmotion not available. Install: pip install hsemotion")
                return

            detector = HSEmotionDetector.instance()
            logger.info("✅ HSEmotion model loaded successfully")

            if settings.MODEL_WARMUP:
                import numpy as np

                dummy = np.ones((224, 224, 3), dtype=np.uint8) * 128
                try:
                    detector.analyze_image(dummy)
                    logger.info("✅ HSEmotion warmup completed")
                except Exception as warmup_exc:
                    logger.warning(f"⚠️ HSEmotion warmup failed (non-critical): {warmup_exc}")
            else:
                logger.info("ℹ️ Model warmup skipped (MODEL_WARMUP=false)")

        except Exception as exc:
            logger.error(f"❌ HSEmotion init failed: {exc}", exc_info=True)

        # --- Animal ViT (eager — pre-warmed so first request is fast) ---
        try:
            from app.utils.models import AnimalEmotionModel

            if not AnimalEmotionModel.is_available():
                logger.warning("⚠️ transformers not installed — animal emotion unavailable")
            else:
                AnimalEmotionModel.instance()
                logger.info("✅ Animal emotion ViT model loaded and warmed up")
        except Exception as exc:
            logger.warning(f"⚠️ Animal emotion model failed to load: {exc} — will retry on first request")

        logger.info("🚀 Application startup complete")

    # ------------------------------------------------------------------
    # Page routes
    # ------------------------------------------------------------------

    @app.get("/", response_class=HTMLResponse, summary="Main dashboard")
    async def root():
        return FileResponse("templates/index.html")

    @app.get("/legacy", summary="Legacy unified page")
    async def legacy_root():
        return FileResponse("static/index.html")

    @app.get("/audio", summary="Audio emotion page")
    async def audio_page():
        return FileResponse("static/audio_emotion.html")

    @app.get("/video", summary="Video emotion page")
    async def video_page():
        return FileResponse("static/video_emotion.html")

    @app.get("/image", summary="Image emotion page")
    async def image_page():
        return FileResponse("static/image_emotion.html")

    @app.get("/animal", summary="Animal emotion detection page")
    async def animal_page():
        return FileResponse("static/animal_emotion.html")

    # ------------------------------------------------------------------
    # Health & metrics
    # ------------------------------------------------------------------

    @app.get("/health", summary="Basic health check")
    async def health_check() -> dict:
        return {"status": "ok"}

    @app.get("/health/model", summary="Model health check")
    async def model_health_check() -> dict:
        """Reports readiness of HSEmotion and the Animal ViT model."""
        report: dict = {"models": {}}

        # HSEmotion
        try:
            from app.services.models.hsemotion_detector import HSEmotionDetector

            if not HSEmotionDetector.is_available():
                report["models"]["hsemotion"] = {
                    "status": "unhealthy",
                    "available": False,
                    "message": "pip install hsemotion",
                }
            else:
                det = HSEmotionDetector.instance()
                report["models"]["hsemotion"] = {
                    "status": "healthy",
                    "available": True,
                    "loaded": True,
                    "device": det.recognizer.device,
                }
        except Exception as exc:
            report["models"]["hsemotion"] = {"status": "unhealthy", "error": str(exc)}

        # Animal ViT (lazy — may not be loaded yet)
        try:
            from app.utils.models import AnimalEmotionModel

            if not AnimalEmotionModel.is_available():
                report["models"]["animal_vit"] = {
                    "status": "unhealthy",
                    "available": False,
                    "message": "pip install transformers pillow",
                }
            elif AnimalEmotionModel._instance is not None:
                report["models"]["animal_vit"] = {
                    "status": "healthy",
                    "available": True,
                    "loaded": True,
                    "model": get_settings().ANIMAL_MODEL_NAME,
                }
            else:
                report["models"]["animal_vit"] = {
                    "status": "healthy",
                    "available": True,
                    "loaded": False,
                    "note": "Not yet loaded — will load on first /api/animal/analyze request",
                    "model": get_settings().ANIMAL_MODEL_NAME,
                }
        except Exception as exc:
            report["models"]["animal_vit"] = {"status": "unhealthy", "error": str(exc)}

        all_healthy = all(v.get("status") == "healthy" for v in report["models"].values())
        report["status"] = "healthy" if all_healthy else "degraded"
        return report

    @app.get("/metrics", summary="Request metrics")
    async def get_metrics_endpoint() -> dict:
        return {"metrics": get_metrics().get_all_metrics()}

    return app


app = create_app()
