"""
Session Manager for Multi-Participant Emotion Analysis

Manages multi-user emotion sessions, tracks per-participant emotion state over
time, detects high-intensity emotional spikes, computes a spike-weighted room
state, and calculates a Harmony Score that compares the designated POV
participant's emotion to the aggregate room emotion.

Architecture
------------
SessionManager   (process-wide singleton)
  └─ EmotionSession  (one per meeting / recording / call)
       └─ ParticipantState  (one per connected user)

Thread safety
-------------
* SessionManager has one lock for creating / destroying sessions.
* Each EmotionSession has its own lock so sessions don't block each other.

Typical usage
-------------
    mgr = SessionManager.instance()
    session = mgr.get_or_create_session("meeting-42")

    # Call on every new emotion reading for each user:
    spike = session.update_participant(
        user_id="alice",
        emotion_vector={"happiness": 0.78, "neutral": 0.12, ...},
        is_pov=True,
    )

    # Call whenever you need the current room summary:
    state = session.calculate_weighted_room_state()
    print(state["harmony_score"], state["harmony_label"])
"""
from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from threading import Lock
from typing import Dict, List, Optional, Tuple

import numpy as np

from app.config import get_settings
from app.utils.logging import get_logger

logger = get_logger(__name__)

# ---------------------------------------------------------------------------
# Canonical emotion order
# ---------------------------------------------------------------------------

# All vectors are stored and compared in this fixed order so that numpy
# operations are dimension-consistent regardless of which detector produced
# the input dict.  Unknown emotion keys in an incoming dict are silently
# dropped; missing keys default to 0.0.
CANONICAL_EMOTIONS: Tuple[str, ...] = (
    "anger",
    "contempt",
    "disgust",
    "fear",
    "happiness",
    "neutral",
    "sadness",
    "surprise",
)
_N = len(CANONICAL_EMOTIONS)  # 8

# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------


def _to_array(emotion_dict: Dict[str, float]) -> np.ndarray:
    """Convert an emotion score dict → canonical float64 ndarray (length _N)."""
    return np.array(
        [float(emotion_dict.get(e, 0.0)) for e in CANONICAL_EMOTIONS],
        dtype=np.float64,
    )


def _to_dict(arr: np.ndarray) -> Dict[str, float]:
    """Convert a canonical ndarray → {emotion: score} dict."""
    return {e: float(arr[i]) for i, e in enumerate(CANONICAL_EMOTIONS)}


def _cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """
    Cosine similarity in [0, 1].

    Returns 0.5 (neutral / undefined) when either vector has near-zero norm,
    which can happen early in a session before meaningful data arrives.
    """
    norm_a = float(np.linalg.norm(a))
    norm_b = float(np.linalg.norm(b))
    if norm_a < 1e-9 or norm_b < 1e-9:
        return 0.5
    return float(np.clip(np.dot(a, b) / (norm_a * norm_b), 0.0, 1.0))


def _harmony_label(score: float) -> str:
    """Map a harmony score in [0, 1] to a human-readable label."""
    if score >= 0.85:
        return "Aligned"
    if score >= 0.65:
        return "Moderate"
    if score >= 0.40:
        return "Divergent"
    return "Conflicted"


# ---------------------------------------------------------------------------
# Spike event
# ---------------------------------------------------------------------------


@dataclass
class SpikeEvent:
    """
    Record of a single emotional spike detected for one participant.

    A spike occurs when the incoming emotion vector deviates from the
    participant's recent rolling average by more than SPIKE_THRESHOLD on
    at least one emotion dimension.
    """

    user_id: str
    peak_emotion: str   # emotion label with the largest positive (rising) delta
    magnitude: float    # max per-dimension delta (0.0–1.0)
    weight: float       # spike multiplier assigned to this participant
    timestamp: float = field(default_factory=time.monotonic)


# ---------------------------------------------------------------------------
# Participant state
# ---------------------------------------------------------------------------


@dataclass
class ParticipantState:
    """Per-participant emotion tracking state within a session."""

    user_id: str
    is_pov: bool

    # Rolling window of raw incoming vectors (oldest first, newest last).
    # ``maxlen`` is set when the instance is created.
    history: deque = field(default_factory=lambda: deque(maxlen=10))

    # Smoothed vector = mean of all vectors in ``history``.
    # Used for room-state aggregation and as the spike-detection baseline.
    current_vector: np.ndarray = field(
        default_factory=lambda: np.full(_N, 1.0 / _N, dtype=np.float64)
    )

    # Current spike weight multiplier (≥ 1.0; decays toward 1.0 each frame).
    spike_weight: float = 1.0

    # Most recently detected spike (None until the first spike occurs).
    last_spike: Optional[SpikeEvent] = None

    # Monotonic timestamp of the last update_participant() call.
    last_updated: float = field(default_factory=time.monotonic)


# ---------------------------------------------------------------------------
# Emotion session
# ---------------------------------------------------------------------------


class EmotionSession:
    """
    Emotion state for all participants in a single session.

    All public methods are thread-safe.

    Tunable parameters (can be overridden via Settings, see config.py)
    ------------------------------------------------------------------
    SPIKE_THRESHOLD   float   Min per-dimension delta to declare a spike (0–1).
    SPIKE_MAX_WEIGHT  float   Maximum spike weight multiplier.
    SPIKE_DECAY       float   Per-update multiplicative decay for spike_weight.
    HISTORY_WINDOW    int     Number of frames kept in the rolling history.
    """

    # Defaults — overridden from Settings in __init__
    SPIKE_THRESHOLD: float = 0.20
    SPIKE_MAX_WEIGHT: float = 3.0
    SPIKE_DECAY: float = 0.85
    HISTORY_WINDOW: int = 10

    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
        self._participants: Dict[str, ParticipantState] = {}
        self._lock = Lock()
        self._created_at = time.monotonic()

        settings = get_settings()
        self.SPIKE_THRESHOLD = getattr(
            settings, "SESSION_SPIKE_THRESHOLD", self.SPIKE_THRESHOLD
        )
        self.SPIKE_MAX_WEIGHT = getattr(
            settings, "SESSION_SPIKE_MAX_WEIGHT", self.SPIKE_MAX_WEIGHT
        )
        self.SPIKE_DECAY = getattr(
            settings, "SESSION_SPIKE_DECAY", self.SPIKE_DECAY
        )
        self.HISTORY_WINDOW = getattr(
            settings, "SESSION_HISTORY_WINDOW", self.HISTORY_WINDOW
        )

    # ------------------------------------------------------------------
    # Core API
    # ------------------------------------------------------------------

    def update_participant(
        self,
        user_id: str,
        emotion_vector: Dict[str, float],
        is_pov: bool = False,
    ) -> Optional[SpikeEvent]:
        """
        Ingest a new emotion reading for one participant.

        Parameters
        ----------
        user_id:
            Stable identifier for this participant across frames (e.g.
            "host", "user-abc123", a UUID).
        emotion_vector:
            Dict of ``{emotion_label: probability}`` as returned by the
            detection services.  Keys not in CANONICAL_EMOTIONS are ignored;
            missing keys default to 0.0.
        is_pov:
            Marks this participant as the Point-of-View (deployer) user.
            Only one POV per session is supported; calling this with
            ``is_pov=True`` for a second user automatically demotes the
            previous one.

        Returns
        -------
        SpikeEvent if a spike was detected on this update, else None.
        """
        with self._lock:
            # Enforce single POV: demote any previous POV if a new one is set.
            if is_pov:
                for p in self._participants.values():
                    if p.is_pov and p.user_id != user_id:
                        p.is_pov = False
                        logger.debug(
                            f"Session '{self.session_id}': demoted '{p.user_id}' from POV"
                        )

            # Create participant on first appearance.
            if user_id not in self._participants:
                self._participants[user_id] = ParticipantState(
                    user_id=user_id,
                    is_pov=is_pov,
                    history=deque(maxlen=self.HISTORY_WINDOW),
                )
                logger.debug(
                    f"Session '{self.session_id}': registered participant "
                    f"'{user_id}' (pov={is_pov})"
                )

            p = self._participants[user_id]
            p.is_pov = is_pov

            # Convert incoming dict to canonical numpy vector.
            incoming = _to_array(emotion_vector)

            # ---- Spike detection ----
            # We have enough history to compare against only after the first frame.
            spike_event: Optional[SpikeEvent] = None

            if len(p.history) > 0:
                signed_delta = incoming - p.current_vector
                abs_delta    = np.abs(signed_delta)
                max_delta    = float(abs_delta.max())

                # Prefer the emotion that ROSE the most (positive direction).
                # A spike means "anger jumped up", not "neutral fell down".
                # If no dimension increased, fall back to the largest absolute drop.
                positive_delta = np.where(signed_delta > 0, signed_delta, 0.0)
                if positive_delta.max() > 0:
                    peak_idx = int(positive_delta.argmax())
                else:
                    peak_idx = int(abs_delta.argmax())
                peak_emotion = CANONICAL_EMOTIONS[peak_idx]

                if max_delta > self.SPIKE_THRESHOLD:
                    # Map [SPIKE_THRESHOLD, 1.0] → [1.0, SPIKE_MAX_WEIGHT]
                    normalised = (max_delta - self.SPIKE_THRESHOLD) / (
                        1.0 - self.SPIKE_THRESHOLD + 1e-9
                    )
                    p.spike_weight = 1.0 + normalised * (self.SPIKE_MAX_WEIGHT - 1.0)
                    p.spike_weight = min(p.spike_weight, self.SPIKE_MAX_WEIGHT)

                    spike_event = SpikeEvent(
                        user_id=user_id,
                        peak_emotion=peak_emotion,
                        magnitude=round(max_delta, 4),
                        weight=round(p.spike_weight, 3),
                    )
                    p.last_spike = spike_event

                    logger.debug(
                        f"Session '{self.session_id}': spike — '{user_id}' "
                        f"{peak_emotion} Δ={max_delta:.3f} → weight={p.spike_weight:.2f}"
                    )
                else:
                    # Decay smoothly toward neutral weight (1.0).
                    p.spike_weight = max(1.0, p.spike_weight * self.SPIKE_DECAY)

            # ---- Update rolling history and recompute smoothed vector ----
            p.history.append(incoming)
            p.current_vector = np.mean(np.stack(list(p.history)), axis=0)
            p.last_updated = time.monotonic()

            return spike_event

    def calculate_weighted_room_state(self) -> Dict:
        """
        Compute the current emotional state of the room and compare it to
        the POV participant.

        Spike weighting
        ---------------
        Each non-POV participant contributes to the room average weighted by
        their current ``spike_weight`` (≥ 1.0, up to SPIKE_MAX_WEIGHT).
        This means participants who are mid-spike have proportionally more
        influence on the room state, reflecting the heightened emotional
        signal.

        Harmony Score
        -------------
        Cosine similarity between the POV emotion vector and the weighted
        room vector.  Both vectors are softmax-like (positive, roughly sum
        to 1), so cosine similarity is naturally in [0, 1]:

          * 1.0  → POV and room feel exactly the same emotion
          * 0.0  → orthogonal / opposite emotional states

        Returns
        -------
        dict with keys:

        ``room_state``             weighted-average emotion dict for non-POV participants
        ``pov_state``              current emotion dict for the POV participant (None if absent)
        ``harmony_score``          float in [0.0, 1.0]
        ``harmony_label``          "Aligned" | "Moderate" | "Divergent" | "Conflicted"
        ``harmony_pct``            harmony_score × 100 (display-ready percentage)
        ``active_spikes``          list of spike info dicts for participants with weight > 1.05
        ``participant_count``      total participants tracked in this session
        ``room_participant_count`` number of non-POV participants
        ``pov_present``            True if a POV participant has been registered
        """
        with self._lock:
            pov: Optional[ParticipantState] = None
            room_participants: List[ParticipantState] = []

            for p in self._participants.values():
                if p.is_pov:
                    pov = p
                else:
                    room_participants.append(p)

            # ---- Weighted room average ----
            if room_participants:
                total_weight = sum(p.spike_weight for p in room_participants)
                # Avoid division by zero (spike_weight is always ≥ 1.0, so this
                # only matters if the list somehow had zero-weight entries).
                if total_weight < 1e-9:
                    total_weight = float(len(room_participants))
                weighted_sum = sum(
                    p.current_vector * p.spike_weight for p in room_participants
                )
                room_vector: np.ndarray = weighted_sum / total_weight
            else:
                # No room participants yet: use uniform prior.
                room_vector = np.full(_N, 1.0 / _N, dtype=np.float64)

            # ---- POV vector ----
            pov_vector: Optional[np.ndarray] = (
                pov.current_vector.copy() if pov is not None else None
            )

            # ---- Harmony Score ----
            if pov_vector is not None and room_participants:
                harmony_score = _cosine_similarity(pov_vector, room_vector)
            else:
                # No comparison possible yet → report fully aligned (neutral)
                harmony_score = 1.0

            # ---- Active spikes (all participants, including POV) ----
            all_participants = room_participants + ([pov] if pov is not None else [])
            active_spikes = [
                {
                    "user_id": p.user_id,
                    "is_pov": p.is_pov,
                    "peak_emotion": (
                        p.last_spike.peak_emotion if p.last_spike else None
                    ),
                    "magnitude": (
                        round(p.last_spike.magnitude, 4) if p.last_spike else 0.0
                    ),
                    "weight": round(p.spike_weight, 3),
                }
                for p in all_participants
                if p.spike_weight > 1.05
            ]

            return {
                "room_state": _to_dict(room_vector),
                "pov_state": _to_dict(pov_vector) if pov_vector is not None else None,
                "harmony_score": round(harmony_score, 4),
                "harmony_label": _harmony_label(harmony_score),
                "harmony_pct": round(harmony_score * 100, 1),
                "active_spikes": active_spikes,
                "participant_count": len(self._participants),
                "room_participant_count": len(room_participants),
                "pov_present": pov is not None,
            }

    # ------------------------------------------------------------------
    # Participant management helpers
    # ------------------------------------------------------------------

    def remove_participant(self, user_id: str) -> bool:
        """Remove a participant from this session. Returns True if they existed."""
        with self._lock:
            if user_id in self._participants:
                del self._participants[user_id]
                logger.debug(
                    f"Session '{self.session_id}': removed participant '{user_id}'"
                )
                return True
            return False

    def list_participants(self) -> List[Dict]:
        """
        Return a snapshot of all participant states.

        Useful for debugging endpoints or admin UIs.
        """
        with self._lock:
            return [
                {
                    "user_id": p.user_id,
                    "is_pov": p.is_pov,
                    "dominant_emotion": CANONICAL_EMOTIONS[
                        int(p.current_vector.argmax())
                    ],
                    "confidence": round(float(p.current_vector.max()), 4),
                    "spike_weight": round(p.spike_weight, 3),
                    "history_frames": len(p.history),
                    "last_updated": p.last_updated,
                }
                for p in self._participants.values()
            ]

    def get_participant(self, user_id: str) -> Optional[Dict]:
        """Return the current state snapshot for one participant, or None."""
        with self._lock:
            p = self._participants.get(user_id)
            if p is None:
                return None
            return {
                "user_id": p.user_id,
                "is_pov": p.is_pov,
                "emotion_vector": _to_dict(p.current_vector),
                "dominant_emotion": CANONICAL_EMOTIONS[int(p.current_vector.argmax())],
                "confidence": round(float(p.current_vector.max()), 4),
                "spike_weight": round(p.spike_weight, 3),
                "history_frames": len(p.history),
                "last_spike": (
                    {
                        "peak_emotion": p.last_spike.peak_emotion,
                        "magnitude": p.last_spike.magnitude,
                        "weight": p.last_spike.weight,
                        "timestamp": p.last_spike.timestamp,
                    }
                    if p.last_spike
                    else None
                ),
            }

    def export_checkpoint(self) -> Dict:
        """Serializable snapshot for on-disk backup (no nested lock calls)."""
        with self._lock:
            participants = [
                {
                    "user_id": p.user_id,
                    "is_pov": p.is_pov,
                    "emotion_vector": _to_dict(p.current_vector),
                    "spike_weight": round(p.spike_weight, 3),
                    "history_frames": len(p.history),
                }
                for p in self._participants.values()
            ]
            participant_count = len(self._participants)

        room = self.calculate_weighted_room_state()
        return {
            "session_id": self.session_id,
            "participants": participants,
            "room": room,
            "participant_count": participant_count,
            "created_at": self._created_at,
        }

    def restore_from_checkpoint(self, snapshot: Dict) -> int:
        """
        Hydrate participant state from a prior checkpoint.

        Returns the number of participants restored.
        """
        restored = 0
        with self._lock:
            for pdata in snapshot.get("participants") or []:
                uid = pdata.get("user_id")
                if not uid:
                    continue
                vec = _to_array(pdata.get("emotion_vector") or {})
                p = ParticipantState(
                    user_id=uid,
                    is_pov=bool(pdata.get("is_pov", False)),
                    history=deque(maxlen=self.HISTORY_WINDOW),
                )
                p.history.append(vec)
                p.current_vector = vec.copy()
                p.spike_weight = max(1.0, float(pdata.get("spike_weight", 1.0)))
                p.last_updated = time.monotonic()
                self._participants[uid] = p
                restored += 1
        if restored:
            logger.info(
                f"Session '{self.session_id}': restored {restored} participant(s) from backup"
            )
        return restored


# ---------------------------------------------------------------------------
# Session Manager — process-wide singleton
# ---------------------------------------------------------------------------


class SessionManager:
    """
    Process-wide singleton that owns all active EmotionSessions.

    Example
    -------
    >>> mgr = SessionManager.instance()
    >>> session = mgr.get_or_create_session("meeting-42")
    >>> spike = session.update_participant("alice", emotion_dict, is_pov=True)
    >>> session.update_participant("bob", emotion_dict2)
    >>> state = session.calculate_weighted_room_state()
    >>> print(state["harmony_label"], state["harmony_pct"])
    """

    _instance: Optional["SessionManager"] = None
    _class_lock: Lock = Lock()

    def __init__(self) -> None:
        self._sessions: Dict[str, EmotionSession] = {}
        self._lock = Lock()

    @classmethod
    def instance(cls) -> "SessionManager":
        """Thread-safe lazy singleton accessor."""
        if cls._instance is None:
            with cls._class_lock:
                if cls._instance is None:
                    cls._instance = cls()
                    logger.info("SessionManager initialised")
        return cls._instance

    # ------------------------------------------------------------------
    # Session lifecycle
    # ------------------------------------------------------------------

    def get_or_create_session(self, session_id: str) -> EmotionSession:
        """Return an existing session or create a new one with that ID."""
        with self._lock:
            if session_id not in self._sessions:
                session = EmotionSession(session_id)
                self._sessions[session_id] = session
                logger.info(f"SessionManager: created session '{session_id}'")
                self._try_restore_session_from_disk(session)
            return self._sessions[session_id]

    def _try_restore_session_from_disk(self, session: EmotionSession) -> None:
        """Load the latest on-disk checkpoint when memory was cleared."""
        try:
            from app.services.session_persistence import load_latest_checkpoint

            snapshot = load_latest_checkpoint(session.session_id)
            if snapshot:
                session.restore_from_checkpoint(snapshot)
        except Exception as exc:
            logger.warning(
                f"Session '{session.session_id}': backup restore skipped: {exc}"
            )

    def get_session(self, session_id: str) -> Optional[EmotionSession]:
        """Return an existing session, or None if it has not been created."""
        with self._lock:
            return self._sessions.get(session_id)

    def checkpoint_session(
        self,
        session_id: str,
        *,
        reason: str = "checkpoint",
    ) -> bool:
        """Write the current in-memory session to the on-disk backup file."""
        session = self.get_session(session_id)
        if session is None:
            return False
        try:
            from app.services.session_persistence import save_session_checkpoint

            save_session_checkpoint(
                session_id,
                session.export_checkpoint(),
                reason=reason,
            )
            return True
        except Exception as exc:
            logger.warning(
                f"Session '{session_id}': checkpoint failed ({reason}): {exc}"
            )
            return False

    def close_session(self, session_id: str, *, archive: bool = True) -> bool:
        """
        Remove a session from memory.

        When ``archive`` is True (default), a final checkpoint is written before
        the in-memory state is discarded.
        """
        if archive:
            self.checkpoint_session(session_id, reason="session_closed")
        with self._lock:
            if session_id in self._sessions:
                del self._sessions[session_id]
                logger.info(f"SessionManager: closed session '{session_id}'")
                return True
            return False

    def list_sessions(self) -> List[str]:
        """Return a list of all active session IDs."""
        with self._lock:
            return list(self._sessions.keys())

    def session_count(self) -> int:
        """Return the number of currently active sessions."""
        with self._lock:
            return len(self._sessions)
