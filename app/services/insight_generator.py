"""
Insight Generator — Neurodivergent Social Guidance

Converts raw session state (harmony score, POV emotion, room emotion,
active spikes) into a single, plain-language, actionable sentence that
helps a user navigate the social dynamics of a multi-participant session
in real time.

Design principles
-----------------
* One sentence only.  No paragraphs, no bullet points.
* Concrete and specific.  "Consider slowing down" not "be mindful".
* Non-judgmental.  Describes the situation, not the person.
* Priority-ordered.  Spikes (urgent signals) take precedence over
  general harmony observations.
* Graceful degradation.  Returns an empty string when there are not
  enough participants to produce a meaningful comparison.

Public API
----------
    from app.services.insight_generator import get_social_guidance

    prompt = get_social_guidance(room_state_result)
    # room_state_result is the dict returned by
    # EmotionSession.calculate_weighted_room_state()

The function is a pure function — no I/O, no side effects, always
returns a str (possibly empty).
"""
from __future__ import annotations

from typing import Dict, List, Optional

# ---------------------------------------------------------------------------
# Emotion groupings used in rule evaluation
# ---------------------------------------------------------------------------

_POSITIVE = frozenset({"happiness", "surprise"})
_NEGATIVE_HIGH_AROUSAL = frozenset({"anger", "fear", "disgust", "contempt"})
_NEGATIVE_LOW_AROUSAL = frozenset({"sadness"})
_CALM = frozenset({"neutral", "sadness"})      # lower-energy states
_ALL_NEGATIVE = _NEGATIVE_HIGH_AROUSAL | _NEGATIVE_LOW_AROUSAL

# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------


def _dominant(emotion_dict: Optional[Dict[str, float]]) -> Optional[str]:
    """Return the emotion label with the highest score, or None."""
    if not emotion_dict:
        return None
    return max(emotion_dict.items(), key=lambda kv: kv[1])[0]


def _room_spike_emotions(active_spikes: List[Dict], exclude_pov: bool = True) -> List[str]:
    """
    Return the list of peak emotion labels from currently active spikes.

    Parameters
    ----------
    active_spikes : list of spike dicts from calculate_weighted_room_state()
    exclude_pov   : when True, only considers non-POV participant spikes
                    (room spikes), not the POV user's own spike.
    """
    out = []
    for spike in active_spikes:
        if exclude_pov and spike.get("is_pov"):
            continue
        peak = spike.get("peak_emotion")
        if peak:
            out.append(peak)
    return out


def _pov_spike_emotions(active_spikes: List[Dict]) -> List[str]:
    """Return spike peak emotions belonging to the POV participant only."""
    return [
        s["peak_emotion"]
        for s in active_spikes
        if s.get("is_pov") and s.get("peak_emotion")
    ]


# ---------------------------------------------------------------------------
# Rule table
# ---------------------------------------------------------------------------
# Each rule is evaluated in order.  The first rule whose condition is True
# wins.  Rules are grouped for readability; within each group they are
# ordered from most specific / urgent to least.

def get_social_guidance(room_state_result: Dict) -> str:
    """
    Generate one actionable guidance sentence for the POV user.

    Parameters
    ----------
    room_state_result : dict
        The dict returned by ``EmotionSession.calculate_weighted_room_state()``.
        Expected keys: harmony_score, pov_state, room_state,
        active_spikes, room_participant_count, pov_present.

    Returns
    -------
    str
        A single sentence, or an empty string when a comparison is not
        yet possible (e.g. solo session with no other participants).
    """
    harmony: float = room_state_result.get("harmony_score", 1.0)
    pov_state: Optional[Dict] = room_state_result.get("pov_state")
    room_state: Optional[Dict] = room_state_result.get("room_state")
    active_spikes: List[Dict] = room_state_result.get("active_spikes", [])
    room_count: int = room_state_result.get("room_participant_count", 0)
    pov_present: bool = room_state_result.get("pov_present", False)

    # ------------------------------------------------------------------
    # Guard: not enough data to produce a meaningful comparison yet
    # ------------------------------------------------------------------
    if not pov_present or room_count == 0:
        return ""

    pov_emotion: Optional[str] = _dominant(pov_state)
    room_emotion: Optional[str] = _dominant(room_state)

    room_spikes: List[str] = _room_spike_emotions(active_spikes, exclude_pov=True)
    pov_spikes: List[str] = _pov_spike_emotions(active_spikes)

    # ------------------------------------------------------------------
    # TIER 1 — Active spikes in the room (most urgent, act first)
    # ------------------------------------------------------------------

    if "anger" in room_spikes:
        return (
            "Strong emotion detected in the room. "
            "It might be a good time to listen."
        )

    if "fear" in room_spikes:
        return (
            "Someone in the room seems distressed. "
            "A brief pause may help everyone feel safer."
        )

    if "sadness" in room_spikes:
        return (
            "Someone in the room seems upset. "
            "Acknowledging their feelings before moving forward can help."
        )

    if "disgust" in room_spikes or "contempt" in room_spikes:
        return (
            "There may be discomfort in the room. "
            "Check if there's something that needs to be addressed."
        )

    # ------------------------------------------------------------------
    # TIER 2 — POV user's own spike (self-regulation cues)
    # ------------------------------------------------------------------

    if "anger" in pov_spikes:
        return (
            "You may be feeling intense right now. "
            "Taking a breath before responding can help."
        )

    if "fear" in pov_spikes:
        return (
            "You seem anxious. "
            "Grounding yourself first — a slow exhale — can make it easier to engage."
        )

    if "sadness" in pov_spikes:
        return (
            "You seem to be experiencing a strong low moment. "
            "It's okay to take a short break if you need one."
        )

    # ------------------------------------------------------------------
    # TIER 3 — Harmony mismatch patterns (specific emotion combinations)
    # ------------------------------------------------------------------

    if harmony < 0.50:

        # POV happy ↔ room low-energy or negative
        if pov_emotion in _POSITIVE and room_emotion in _CALM:
            return (
                "The room's energy is lower than yours. "
                "Consider slowing down or checking in with others."
            )

        if pov_emotion in _POSITIVE and room_emotion in _NEGATIVE_HIGH_AROUSAL:
            return (
                "The room may be tense. "
                "Your upbeat energy might land differently than expected — "
                "a softer tone could help."
            )

        # POV sad / neutral ↔ room positive
        if pov_emotion in _NEGATIVE_LOW_AROUSAL and room_emotion in _POSITIVE:
            return (
                "The room's energy is higher than yours right now. "
                "It's okay to join in at your own pace."
            )

        if pov_emotion == "neutral" and room_emotion in _POSITIVE:
            return (
                "The room seems energised. "
                "Small signals of engagement — a nod or brief response — can help you connect."
            )

        # POV neutral / calm ↔ room angry / high-arousal
        if pov_emotion in _CALM and room_emotion in _NEGATIVE_HIGH_AROUSAL:
            return (
                "There's tension in the room. "
                "Staying calm is one of the most valuable things you can do right now."
            )

        # POV angry ↔ room calm or positive
        if pov_emotion in _NEGATIVE_HIGH_AROUSAL and room_emotion in (_POSITIVE | {"neutral"}):
            return (
                "You may be carrying more intensity than the rest of the room. "
                "Matching the room's calmer pace can improve understanding."
            )

        # General low-harmony fallback
        return (
            "Your emotional state seems different from the room. "
            "A quick check-in with others may help before continuing."
        )

    # ------------------------------------------------------------------
    # TIER 4 — Moderate harmony (0.50–0.79): encourage engagement
    # ------------------------------------------------------------------

    if harmony < 0.65:
        if pov_emotion in _NEGATIVE_HIGH_AROUSAL:
            return (
                "You seem more activated than the rest of the room. "
                "Sharing what you're feeling briefly could reduce the gap."
            )
        return (
            "You and the room are somewhat in sync. "
            "A little more engagement could strengthen the connection."
        )

    if harmony < 0.80:
        return (
            "Good connection with the room. "
            "Keep the energy going — you're on the right track."
        )

    # ------------------------------------------------------------------
    # TIER 5 — High harmony (≥ 0.80): affirm and reinforce
    # ------------------------------------------------------------------

    if pov_emotion in _POSITIVE and room_emotion in _POSITIVE:
        return (
            "You and the room are sharing a positive moment. "
            "This is a great time to build on the energy."
        )

    return "You are well-aligned with the room's vibe."
