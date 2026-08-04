"""
Basic liveness detection for live video — detects static photos vs real movement.

Uses frame-to-frame face-crop motion (blink, micro-movement). Not full anti-spoof
ML; sufficient for Phase 2 client feedback on liveness-style tests.
"""
from __future__ import annotations

from collections import OrderedDict
from threading import Lock
from typing import Any, Dict, Optional

import cv2
import numpy as np

from app.config import get_settings

_MAX_TRACKERS = 128
_trackers: "OrderedDict[str, LivenessTracker]" = OrderedDict()
_registry_lock = Lock()


class LivenessTracker:
    """Per-session motion tracker on the primary face crop."""

    def __init__(self, session_key: str) -> None:
        self.session_key = session_key
        self._prev_gray: Optional[np.ndarray] = None
        self._motion_scores: list[float] = []
        self._verified = False
        self._failed = False

    def reset(self) -> None:
        self._prev_gray = None
        self._motion_scores.clear()
        self._verified = False
        self._failed = False

    def update(self, face_bgr: np.ndarray) -> Dict[str, Any]:
        settings = get_settings()
        if face_bgr.size == 0:
            return self._result("idle", 0.0, "Waiting for a clear face…")

        gray = cv2.cvtColor(face_bgr, cv2.COLOR_BGR2GRAY)
        gray = cv2.resize(gray, (96, 96), interpolation=cv2.INTER_AREA)

        if self._prev_gray is None:
            self._prev_gray = gray
            return self._result(
                "checking",
                0.0,
                "Verifying live face — blink or move slightly.",
            )

        diff = cv2.absdiff(gray, self._prev_gray)
        score = float(np.mean(diff)) / 255.0
        self._prev_gray = gray
        self._motion_scores.append(score)
        if len(self._motion_scores) > 24:
            self._motion_scores.pop(0)

        recent = self._motion_scores[-6:] if self._motion_scores else [0.0]
        avg_recent = float(np.mean(recent))
        peak = float(max(self._motion_scores)) if self._motion_scores else 0.0

        if self._verified:
            return self._result("pass", avg_recent, "Live face verified.")

        min_motion = settings.LIVENESS_MIN_MOTION_SCORE
        frames_needed = settings.LIVENESS_FRAMES_REQUIRED

        if len(self._motion_scores) >= frames_needed:
            if avg_recent >= min_motion or peak >= min_motion * 2.5:
                self._verified = True
                return self._result("pass", avg_recent, "Live face verified.")

        static_frames = settings.LIVENESS_STATIC_FAIL_FRAMES
        if (
            len(self._motion_scores) >= static_frames
            and peak < min_motion * 0.35
            and avg_recent < min_motion * 0.25
        ):
            self._failed = True
            return self._result(
                "fail",
                avg_recent,
                "No live movement detected — use your camera, not a photo or screen.",
            )

        if self._failed:
            # Allow recovery if user starts moving
            if avg_recent >= min_motion:
                self._failed = False
            else:
                return self._result(
                    "fail",
                    avg_recent,
                    "No live movement detected — use your camera, not a photo or screen.",
                )

        return self._result(
            "checking",
            avg_recent,
            "Verifying live face — blink or turn your head slightly.",
        )

    def _result(self, status: str, score: float, message: str) -> Dict[str, Any]:
        return {
            "status": status,
            "score": round(score, 4),
            "verified": status == "pass",
            "message": message,
        }


def get_liveness_tracker(session_key: str) -> LivenessTracker:
    key = session_key or "_default"
    with _registry_lock:
        if key in _trackers:
            _trackers.move_to_end(key)
            return _trackers[key]
        tracker = LivenessTracker(key)
        _trackers[key] = tracker
        while len(_trackers) > _MAX_TRACKERS:
            _trackers.popitem(last=False)
        return tracker


def reset_liveness_tracker(session_key: str) -> None:
    with _registry_lock:
        _trackers.pop(session_key or "_default", None)
