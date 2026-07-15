"""
Posture Detection Service — MediaPipe Tasks PoseLandmarker (Lite)

Uses the Tasks API (mediapipe==0.10.35+) — compatible with Render Docker and
the same runtime stack as face detection.  Legacy mp.solutions.pose is NOT used.

Detected labels
---------------
  upright        — no anomaly detected
  slouching      — torso vertically compressed / head dropped
  leaning_left   — shoulders shifted left relative to hips
  leaning_right  — shoulders shifted right relative to hips
  crossed_arms   — wrists swap sides of the body mid-line (folded arms)
  arms_raised    — one or both wrists above shoulder line (hands up / waving)
  no_pose        — no body landmarks found / low visibility

Performance & jitter control
----------------------------
* Lite .task model (~5 MB) with optional downscale before inference.
* Per-session EMA landmark smoothing reduces coordinate jitter.
* Label stabilizer requires N consecutive frames before switching posture.
* Thread-safe singleton; detect() guarded by a lock (Tasks API is not re-entrant).
"""
from __future__ import annotations

import threading
import urllib.request
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional

import cv2
import numpy as np

from app.config import get_settings
from app.utils.logging import get_logger

logger = get_logger(__name__)

# BlazePose landmark indices (33 landmarks)
_LM_NOSE = 0
_LM_LEFT_SHOULDER = 11
_LM_RIGHT_SHOULDER = 12
_LM_LEFT_ELBOW = 13
_LM_RIGHT_ELBOW = 14
_LM_LEFT_WRIST = 15
_LM_RIGHT_WRIST = 16
_LM_LEFT_HIP = 23
_LM_RIGHT_HIP = 24

_KEY_LANDMARKS = (
    _LM_LEFT_SHOULDER,
    _LM_RIGHT_SHOULDER,
    _LM_LEFT_WRIST,
    _LM_RIGHT_WRIST,
    _LM_LEFT_HIP,
    _LM_RIGHT_HIP,
    _LM_NOSE,
)

# Priority when multiple signals fire simultaneously
_PRIORITY = [
    "crossed_arms",
    "slouching",
    "leaning_left",
    "leaning_right",
    "arms_raised",
]

POSTURE_DISPLAY: Dict[str, str] = {
    "upright": "Upright",
    "slouching": "Slouching",
    "leaning_left": "Leaning Left",
    "leaning_right": "Leaning Right",
    "crossed_arms": "Crossed Arms",
    "arms_raised": "Arms Raised",
    "no_pose": "No Pose",
}

_MAX_TRACKED_SESSIONS = 64


@dataclass
class _SmoothPoint:
    x: float
    y: float
    visibility: float


class _LandmarkSmoother:
    """Exponential moving average on key pose landmarks to reduce jitter."""

    def __init__(self, alpha: float) -> None:
        self._alpha = max(0.05, min(1.0, alpha))
        self._state: Dict[int, _SmoothPoint] = {}

    def apply(self, landmarks: list) -> Dict[int, _SmoothPoint]:
        alpha = self._alpha
        out: Dict[int, _SmoothPoint] = {}
        for idx in _KEY_LANDMARKS:
            if idx >= len(landmarks):
                continue
            lm = landmarks[idx]
            vis = float(getattr(lm, "visibility", getattr(lm, "presence", 1.0)) or 0.0)
            x = float(lm.x)
            y = float(lm.y)
            prev = self._state.get(idx)
            if prev is None:
                smoothed = _SmoothPoint(x=x, y=y, visibility=vis)
            else:
                inv = 1.0 - alpha
                smoothed = _SmoothPoint(
                    x=alpha * x + inv * prev.x,
                    y=alpha * y + inv * prev.y,
                    visibility=alpha * vis + inv * prev.visibility,
                )
            self._state[idx] = smoothed
            out[idx] = smoothed
        return out

    def reset(self) -> None:
        self._state.clear()


class _LabelStabilizer:
    """Debounce posture label changes to avoid flicker between frames."""

    def __init__(self, stable_frames: int) -> None:
        self._stable_frames = max(1, stable_frames)
        self._current = "upright"
        self._candidate: Optional[str] = None
        self._candidate_count = 0

    def update(self, raw_label: str) -> str:
        if raw_label == self._current:
            self._candidate = None
            self._candidate_count = 0
            return self._current

        if raw_label == self._candidate:
            self._candidate_count += 1
        else:
            self._candidate = raw_label
            self._candidate_count = 1

        if self._candidate_count >= self._stable_frames:
            self._current = self._candidate
            self._candidate = None
            self._candidate_count = 0

        return self._current


@dataclass
class _SessionTrackState:
    smoother: _LandmarkSmoother
    label_stabilizer: _LabelStabilizer


class PostureDetector:
    """
    Thread-safe singleton for MediaPipe Tasks PoseLandmarker posture analysis.

    Example
    -------
        result = PostureDetector.instance().analyze(frame_bgr, session_key="sess_1")
    """

    _instance: Optional["PostureDetector"] = None
    _lock: threading.Lock = threading.Lock()
    _init_failed: bool = False

    @classmethod
    def is_available(cls) -> bool:
        """True when mediapipe Tasks vision API is importable."""
        if cls._init_failed:
            return False
        try:
            import mediapipe as mp  # noqa: F401

            return hasattr(mp, "tasks") and hasattr(mp.tasks, "vision")
        except ImportError:
            return False

    @classmethod
    def backend_name(cls) -> str:
        if not cls.is_available():
            return "unavailable"
        return "mediapipe-tasks-pose-lite"

    @classmethod
    def instance(cls) -> "PostureDetector":
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls._build()
        return cls._instance

    @classmethod
    def _build(cls) -> "PostureDetector":
        obj: "PostureDetector" = object.__new__(cls)
        obj._landmarker = None
        obj._detect_lock = threading.Lock()
        obj._sessions: "OrderedDict[str, _SessionTrackState]" = OrderedDict()
        obj._init_model()
        return obj

    @staticmethod
    def _resolve_model_path() -> str:
        settings = get_settings()
        model_path = Path(settings.MEDIAPIPE_POSE_MODEL_PATH)
        if model_path.is_file():
            return str(model_path.resolve())

        model_path.parent.mkdir(parents=True, exist_ok=True)
        logger.info("Downloading MediaPipe pose model to %s…", model_path)
        timeout = settings.MODEL_DOWNLOAD_TIMEOUT_SECONDS
        with urllib.request.urlopen(settings.MEDIAPIPE_POSE_MODEL_URL, timeout=timeout) as resp:
            model_path.write_bytes(resp.read())
        logger.info("MediaPipe pose model cached")
        return str(model_path.resolve())

    def _init_model(self) -> None:
        if PostureDetector._init_failed:
            raise RuntimeError("PostureDetector previously failed to initialise")

        try:
            import mediapipe as mp
            from mediapipe.tasks.python import BaseOptions
            from mediapipe.tasks.python.vision import (
                PoseLandmarker,
                PoseLandmarkerOptions,
                RunningMode,
            )

            settings = get_settings()
            model_path = self._resolve_model_path()
            options = PoseLandmarkerOptions(
                base_options=BaseOptions(model_asset_path=model_path),
                running_mode=RunningMode.IMAGE,
                num_poses=1,
                min_pose_detection_confidence=settings.POSTURE_MIN_DETECTION_CONFIDENCE,
                min_pose_presence_confidence=settings.POSTURE_MIN_PRESENCE_CONFIDENCE,
                min_tracking_confidence=settings.POSTURE_MIN_TRACKING_CONFIDENCE,
                output_segmentation_masks=False,
            )
            self._landmarker = PoseLandmarker.create_from_options(options)
            self._mp = mp
            logger.info(
                "✅ PostureDetector initialised (Tasks PoseLandmarker Lite, max_width=%s)",
                settings.POSTURE_INFERENCE_MAX_WIDTH,
            )
        except Exception as exc:
            PostureDetector._init_failed = True
            logger.error("PostureDetector init failed: %s", exc, exc_info=True)
            raise

    def _session_state(self, session_key: Optional[str]) -> _SessionTrackState:
        key = session_key or "_default"
        if key in self._sessions:
            self._sessions.move_to_end(key)
            return self._sessions[key]

        settings = get_settings()
        state = _SessionTrackState(
            smoother=_LandmarkSmoother(settings.POSTURE_SMOOTHING_ALPHA),
            label_stabilizer=_LabelStabilizer(settings.POSTURE_LABEL_STABLE_FRAMES),
        )
        self._sessions[key] = state
        while len(self._sessions) > _MAX_TRACKED_SESSIONS:
            self._sessions.popitem(last=False)
        return state

    @staticmethod
    def _prepare_frame(image_bgr: np.ndarray, max_width: int) -> np.ndarray:
        """Downscale wide frames for faster inference; preserve aspect ratio."""
        h, w = image_bgr.shape[:2]
        if w <= max_width:
            return image_bgr
        scale = max_width / float(w)
        new_w = max_width
        new_h = max(1, int(h * scale))
        return cv2.resize(image_bgr, (new_w, new_h), interpolation=cv2.INTER_AREA)

    def analyze(self, image_bgr: np.ndarray, session_key: Optional[str] = None) -> dict:
        """
        Detect posture signals from a single BGR frame.

        Parameters
        ----------
        session_key : optional stable id (e.g. WebSocket session_id) for temporal smoothing.

        Returns
        -------
        dict with keys: posture_label, posture_confidence, signals, landmarks_detected, backend
        """
        try:
            return self._run(image_bgr, session_key=session_key)
        except Exception as exc:
            logger.debug("PostureDetector.analyze error: %s", exc)
            return self._empty_result()

    def reset_session(self, session_key: str) -> None:
        """Clear smoothing state when a video session ends."""
        self._sessions.pop(session_key, None)

    @staticmethod
    def _empty_result() -> dict:
        return {
            "posture_label": "no_pose",
            "posture_confidence": 0.0,
            "signals": [],
            "landmarks_detected": False,
            "backend": PostureDetector.backend_name(),
        }

    def _run(self, image_bgr: np.ndarray, session_key: Optional[str]) -> dict:
        if self._landmarker is None:
            return self._empty_result()

        settings = get_settings()
        track = self._session_state(session_key)

        frame = self._prepare_frame(image_bgr, settings.POSTURE_INFERENCE_MAX_WIDTH)
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        rgb = np.ascontiguousarray(rgb)
        mp_image = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=rgb)

        with self._detect_lock:
            result = self._landmarker.detect(mp_image)

        if not result.pose_landmarks:
            return self._empty_result()

        landmarks = result.pose_landmarks[0]
        smoothed = track.smoother.apply(landmarks)

        return self._classify(smoothed, track.label_stabilizer, settings)

    def _classify(
        self,
        lm: Dict[int, _SmoothPoint],
        stabilizer: _LabelStabilizer,
        settings,
    ) -> dict:
        min_vis = settings.POSTURE_MIN_LANDMARK_VISIBILITY

        l_sh = lm.get(_LM_LEFT_SHOULDER)
        r_sh = lm.get(_LM_RIGHT_SHOULDER)
        if not l_sh or not r_sh:
            return self._empty_result()

        shoulder_vis = min(l_sh.visibility, r_sh.visibility)
        if shoulder_vis < min_vis:
            return {
                "posture_label": "no_pose",
                "posture_confidence": 0.0,
                "signals": ["low_visibility"],
                "landmarks_detected": True,
                "backend": self.backend_name(),
            }

        sh_mid_x = (l_sh.x + r_sh.x) / 2.0
        sh_mid_y = (l_sh.y + r_sh.y) / 2.0
        shoulder_width = abs(r_sh.x - l_sh.x)
        signals: List[str] = []
        confidence = float(shoulder_vis)

        l_hip = lm.get(_LM_LEFT_HIP)
        r_hip = lm.get(_LM_RIGHT_HIP)
        hip_vis = (
            min(l_hip.visibility, r_hip.visibility)
            if l_hip and r_hip
            else 0.0
        )

        if hip_vis >= min_vis and shoulder_width > 0.05:
            hip_mid_x = (l_hip.x + r_hip.x) / 2.0  # type: ignore[union-attr]
            hip_mid_y = (l_hip.y + r_hip.y) / 2.0  # type: ignore[union-attr]
            torso_height = hip_mid_y - sh_mid_y

            if torso_height > 0:
                ratio = torso_height / shoulder_width
                if ratio < settings.POSTURE_SLOUCH_RATIO:
                    signals.append("slouching")

            nose = lm.get(_LM_NOSE)
            if nose and nose.visibility >= min_vis and torso_height > 0:
                head_drop = (nose.y - sh_mid_y) / torso_height
                if head_drop > settings.POSTURE_HEAD_DROP_RATIO:
                    signals.append("slouching")

            lean_delta = sh_mid_x - hip_mid_x
            if lean_delta > settings.POSTURE_LEAN_DELTA:
                signals.append("leaning_right")
            elif lean_delta < -settings.POSTURE_LEAN_DELTA:
                signals.append("leaning_left")

        l_wr = lm.get(_LM_LEFT_WRIST)
        r_wr = lm.get(_LM_RIGHT_WRIST)
        l_el = lm.get(_LM_LEFT_ELBOW)
        r_el = lm.get(_LM_RIGHT_ELBOW)
        if (
            l_wr
            and r_wr
            and l_wr.visibility >= min_vis
            and r_wr.visibility >= min_vis
        ):
            margin = settings.POSTURE_CROSS_MARGIN
            if l_wr.x > sh_mid_x + margin and r_wr.x < sh_mid_x - margin:
                signals.append("crossed_arms")
            elif (
                l_el
                and r_el
                and l_el.visibility >= min_vis
                and r_el.visibility >= min_vis
                and l_wr.x > r_el.x - margin
                and r_wr.x < l_el.x + margin
            ):
                signals.append("crossed_arms")

            raised_margin = settings.POSTURE_ARMS_RAISED_MARGIN
            l_raised = l_wr.y < sh_mid_y - raised_margin
            r_raised = r_wr.y < sh_mid_y - raised_margin
            if l_raised or r_raised:
                signals.append("arms_raised")

        raw_label = "upright"
        for candidate in _PRIORITY:
            if candidate in signals:
                raw_label = candidate
                break

        if not signals:
            signals.append("upright")

        posture_label = stabilizer.update(raw_label)

        return {
            "posture_label": posture_label,
            "posture_confidence": round(confidence, 3),
            "signals": signals,
            "landmarks_detected": True,
            "backend": self.backend_name(),
        }
