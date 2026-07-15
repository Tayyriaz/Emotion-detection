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
from app.routes.body import router as body_router
from app.routes.feedback import router as feedback_router
from app.routes.image import router as image_router
from app.routes.sessions import router as sessions_router
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
    app.include_router(feedback_router)
    app.include_router(sessions_router)
    app.include_router(body_router)

    app.mount("/static", StaticFiles(directory="static"), name="static")

    # ------------------------------------------------------------------
    # Startup
    # ------------------------------------------------------------------

    @app.on_event("startup")
    async def startup_event() -> None:
        """
        Non-blocking startup: ML models load in a background daemon thread
        so the server accepts traffic immediately (no network freeze on boot).
        """
        from app.services.model_bootstrap import start_background_model_load

        logger.info("Starting up Emotion Detection Backend…")
        start_background_model_load(
            warmup_hsemotion=settings.MODEL_WARMUP,
            load_animal=True,
        )

        # Pre-initialise PostureDetector if body language is enabled so the
        # first video frame is not delayed by MediaPipe model initialisation.
        if settings.ENABLE_BODY_LANGUAGE:
            from app.services.posture_service import PostureDetector
            if PostureDetector.is_available():
                import threading
                t = threading.Thread(
                    target=PostureDetector.instance,
                    name="posture-bootstrap",
                    daemon=True,
                )
                t.start()
                logger.info("PostureDetector background init started")
            else:
                logger.warning("ENABLE_BODY_LANGUAGE=true but MediaPipe Tasks Pose is not available")

        logger.info("🚀 Application startup complete (models loading in background)")

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
        """
        Reports model readiness without blocking on a cold load.
        Uses bootstrap thread state; only touches singletons when already ready.
        """
        from app.services import model_bootstrap
        from app.services.models.hsemotion_detector import HSEmotionDetector
        from app.utils.models import AnimalEmotionModel

        report: dict = {"models": {}}
        boot = model_bootstrap.get_status()

        # --- HSEmotion ---
        hse = boot["hsemotion"]
        if not HSEmotionDetector.is_available():
            report["models"]["hsemotion"] = {
                "status": "unhealthy",
                "available": False,
                "loaded": False,
                "message": "pip install hsemotion",
            }
        elif hse["ready"]:
            try:
                det = HSEmotionDetector.instance()
                report["models"]["hsemotion"] = {
                    "status": "healthy",
                    "available": True,
                    "loaded": True,
                    "device": det.recognizer.device,
                    "face_detection": HSEmotionDetector.active_face_backend(),
                }
            except Exception as exc:
                report["models"]["hsemotion"] = {
                    "status": "unhealthy",
                    "available": True,
                    "loaded": False,
                    "error": str(exc),
                }
        elif hse["loading"]:
            report["models"]["hsemotion"] = {
                "status": "loading",
                "available": True,
                "loaded": False,
                "message": "Model loading in background",
            }
        elif hse["error"]:
            report["models"]["hsemotion"] = {
                "status": "unhealthy",
                "available": True,
                "loaded": False,
                "error": hse["error"],
            }
        else:
            report["models"]["hsemotion"] = {
                "status": "pending",
                "available": True,
                "loaded": False,
            }

        # --- Animal ViT ---
        ani = boot["animal"]
        if not AnimalEmotionModel.is_available():
            report["models"]["animal_vit"] = {
                "status": "unhealthy",
                "available": False,
                "loaded": False,
                "message": "pip install transformers pillow",
            }
        elif ani["ready"] or AnimalEmotionModel._instance is not None:
            report["models"]["animal_vit"] = {
                "status": "healthy",
                "available": True,
                "loaded": True,
                "model": settings.ANIMAL_MODEL_NAME,
            }
        elif ani["loading"]:
            report["models"]["animal_vit"] = {
                "status": "loading",
                "available": True,
                "loaded": False,
                "message": "Model loading in background",
                "model": settings.ANIMAL_MODEL_NAME,
            }
        elif ani["error"]:
            report["models"]["animal_vit"] = {
                "status": "degraded",
                "available": True,
                "loaded": False,
                "error": ani["error"],
                "model": settings.ANIMAL_MODEL_NAME,
            }
        else:
            report["models"]["animal_vit"] = {
                "status": "pending",
                "available": True,
                "loaded": False,
                "model": settings.ANIMAL_MODEL_NAME,
            }

        # --- Posture (optional) ---
        if settings.ENABLE_BODY_LANGUAGE:
            from app.services.posture_service import PostureDetector

            if not PostureDetector.is_available():
                report["models"]["posture"] = {
                    "status": "unhealthy",
                    "available": False,
                    "loaded": False,
                    "message": "mediapipe tasks vision not installed",
                }
            else:
                try:
                    PostureDetector.instance()
                    report["models"]["posture"] = {
                        "status": "healthy",
                        "available": True,
                        "loaded": True,
                        "backend": PostureDetector.backend_name(),
                    }
                except Exception as exc:
                    report["models"]["posture"] = {
                        "status": "unhealthy",
                        "available": True,
                        "loaded": False,
                        "error": str(exc),
                    }

        statuses = [m.get("status") for m in report["models"].values()]
        if all(s == "healthy" for s in statuses):
            report["status"] = "healthy"
        elif any(s == "loading" for s in statuses):
            report["status"] = "loading"
        else:
            report["status"] = "degraded"
        return report

    @app.get("/metrics", summary="Request metrics")
    async def get_metrics_endpoint() -> dict:
        return {"metrics": get_metrics().get_all_metrics()}

    return app


app = create_app()
