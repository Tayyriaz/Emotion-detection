"""
Session Catalog Service

Manages human-readable session names alongside the existing
sessions_backup.json checkpoint store.

Two files are used:
  data/sessions_backup.json  — existing checkpoint store (NOT touched here;
                               read-only from this module via session_persistence)
  data/session_catalog.json  — new: {session_id → name, created_at, tags}

The list endpoint MERGES both sources so sessions that were never named
still appear in the list (using the session_id as the display name).
"""
from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from threading import Lock
from typing import Any, Dict, List, Optional

from app.utils.logging import get_logger

logger = get_logger(__name__)

_catalog_lock = Lock()


# ── Path helpers ──────────────────────────────────────────────────────────────

def _catalog_path() -> str:
    from app.config import get_settings
    path = getattr(get_settings(), "SESSION_CATALOG_PATH", "data/session_catalog.json")
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    return path


def _load_catalog() -> Dict[str, Any]:
    path = _catalog_path()
    if not os.path.isfile(path):
        return {"version": 1, "sessions": {}}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        data.setdefault("sessions", {})
        return data
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("Could not read session catalog: %s", exc)
        return {"version": 1, "sessions": {}}


def _save_catalog(data: Dict[str, Any]) -> None:
    path = _catalog_path()
    tmp = f"{path}.tmp"
    data["updated_at"] = time.time()
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
    os.replace(tmp, path)


# ── Public API ────────────────────────────────────────────────────────────────

def set_session_name(session_id: str, name: str) -> None:
    """Upsert a human-readable name for a session."""
    with _catalog_lock:
        data = _load_catalog()
        entry = data["sessions"].setdefault(session_id, {"session_id": session_id})
        entry["name"] = name.strip()
        entry["named_at"] = datetime.now(timezone.utc).isoformat()
        _save_catalog(data)
    logger.info("Session '%s' named: '%s'", session_id, name)


def get_session_name(session_id: str) -> Optional[str]:
    """Return the user-assigned name, or None if never named."""
    with _catalog_lock:
        data = _load_catalog()
    return data["sessions"].get(session_id, {}).get("name")


def register_session(session_id: str, name: Optional[str] = None) -> None:
    """
    Ensure a session appears in the catalog (called on session creation).
    Does NOT overwrite an existing name.
    """
    with _catalog_lock:
        data = _load_catalog()
        entry = data["sessions"].setdefault(session_id, {"session_id": session_id})
        if name and not entry.get("name"):
            entry["name"] = name.strip()
        entry.setdefault("created_at", datetime.now(timezone.utc).isoformat())
        _save_catalog(data)


def list_sessions_with_metadata() -> List[Dict[str, Any]]:
    """
    Merge session_catalog.json + sessions_backup.json to produce
    a unified list sorted newest → oldest.

    Keys per item:
      session_id, name, created_at, last_active,
      participant_count, harmony_score, harmony_label,
      checkpoint_count, duration_seconds
    """
    # Load both sources
    with _catalog_lock:
        catalog = _load_catalog()

    try:
        from app.services.session_persistence import load_backup_store
        backup = load_backup_store()
    except Exception as exc:
        logger.warning("Could not load backup store for session list: %s", exc)
        backup = {"sessions": {}}

    catalog_sessions: Dict[str, Dict] = catalog.get("sessions", {})
    backup_sessions:  Dict[str, Dict] = backup.get("sessions", {})

    # Union of all known session IDs
    all_ids = set(catalog_sessions) | set(backup_sessions)
    rows: List[Dict[str, Any]] = []

    for sid in all_ids:
        cat  = catalog_sessions.get(sid, {})
        bkp  = backup_sessions.get(sid, {})
        ckpts: List[Dict] = bkp.get("checkpoints", [])
        latest: Dict      = bkp.get("latest") or (ckpts[-1] if ckpts else {})

        harmony_score = None
        harmony_label = None
        participant_count = None
        room = latest.get("room") or {}
        if room:
            harmony_score     = room.get("harmony_score")
            harmony_label     = room.get("harmony_label")
            participant_count = latest.get("participant_count")

        # created_at: prefer catalog → first checkpoint saved_at
        created_at = cat.get("created_at")
        if not created_at and ckpts:
            ts = ckpts[0].get("saved_at")
            if ts:
                created_at = datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()

        # last_active: latest checkpoint saved_at
        last_active = None
        if latest.get("saved_at"):
            last_active = datetime.fromtimestamp(
                latest["saved_at"], tz=timezone.utc
            ).isoformat()

        # Duration: diff between first and last checkpoint saved_at
        duration_seconds = None
        if len(ckpts) >= 2:
            t_first = ckpts[0].get("saved_at")
            t_last  = ckpts[-1].get("saved_at")
            if t_first and t_last:
                duration_seconds = round(t_last - t_first, 1)

        rows.append({
            "session_id":       sid,
            "name":             cat.get("name"),
            "created_at":       created_at,
            "last_active":      last_active,
            "participant_count": participant_count,
            "harmony_score":    harmony_score,
            "harmony_label":    harmony_label,
            "checkpoint_count": len(ckpts),
            "duration_seconds": duration_seconds,
        })

    # Sort newest first (by last_active, fallback created_at)
    def _sort_key(r: Dict) -> float:
        ts = r.get("last_active") or r.get("created_at") or ""
        try:
            return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
        except Exception:
            return 0.0

    rows.sort(key=_sort_key, reverse=True)
    return rows


def get_session_details(session_id: str) -> Optional[Dict[str, Any]]:
    """
    Return full details for one session (for the resume/details endpoint).
    Returns None if the session is not found in either store.
    """
    with _catalog_lock:
        catalog = _load_catalog()

    try:
        from app.services.session_persistence import load_backup_store
        backup = load_backup_store()
    except Exception:
        backup = {"sessions": {}}

    cat = catalog.get("sessions", {}).get(session_id, {})
    bkp = backup.get("sessions", {}).get(session_id, {})

    if not cat and not bkp:
        return None

    ckpts = bkp.get("checkpoints", [])
    latest = bkp.get("latest") or (ckpts[-1] if ckpts else None)

    return {
        "session_id":       session_id,
        "name":             cat.get("name"),
        "created_at":       cat.get("created_at"),
        "last_active":      (
            datetime.fromtimestamp(latest["saved_at"], tz=timezone.utc).isoformat()
            if latest and latest.get("saved_at") else None
        ),
        "checkpoint_count": len(ckpts),
        "latest_checkpoint": latest,
    }
