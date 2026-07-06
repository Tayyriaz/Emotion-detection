"""
Session Catalog Schemas

All fields Optional (except session_id) so existing API responses
are never broken by adding new fields.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class SessionNameRequest(BaseModel):
    """Body for POST /sessions/{session_id}/name"""

    name: str = Field(..., min_length=1, max_length=80, description="Human-readable session name")


class SessionInfo(BaseModel):
    """One session row in the session list."""

    session_id: str
    name: Optional[str] = None                   # user-assigned label
    created_at: Optional[str] = None             # ISO UTC from checkpoint
    last_active: Optional[str] = None            # ISO UTC of latest checkpoint
    participant_count: Optional[int] = None
    harmony_score: Optional[float] = None        # from latest checkpoint
    harmony_label: Optional[str] = None
    checkpoint_count: Optional[int] = None
    duration_seconds: Optional[float] = None     # best-effort from timestamps


class SessionListResponse(BaseModel):
    """Response for GET /sessions/list"""

    sessions: List[SessionInfo]
    total: int


class SessionNameResponse(BaseModel):
    """Response for POST /sessions/{session_id}/name"""

    success: bool
    session_id: str
    name: str


class SessionDetailsResponse(BaseModel):
    """
    Response for GET /sessions/{session_id}/details
    Returns everything needed for frontend chart restoration.
    All nested fields Optional — schema may grow without breaking callers.
    """

    session_id: str
    name: Optional[str] = None
    latest_checkpoint: Optional[Dict[str, Any]] = None   # full snapshot for resume
    checkpoint_count: Optional[int] = None
    created_at: Optional[str] = None
    last_active: Optional[str] = None
