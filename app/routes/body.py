"""
Body Language Analysis Routes — Phase 1

Endpoints
---------
GET  /body/status   — Feature availability check (always accessible).
POST /body/posture  — Analyze posture from a single uploaded image.

Guard
-----
All mutating endpoints check ENABLE_BODY_LANGUAGE in config; if False they
return HTTP 503 with a clear message.  The status endpoint always works so
the UI can reflect the disabled state without crashing.

Architecture rules followed
----------------------------
* This file does not import or modify any existing route, service, or model.
* Posture logic lives entirely in app/services/posture_service.py.
* Schema lives in app/models/posture_schema.py.
* This file is registered in main.py with one include_router() call.
"""
from __future__ import annotations

import time

import cv2
import numpy as np
from fastapi import APIRouter, File, HTTPException, UploadFile, status

from app.config import get_settings
from app.models.posture_schema import PostureResponse
from app.services.posture_service import PostureDetector
from app.utils.logging import get_logger

logger = get_logger(__name__)

router = APIRouter(prefix="/body", tags=["Body Language"])

_MAX_IMAGE_BYTES = 10 * 1024 * 1024  # 10 MB


def _require_enabled() -> None:
    """Raise HTTP 503 when ENABLE_BODY_LANGUAGE is False."""
    if not get_settings().ENABLE_BODY_LANGUAGE:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Body language analysis is disabled. "
                "Set ENABLE_BODY_LANGUAGE=true in .env to enable it."
            ),
        )


# ------------------------------------------------------------------
# GET /body/status
# ------------------------------------------------------------------


@router.get(
    "/status",
    summary="Body language feature status (no auth required)",
)
async def body_status() -> dict:
    """
    Always returns — used by the frontend to conditionally show the posture UI.
    """
    settings = get_settings()
    return {
        "enabled":   settings.ENABLE_BODY_LANGUAGE,
        "available": PostureDetector.is_available(),
        "backend":   PostureDetector.backend_name(),
    }


# ------------------------------------------------------------------
# POST /body/posture
# ------------------------------------------------------------------


@router.post(
    "/posture",
    response_model=PostureResponse,
    summary="Analyze posture from an uploaded JPEG/PNG image",
)
async def analyze_posture(file: UploadFile = File(...)) -> PostureResponse:
    """
    Accepts a JPEG or PNG image of a person (ideally from the waist up) and
    returns the detected posture label with confidence score and all signals.

    Requires ENABLE_BODY_LANGUAGE=true in environment / .env.
    """
    _require_enabled()

    if not PostureDetector.is_available():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="MediaPipe Pose is not available on this server.",
        )

    # ── Validate content type ──────────────────────────────────────────
    ct = (file.content_type or "").lower()
    if not (ct.startswith("image/") or ct in ("application/octet-stream", "")):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Expected an image file; got '{file.content_type}'.",
        )

    # ── Read & size-check ─────────────────────────────────────────────
    image_bytes = await file.read()
    if len(image_bytes) > _MAX_IMAGE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Image exceeds 10 MB limit.",
        )

    # ── Decode ────────────────────────────────────────────────────────
    arr = np.frombuffer(image_bytes, np.uint8)
    image_bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if image_bgr is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Could not decode image — ensure it is a valid JPEG or PNG.",
        )

    # ── Analyse ───────────────────────────────────────────────────────
    start = time.time()
    result = PostureDetector.instance().analyze(image_bgr)
    elapsed_ms = round((time.time() - start) * 1000, 1)

    logger.info(
        f"Posture analysis: label='{result['posture_label']}' "
        f"conf={result['posture_confidence']:.2f} | {elapsed_ms:.0f}ms"
    )

    return PostureResponse(
        success=result["landmarks_detected"],
        posture_label=result["posture_label"],
        posture_confidence=result["posture_confidence"],
        signals=result["signals"],
        landmarks_detected=result["landmarks_detected"],
        backend=result.get("backend", PostureDetector.backend_name()),
        processing_time_ms=elapsed_ms,
    )
