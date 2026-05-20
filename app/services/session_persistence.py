"""
Quiet on-disk checkpoints for EmotionSession state.

Appends JSON snapshots to SESSION_BACKUP_PATH so unexpected WebSocket
disconnects do not lose the only copy of room/participant state.
"""
from __future__ import annotations

import json
import os
import time
from threading import Lock
from typing import Any, Dict, Optional

from app.config import get_settings
from app.utils.logging import get_logger

logger = get_logger(__name__)

_file_lock = Lock()


def _backup_path() -> str:
    path = get_settings().SESSION_BACKUP_PATH
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    return path


def _empty_store() -> Dict[str, Any]:
    return {"version": 1, "sessions": {}, "updated_at": None}


def load_backup_store() -> Dict[str, Any]:
    """Read the full backup file, or return an empty store."""
    path = _backup_path()
    if not os.path.isfile(path):
        return _empty_store()
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, dict):
            return _empty_store()
        data.setdefault("sessions", {})
        data.setdefault("version", 1)
        return data
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("Could not read session backup (%s): %s", path, exc)
        return _empty_store()


def save_session_checkpoint(
    session_id: str,
    snapshot: Dict[str, Any],
    *,
    reason: str = "checkpoint",
) -> None:
    """
    Append a checkpoint for ``session_id`` and atomically rewrite the backup file.
    """
    snapshot = {
        **snapshot,
        "reason": reason,
        "saved_at": time.time(),
    }
    with _file_lock:
        store = load_backup_store()
        sessions = store.setdefault("sessions", {})
        entry = sessions.setdefault(
            session_id,
            {"session_id": session_id, "checkpoints": []},
        )
        checkpoints = entry.setdefault("checkpoints", [])
        checkpoints.append(snapshot)
        max_ckpt = get_settings().SESSION_BACKUP_MAX_CHECKPOINTS
        entry["checkpoints"] = checkpoints[-max_ckpt:]
        entry["latest"] = snapshot
        store["updated_at"] = time.time()

        path = _backup_path()
        tmp = f"{path}.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(store, fh, indent=2)
        os.replace(tmp, path)

    logger.debug(
        "Session backup saved | session='%s' reason=%s participants=%s",
        session_id,
        reason,
        snapshot.get("participant_count"),
    )


def load_latest_checkpoint(session_id: str) -> Optional[Dict[str, Any]]:
    """Return the newest checkpoint dict for a session, or None."""
    store = load_backup_store()
    entry = store.get("sessions", {}).get(session_id)
    if not entry:
        return None
    latest = entry.get("latest")
    if isinstance(latest, dict):
        return latest
    checkpoints = entry.get("checkpoints") or []
    return checkpoints[-1] if checkpoints else None
