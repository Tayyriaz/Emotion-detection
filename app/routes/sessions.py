"""
Session Catalog Routes

GET  /sessions/list                  → list all sessions (newest first)
POST /sessions/{session_id}/name     → set / update custom name
GET  /sessions/{session_id}/details  → full checkpoint for resume

Does NOT modify any existing route or schema.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Path, status

from app.models.session_schema import (
    SessionDetailsResponse,
    SessionInfo,
    SessionListResponse,
    SessionNameRequest,
    SessionNameResponse,
)
from app.services.session_catalog import (
    get_session_details,
    list_sessions_with_metadata,
    set_session_name,
)
from app.utils.logging import get_logger

logger = get_logger(__name__)

router = APIRouter(prefix="/sessions", tags=["Sessions"])


# ── List all sessions ────────────────────────────────────────────────────────

@router.get(
    "/list",
    response_model=SessionListResponse,
    summary="List all recorded sessions",
    description=(
        "Returns all sessions found in the checkpoint store and catalog, "
        "sorted newest first. Includes custom names, participant count, "
        "harmony score, and duration."
    ),
)
async def list_sessions() -> SessionListResponse:
    rows = list_sessions_with_metadata()
    sessions = [SessionInfo(**r) for r in rows]
    return SessionListResponse(sessions=sessions, total=len(sessions))


# ── Name a session ───────────────────────────────────────────────────────────

@router.post(
    "/{session_id}/name",
    response_model=SessionNameResponse,
    summary="Set or update a session's custom name",
)
async def name_session(
    session_id: str = Path(..., min_length=1, max_length=120),
    body: SessionNameRequest = ...,
) -> SessionNameResponse:
    try:
        set_session_name(session_id, body.name)
    except Exception as exc:
        logger.error("Failed to name session '%s': %s", session_id, exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Could not save session name.",
        ) from exc

    return SessionNameResponse(
        success=True,
        session_id=session_id,
        name=body.name.strip(),
    )


# ── Session details (for resume) ─────────────────────────────────────────────

@router.get(
    "/{session_id}/details",
    response_model=SessionDetailsResponse,
    summary="Get full session details for resume",
    description=(
        "Returns the latest checkpoint data so the frontend can restore "
        "chart series and reconnect to the correct session_id."
    ),
)
async def session_details(
    session_id: str = Path(..., min_length=1, max_length=120),
) -> SessionDetailsResponse:
    details = get_session_details(session_id)
    if details is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Session '{session_id}' not found.",
        )
    return SessionDetailsResponse(**details)
