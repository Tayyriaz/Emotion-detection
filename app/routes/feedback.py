"""
Feedback / Calibration Route

POST /feedback/calibration  — user disagrees with an emotion prediction.

Gated behind ENABLE_FEEDBACK config flag.
Does NOT touch any existing route or schema.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status

from app.config import get_settings
from app.models.feedback_schema import FeedbackRequest, FeedbackResponse
from app.services.feedback_service import get_feedback_summary, save_feedback
from app.utils.logging import get_logger, get_request_id

logger = get_logger(__name__)

router = APIRouter(tags=["Feedback"])


@router.post(
    "/feedback/calibration",
    response_model=FeedbackResponse,
    summary="Submit emotion prediction feedback",
    description=(
        "Called when a user clicks 'I disagree with this result'. "
        "Stores the predicted label, user-chosen correct label, and context "
        "to data/feedback.json for future calibration analysis."
    ),
)
async def submit_feedback(
    payload: FeedbackRequest,
    request: Request,
) -> FeedbackResponse:
    """Persist one feedback entry if ENABLE_FEEDBACK is true."""
    settings = get_settings()
    if not settings.ENABLE_FEEDBACK:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Feedback collection is currently disabled.",
        )

    req_id = get_request_id() or "unknown"
    logger.info(
        "[%s] Feedback | modality=%s predicted=%s correct=%s",
        req_id,
        payload.modality,
        payload.predicted_label,
        payload.correct_label or "—",
    )

    try:
        feedback_id = save_feedback(
            modality=payload.modality,
            predicted_label=payload.predicted_label,
            correct_label=payload.correct_label,
            predicted_confidence=payload.predicted_confidence,
            session_id=payload.session_id,
            request_id=payload.request_id or req_id,
            extra=payload.extra,
        )
        return FeedbackResponse(success=True, feedback_id=feedback_id)

    except Exception as exc:
        logger.error("[%s] Feedback save failed: %s", req_id, exc, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to save feedback.",
        ) from exc


@router.get(
    "/feedback/summary",
    summary="Feedback collection stats",
    description="Returns counts of stored feedback entries by modality.",
)
async def feedback_summary() -> dict:
    """Lightweight read-only summary — safe to call any time."""
    return get_feedback_summary()
