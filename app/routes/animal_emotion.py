"""
Animal Emotion Detection API Routes

POST /api/animal/analyze — accept a JPEG/PNG image of a cat or dog,
return the detected emotion with confidence score and full distribution.

Does NOT touch HSEmotion or Groq Audio logic.
"""

import time
from datetime import datetime, timezone

from fastapi import APIRouter, File, HTTPException, UploadFile, status

from app.models.schemas import AnimalEmotionResponse
from app.utils.logging import get_logger, get_request_id
from app.utils.metrics import get_metrics
from app.utils.models import AnimalEmotionModel

logger = get_logger(__name__)

router = APIRouter(tags=["Animal Emotion"])

_MAX_FILE_BYTES = 5 * 1024 * 1024          # 5 MB hard limit
_ALLOWED_CONTENT_TYPES = {"image/jpeg", "image/jpg", "image/png"}
_ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png"}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _validate_and_read(file: UploadFile) -> bytes:
    """
    Validate content-type / extension and enforce size limit.

    Raises HTTPException on validation failure.
    Returns raw image bytes on success.
    """
    filename = (file.filename or "unknown").lower()
    content_type = (file.content_type or "").lower()
    ext = "." + filename.rsplit(".", 1)[-1] if "." in filename else ""

    if content_type not in _ALLOWED_CONTENT_TYPES and ext not in _ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Unsupported format. Please upload a JPEG or PNG image.",
        )

    data = await file.read()

    if not data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Empty file uploaded.",
        )

    if len(data) > _MAX_FILE_BYTES:
        size_mb = len(data) / (1024 * 1024)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"File too large ({size_mb:.1f} MB). Maximum allowed size is 5 MB.",
        )

    return data


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------

@router.post(
    "/api/animal/analyze",
    response_model=AnimalEmotionResponse,
    summary="Detect emotion from a cat/dog image",
    description=(
        "Upload a JPEG or PNG photo of a cat or dog. "
        "Returns the detected emotion (e.g. happy, sad, angry) with a "
        "confidence score and the full emotion probability distribution."
    ),
)
async def analyze_animal_emotion(
    file: UploadFile = File(...),
) -> AnimalEmotionResponse:
    """Analyze emotion from a cat/dog image using ViT (Vision Transformer)."""

    request_id = get_request_id() or "unknown"
    filename = file.filename or "unknown"

    if not AnimalEmotionModel.is_available():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Animal emotion model unavailable. "
                "Install dependencies: pip install transformers pillow"
            ),
        )

    logger.info(f"[{request_id}] Animal emotion request: filename='{filename}'")

    try:
        image_bytes = await _validate_and_read(file)

        start = time.time()
        model = AnimalEmotionModel.instance()
        predictions = model.predict(image_bytes)
        elapsed_ms = (time.time() - start) * 1000
        get_metrics().record_model_inference(elapsed_ms)

        top = predictions[0]
        all_emotions = {p["label"]: round(float(p["score"]), 4) for p in predictions}

        logger.info(
            f"[{request_id}] ✅ Animal emotion: '{top['label']}' "
            f"({top['score']:.1%}) | {elapsed_ms:.1f}ms"
        )

        return AnimalEmotionResponse(
            success=True,
            label=top["label"],
            confidence_score=round(float(top["score"]), 4),
            timestamp=datetime.now(timezone.utc).isoformat(),
            all_emotions=all_emotions,
        )

    except HTTPException:
        raise
    except Exception as exc:
        logger.error(
            f"[{request_id}] ❌ Animal emotion analysis failed: {exc}",
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Animal emotion analysis failed: {exc}",
        ) from exc
