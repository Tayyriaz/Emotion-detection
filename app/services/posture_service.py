"""
Posture Detection Service — Phase 1

Uses MediaPipe BlazePose Lite (static_image_mode, model_complexity=0)
to detect basic posture signals from a single BGR frame.

Detected labels
---------------
  upright        — no anomaly detected
  slouching      — torso appears vertically compressed (spine hunch)
  leaning_left   — shoulders shifted left relative to hips
  leaning_right  — shoulders shifted right relative to hips
  crossed_arms   — wrists swap sides of the body mid-line
  no_pose        — no body landmarks found / low landmark visibility

Design notes
------------
* Singleton: thread-safe double-checked locking — follows HSEmotionDetector
  pattern in services/models/.
* static_image_mode=True: each call processes the frame independently
  with no temporal state — correct for both video frames and still images.
* model_complexity=0 (Lite, ~9 MB): fast enough for webcam rates when
  posture is sampled every N emotion-frames (see video.py).
* All MediaPipe imports are deferred to init so module-level import cost
  is zero even if mediapipe is not installed.
* analyze() never raises — returns a "no_pose" result on any exception
  so callers do not need try/except around it.

Public API
----------
    from app.services.posture_service import PostureDetector

    result = PostureDetector.instance().analyze(image_bgr)
    # result: {"posture_label", "posture_confidence", "signals", "landmarks_detected"}
"""
from __future__ import annotations

import threading
from typing import Dict, List, Optional

import cv2
import numpy as np

from app.utils.logging import get_logger

logger = get_logger(__name__)

# ---------------------------------------------------------------------------
# MediaPipe Pose landmark indices
# (avoids importing mediapipe at module-load time — deferred to __init__)
# ---------------------------------------------------------------------------
_LM_LEFT_SHOULDER  = 11
_LM_RIGHT_SHOULDER = 12
_LM_LEFT_ELBOW     = 13
_LM_RIGHT_ELBOW    = 14
_LM_LEFT_WRIST     = 15
_LM_RIGHT_WRIST    = 16
_LM_LEFT_HIP       = 23
_LM_RIGHT_HIP      = 24

# ---------------------------------------------------------------------------
# Tunable thresholds (conservative for Phase 1 to minimise false positives)
# ---------------------------------------------------------------------------
_MIN_VIS      = 0.50   # landmark.visibility must exceed this to be trusted
_SLOUCH_RATIO = 0.30   # torso_height/shoulder_width below this → slouching
_LEAN_DELTA   = 0.08   # |shoulder_mid_x − hip_mid_x| above this → lean
_CROSS_MARGIN = 0.04   # wrist must cross body centre by this margin → crossed

# Priority when multiple signals fire simultaneously
_PRIORITY = ["crossed_arms", "slouching", "leaning_left", "leaning_right"]

# Human-readable display names
POSTURE_DISPLAY: Dict[str, str] = {
    "upright":       "Upright",
    "slouching":     "Slouching",
    "leaning_left":  "Leaning Left",
    "leaning_right": "Leaning Right",
    "crossed_arms":  "Crossed Arms",
    "no_pose":       "No Pose",
}


class PostureDetector:
    """
    Thread-safe singleton for MediaPipe Pose-based posture analysis.

    Example
    -------
        result = PostureDetector.instance().analyze(frame_bgr)
    """

    _instance: Optional["PostureDetector"] = None
    _lock: threading.Lock = threading.Lock()

    # ------------------------------------------------------------------
    # Singleton management
    # ------------------------------------------------------------------

    @classmethod
    def is_available(cls) -> bool:
        """True when mediapipe and its pose module are importable."""
        try:
            import mediapipe  # noqa: F401
            _ = mediapipe.solutions.pose  # noqa: F841
            return True
        except Exception:
            return False

    @classmethod
    def instance(cls) -> "PostureDetector":
        """Return the shared singleton, initialising on first call."""
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls._build()
        return cls._instance

    @classmethod
    def _build(cls) -> "PostureDetector":
        obj: "PostureDetector" = object.__new__(cls)
        obj._init_model()
        return obj

    def _init_model(self) -> None:
        import mediapipe as mp
        # static_image_mode=True → no temporal tracking state between calls;
        # correct for single frames arriving over WebSocket or HTTP upload.
        self._pose = mp.solutions.pose.Pose(
            static_image_mode=True,
            model_complexity=0,       # Lite model — fastest, lowest RAM
            smooth_landmarks=False,   # no effect in static mode
            min_detection_confidence=0.50,
            min_tracking_confidence=0.50,
        )
        logger.info("✅ PostureDetector initialised (BlazePose Lite, static_image_mode)")

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def analyze(self, image_bgr: np.ndarray) -> dict:
        """
        Detect posture signals from a single BGR frame.

        Returns
        -------
        dict with keys:
            posture_label       : str
            posture_confidence  : float   (0–1, based on landmark visibility)
            signals             : list[str]
            landmarks_detected  : bool
        """
        try:
            return self._run(image_bgr)
        except Exception as exc:
            logger.debug(f"PostureDetector.analyze error: {exc}")
            return {
                "posture_label":      "no_pose",
                "posture_confidence": 0.0,
                "signals":            [],
                "landmarks_detected": False,
            }

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _run(self, image_bgr: np.ndarray) -> dict:
        image_rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
        pose_result = self._pose.process(image_rgb)

        if not pose_result.pose_landmarks:
            return {
                "posture_label":      "no_pose",
                "posture_confidence": 0.0,
                "signals":            [],
                "landmarks_detected": False,
            }

        lm = pose_result.pose_landmarks.landmark

        l_sh = lm[_LM_LEFT_SHOULDER]
        r_sh = lm[_LM_RIGHT_SHOULDER]
        l_hip = lm[_LM_LEFT_HIP]
        r_hip = lm[_LM_RIGHT_HIP]
        l_wr  = lm[_LM_LEFT_WRIST]
        r_wr  = lm[_LM_RIGHT_WRIST]

        shoulder_vis = min(l_sh.visibility, r_sh.visibility)

        # Both shoulders must be visible — they anchor all other calculations
        if shoulder_vis < _MIN_VIS:
            return {
                "posture_label":      "no_pose",
                "posture_confidence": 0.0,
                "signals":            ["low_visibility"],
                "landmarks_detected": True,
            }

        sh_mid_x      = (l_sh.x + r_sh.x) / 2
        shoulder_width = abs(r_sh.x - l_sh.x)
        signals: List[str] = []
        confidence = float(shoulder_vis)

        # ── Torso metrics — require both hips ────────────────────────
        hip_vis = min(l_hip.visibility, r_hip.visibility)
        if hip_vis >= _MIN_VIS and shoulder_width > 0.05:
            hip_mid_x   = (l_hip.x + r_hip.x) / 2
            hip_mid_y   = (l_hip.y + r_hip.y) / 2
            sh_mid_y    = (l_sh.y + r_sh.y) / 2
            torso_height = hip_mid_y - sh_mid_y   # positive = hips below shoulders

            # Slouching: spine vertically compressed relative to shoulder spread
            if torso_height > 0:
                if torso_height / shoulder_width < _SLOUCH_RATIO:
                    signals.append("slouching")

            # Lateral lean: shoulder centre offset from hip centre
            lean_delta = sh_mid_x - hip_mid_x
            if lean_delta > _LEAN_DELTA:
                signals.append("leaning_right")
            elif lean_delta < -_LEAN_DELTA:
                signals.append("leaning_left")

        # ── Crossed arms ─────────────────────────────────────────────
        if (l_wr.visibility >= _MIN_VIS and r_wr.visibility >= _MIN_VIS):
            if (l_wr.x > sh_mid_x + _CROSS_MARGIN and
                    r_wr.x < sh_mid_x - _CROSS_MARGIN):
                signals.append("crossed_arms")

        # ── Select winning label by priority ─────────────────────────
        posture_label = "upright"
        for candidate in _PRIORITY:
            if candidate in signals:
                posture_label = candidate
                break

        if not signals:
            signals.append("upright")

        return {
            "posture_label":      posture_label,
            "posture_confidence": round(confidence, 3),
            "signals":            signals,
            "landmarks_detected": True,
        }
