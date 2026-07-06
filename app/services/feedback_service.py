"""
Feedback Persistence Service

Stores user disagreement feedback to data/feedback.json using the same
atomic-write pattern as session_persistence.py.

Schema on disk:
{
  "version": 1,
  "total": <int>,
  "feedbacks": [
    {
      "feedback_id": "<uuid>",
      "timestamp":   "<ISO UTC>",
      "modality":    "image|video|audio|animal",
      "predicted_label":    "<str>",
      "correct_label":      "<str|null>",
      "predicted_confidence": <float|null>,
      "session_id":  "<str|null>",
      "request_id":  "<str|null>",
      "extra":       {<dict|null>}
    },
    ...
  ]
}
"""
from __future__ import annotations

import json
import os
import time
import uuid
from datetime import datetime, timezone
from threading import Lock
from typing import Any, Dict, List, Optional

from app.utils.logging import get_logger

logger = get_logger(__name__)

_FEEDBACK_PATH = "data/feedback.json"
_MAX_ENTRIES = 10_000          # rotate oldest if exceeded
_file_lock = Lock()


# ── Internal helpers ──────────────────────────────────────────────────────────

def _ensure_dir() -> str:
    os.makedirs(os.path.dirname(os.path.abspath(_FEEDBACK_PATH)), exist_ok=True)
    return _FEEDBACK_PATH


def _load() -> Dict[str, Any]:
    path = _ensure_dir()
    if not os.path.isfile(path):
        return {"version": 1, "total": 0, "feedbacks": []}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, dict):
            return {"version": 1, "total": 0, "feedbacks": []}
        data.setdefault("feedbacks", [])
        data.setdefault("total", len(data["feedbacks"]))
        return data
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("Could not read feedback store: %s", exc)
        return {"version": 1, "total": 0, "feedbacks": []}


def _save(store: Dict[str, Any]) -> None:
    path = _ensure_dir()
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(store, fh, indent=2)
    os.replace(tmp, path)


# ── Public API ────────────────────────────────────────────────────────────────

def save_feedback(
    *,
    modality: str,
    predicted_label: str,
    correct_label: Optional[str] = None,
    predicted_confidence: Optional[float] = None,
    session_id: Optional[str] = None,
    request_id: Optional[str] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> str:
    """
    Persist one feedback entry atomically.  Returns the new feedback_id.
    Thread-safe via module-level lock.
    """
    feedback_id = str(uuid.uuid4())
    entry: Dict[str, Any] = {
        "feedback_id":          feedback_id,
        "timestamp":            datetime.now(timezone.utc).isoformat(),
        "modality":             modality,
        "predicted_label":      predicted_label,
        "correct_label":        correct_label,
        "predicted_confidence": predicted_confidence,
        "session_id":           session_id,
        "request_id":           request_id,
        "extra":                extra,
    }

    with _file_lock:
        store = _load()
        feedbacks: List[Dict[str, Any]] = store.setdefault("feedbacks", [])
        feedbacks.append(entry)

        # Rotate oldest entries to keep file size bounded
        if len(feedbacks) > _MAX_ENTRIES:
            store["feedbacks"] = feedbacks[-_MAX_ENTRIES:]

        store["total"] = store.get("total", 0) + 1
        store["last_updated"] = time.time()
        _save(store)

    logger.info(
        "Feedback saved | id=%s modality=%s predicted=%s correct=%s",
        feedback_id,
        modality,
        predicted_label,
        correct_label or "—",
    )
    return feedback_id


def get_feedback_summary() -> Dict[str, Any]:
    """Return lightweight stats (for /health or admin use)."""
    with _file_lock:
        store = _load()
    feedbacks = store.get("feedbacks", [])
    by_modality: Dict[str, int] = {}
    for fb in feedbacks:
        m = fb.get("modality", "unknown")
        by_modality[m] = by_modality.get(m, 0) + 1
    return {
        "total_stored":  len(feedbacks),
        "total_received": store.get("total", len(feedbacks)),
        "by_modality":   by_modality,
        "path":          _FEEDBACK_PATH,
    }
