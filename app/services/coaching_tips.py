"""
Coaching Tips Service

Static lookup: (modality, emotion_label, confidence) → (reason, suggestion).

Follows insight_generator.py conventions:
- Pure function, no I/O, no side effects
- Lowercase labels throughout
- Returns ("", "") when nothing useful can be said

Public API
----------
    from app.services.coaching_tips import get_coaching_tips

    reason, suggestion = get_coaching_tips("image", "sadness", 0.72)
    # → ("Low mood or disengagement detected.", "Try an empathetic open question.")
"""
from __future__ import annotations

from typing import Tuple

# ---------------------------------------------------------------------------
# Static lookup tables
# ---------------------------------------------------------------------------

# Human face emotions (image + video)
# Each entry: emotion_key → (reason, suggestion)
_HUMAN: dict = {
    "happiness": (
        "Positive engagement and warmth detected.",
        "Keep this energy — a follow-up open question can deepen the connection.",
    ),
    "neutral": (
        "Calm, measured expression — engagement level is hard to read.",
        "A small smile or nod signals active listening and invites dialogue.",
    ),
    "sadness": (
        "Signs of low mood or disengagement detected.",
        "Slow down, acknowledge feelings, and ask an empathetic open question.",
    ),
    "anger": (
        "Elevated tension or frustration detected.",
        "Pause, breathe, and reframe with a neutral, solution-focused statement.",
    ),
    "fear": (
        "Anxiety or discomfort cues detected — confidence appears low.",
        "Use a calm, reassuring tone and give the other person space to speak.",
    ),
    "surprise": (
        "Sudden shift in expression — unexpected information may have landed.",
        "Check in with 'Does that make sense?' and give time to process.",
    ),
    "disgust": (
        "Disapproval or strong disagreement detected.",
        "Acknowledge the concern directly before moving forward.",
    ),
    "contempt": (
        "Dismissiveness or superiority cues detected.",
        "Try to find common ground — ask what matters most to the other person.",
    ),
}

# Audio / speech emotions
_AUDIO: dict = {
    "happiness": (
        "Positive, energetic speech detected — warm and engaging tone.",
        "Maintain this energy; a well-timed pause can add emphasis.",
    ),
    "neutral": (
        "Flat or measured tone — emotion is hard to read from speech alone.",
        "Vary your pitch and pace slightly to sound more engaged and approachable.",
    ),
    "sadness": (
        "Low energy or somber tone detected in speech.",
        "Slow your pace, speak clearly, and use warmer language to lift the tone.",
    ),
    "anger": (
        "Elevated vocal tension or clipped speech detected.",
        "Take a breath before responding — a lower, slower tone reduces escalation.",
    ),
    "fear": (
        "Hesitation or vocal uncertainty detected.",
        "Speak in shorter sentences and pause deliberately to project more confidence.",
    ),
    "surprise": (
        "Abrupt shift in vocal pattern — unexpected content detected.",
        "Acknowledge it explicitly: 'That's interesting — let me think about that.'",
    ),
    "disgust": (
        "Negative vocal sentiment detected.",
        "Reframe with neutral language; focus on what could improve, not what is wrong.",
    ),
    "no_speech": (
        "No clear speech detected — audio may be silent or too short.",
        "Try recording for at least 5 seconds with clear, close-mic speech.",
    ),
}

# Animal (ViT) emotions
_ANIMAL: dict = {
    "happy": (
        "Your pet appears relaxed and content.",
        "A great time for gentle play or a treat — positive reinforcement works best now.",
    ),
    "sad": (
        "Your pet may be feeling low or unwell.",
        "Try gentle interaction, ensure water and rest, and monitor for other signs.",
    ),
    "angry": (
        "Your pet shows signs of stress or agitation.",
        "Give them space, remove stressors, and avoid sudden movements.",
    ),
    "other": (
        "Facial expression is unclear or ambiguous.",
        "Observe body language alongside facial cues for a fuller picture of mood.",
    ),
}

# Modality → lookup table
_TABLE: dict = {
    "image":  _HUMAN,
    "video":  _HUMAN,
    "audio":  _AUDIO,
    "animal": _ANIMAL,
}

# Confidence thresholds
_LOW_CONF  = 0.35
_HIGH_CONF = 0.70

# Confidence hedges appended to reason
_LOW_CONF_NOTE   = " (low confidence — result may be uncertain)"
_MED_CONF_NOTE   = " (moderate confidence)"

# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def get_coaching_tips(
    modality: str,
    label: str,
    confidence: float | None = None,
) -> Tuple[str, str]:
    """
    Return (reason, suggestion) for an emotion detection result.

    Parameters
    ----------
    modality   : "image" | "video" | "audio" | "animal"
    label      : emotion label as returned by the detector (case-insensitive)
    confidence : raw 0–1 confidence score (optional; adds a hedge when low)

    Returns
    -------
    (reason, suggestion) — both empty strings when nothing useful can be said.
    """
    table = _TABLE.get(modality.lower(), _HUMAN)
    key   = (label or "").lower().strip()

    if key not in table:
        return ("", "")

    reason, suggestion = table[key]

    if confidence is not None:
        if confidence < _LOW_CONF:
            reason = reason + _LOW_CONF_NOTE
        elif confidence < _HIGH_CONF:
            reason = reason + _MED_CONF_NOTE

    return reason, suggestion
