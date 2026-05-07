"""
test_room_logic.py — Room Intelligence Integration Test
=======================================================
Simulates Bob as a WebSocket participant with controlled emotion vectors
so you can observe how the server calculates the weighted room state,
detects spikes, and generates social guidance — all in real time.

How the test works
------------------
Phase 0 │  3 s  │ Warm-up: neutral (register Bob in session)
Phase 1 │  5 s  │ Neutral: 1.0  — calm baseline
Phase 2 │  2 s  │ SPIKE  : Anger 0.9 — sudden high-intensity emotion
Phase 3 │  2 s  │ Decay  : neutral again — spike weight decays

While the script runs, open the dashboard in a browser and connect as
Alice (POV) to the same session to see the Harmony Meter, Social
Guidance, and Spike Alert update in real time.

Requirements
------------
  pip install websockets

Server configuration
--------------------
Add to your .env before starting uvicorn:
  ALLOW_EMOTION_INJECTION=true

Run
---
  python test_room_logic.py

Optional arguments (edit constants below):
  WS_URL     WebSocket base URL
  SESSION_ID Room session name
  USER_ID    Bob's participant ID
  INTERVAL   Seconds between each emotion push
"""

import asyncio
import json
import sys
import time
from datetime import datetime

# ──────────────────────────────────────────────
# Configuration — edit these as needed
# ──────────────────────────────────────────────
WS_URL     = "ws://localhost:8000/video/emotion"
SESSION_ID = "lab"
USER_ID    = "Bob"
INTERVAL   = 0.25      # seconds between each injected frame

# Emotion vectors for each phase
NEUTRAL_VECTOR = {
    "neutral":   1.0,
    "happiness": 0.0,
    "sadness":   0.0,
    "anger":     0.0,
    "fear":      0.0,
    "disgust":   0.0,
    "surprise":  0.0,
    "contempt":  0.0,
}

ANGER_VECTOR = {
    "neutral":   0.05,
    "happiness": 0.0,
    "sadness":   0.0,
    "anger":     0.90,
    "fear":      0.05,
    "disgust":   0.0,
    "surprise":  0.0,
    "contempt":  0.0,
}

DECAY_VECTOR = {
    "neutral":   0.75,
    "happiness": 0.0,
    "sadness":   0.10,
    "anger":     0.10,
    "fear":      0.05,
    "disgust":   0.0,
    "surprise":  0.0,
    "contempt":  0.0,
}

# ──────────────────────────────────────────────
# ANSI colour helpers (work on Windows ≥ Win10)
# ──────────────────────────────────────────────
RESET  = "\033[0m"
BOLD   = "\033[1m"
DIM    = "\033[2m"
RED    = "\033[91m"
GREEN  = "\033[92m"
YELLOW = "\033[93m"
BLUE   = "\033[94m"
CYAN   = "\033[96m"
WHITE  = "\033[97m"

def _ts() -> str:
    return datetime.now().strftime("%H:%M:%S.%f")[:-3]

def banner(title: str, color: str = CYAN) -> None:
    width = 60
    print(f"\n{color}{BOLD}{'─' * width}{RESET}")
    print(f"{color}{BOLD}  {title}{RESET}")
    print(f"{color}{BOLD}{'─' * width}{RESET}")

def phase_header(phase: str, duration: float, color: str = YELLOW) -> None:
    print(f"\n{color}{BOLD}▶  {phase}  ({duration}s){RESET}")

def _harmony_color(pct: float) -> str:
    if pct >= 80:
        return GREEN
    if pct >= 50:
        return BLUE
    return YELLOW

def _render_bar(value: float, width: int = 20) -> str:
    """Render a simple ASCII progress bar for a 0-1 value."""
    filled = int(round(value * width))
    return "█" * filled + "░" * (width - filled)

def print_response(msg: dict, phase_label: str) -> None:
    """Pretty-print a server emotion response."""
    room  = msg.get("room", {})
    spike = msg.get("spike")

    harmony_pct   = room.get("harmony_pct",   0.0)
    harmony_label = room.get("harmony_label", "—")
    social_prompt = room.get("social_prompt", "")
    active_spikes = room.get("active_spikes", [])
    pov_present   = room.get("pov_present",   False)
    room_count    = room.get("room_participant_count", 0)

    hc = _harmony_color(harmony_pct)
    emotion_val   = msg.get("emotion", "—")
    confidence    = msg.get("confidence", 0.0)

    line = (
        f"{DIM}[{_ts()}]{RESET} "
        f"{CYAN}{phase_label:<10}{RESET} "
        f"emotion={BOLD}{emotion_val:<10}{RESET} "
        f"conf={BOLD}{confidence:.2f}{RESET}  "
        f"harmony={hc}{BOLD}{harmony_pct:>5.1f}%{RESET} "
        f"({hc}{harmony_label}{RESET})  "
        f"pov={'✓' if pov_present else '✗'}  "
        f"room_participants={room_count}"
    )
    print(line)

    if spike:
        print(
            f"  {RED}{BOLD}  ⚡ SPIKE DETECTED:{RESET} "
            f"peak={RED}{spike['peak_emotion']}{RESET} "
            f"Δ={spike['magnitude']:.2f} "
            f"weight=×{spike['weight']:.1f}"
        )

    if social_prompt:
        print(f"  {BLUE}  💡 {social_prompt}{RESET}")

    if active_spikes:
        for s in active_spikes:
            who = f"{'[POV]' if s.get('is_pov') else '[room]'}"
            print(
                f"  {YELLOW}  ↳ active spike {who} "
                f"{s.get('peak_emotion','?')} "
                f"w=×{s.get('weight',1.0):.1f}{RESET}"
            )


# ──────────────────────────────────────────────
# Main async simulation
# ──────────────────────────────────────────────

async def run_simulation():
    try:
        import websockets
    except ImportError:
        print(f"{RED}ERROR: 'websockets' library not installed.{RESET}")
        print("Run:  pip install websockets")
        sys.exit(1)

    ws_url = f"{WS_URL}?session_id={SESSION_ID}&user_id={USER_ID}&is_pov=false"

    banner(f"Room Logic Test — Bob in session '{SESSION_ID}'")
    print(f"  Connecting to : {BOLD}{ws_url}{RESET}")
    print(f"  Interval      : {INTERVAL}s per frame")
    print(f"\n  {YELLOW}Open the dashboard and connect as Alice (POV) to the same")
    print(f"  session to watch the Harmony Meter and Guidance Box live.{RESET}")
    print(f"\n  Browser URL for Alice:")
    print(f"  {BOLD}http://localhost:8000{RESET}")
    print(f"  (use session_id=lab and check 'is_pov' in query params or browser console)")

    try:
        async with websockets.connect(ws_url, ping_interval=20, ping_timeout=30) as ws:
            print(f"\n{GREEN}{BOLD}✓ WebSocket connected as Bob{RESET}")

            async def send_vector(vector: dict, phase_label: str) -> bool:
                """Send one inject_emotion message and print the server response."""
                await ws.send(json.dumps({
                    "type": "inject_emotion",
                    "emotions": vector,
                    "is_pov": False,
                }))
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=5.0)
                    msg = json.loads(raw)

                    # Skip keepalive pings from server
                    if msg.get("type") == "ping":
                        await ws.send(json.dumps({"type": "pong"}))
                        return True

                    if msg.get("type") == "error":
                        print(f"\n{RED}Server error: {msg.get('message')}{RESET}")
                        print(f"{YELLOW}Hint: Add ALLOW_EMOTION_INJECTION=true to your .env and restart uvicorn.{RESET}")
                        return False

                    print_response(msg, phase_label)
                    return True
                except asyncio.TimeoutError:
                    print(f"{DIM}  (no response within 5s — server may be busy){RESET}")
                    return True

            # ── Phase 0: warm-up ───────────────────────────────────────
            phase_header("PHASE 0 — Warm-up (Neutral)", 3.0, DIM)
            t_end = time.monotonic() + 3.0
            ok = True
            while time.monotonic() < t_end and ok:
                ok = await send_vector(NEUTRAL_VECTOR, "warm-up")
                await asyncio.sleep(INTERVAL)

            if not ok:
                return

            # ── Phase 1: calm baseline ─────────────────────────────────
            phase_header("PHASE 1 — Calm Baseline (Neutral: 1.0)", 5.0, BLUE)
            t_end = time.monotonic() + 5.0
            while time.monotonic() < t_end:
                await send_vector(NEUTRAL_VECTOR, "neutral")
                await asyncio.sleep(INTERVAL)

            # ── Phase 2: anger spike ───────────────────────────────────
            phase_header("PHASE 2 — ANGER SPIKE  (Anger: 0.9)", 2.0, RED)
            print(f"{RED}  Watch for ⚡ SPIKE DETECTED and the Spike Alert on the dashboard!{RESET}")
            t_end = time.monotonic() + 2.0
            while time.monotonic() < t_end:
                await send_vector(ANGER_VECTOR, "SPIKE")
                await asyncio.sleep(INTERVAL)

            # ── Phase 3: decay back to neutral ─────────────────────────
            phase_header("PHASE 3 — Decay (spike weight returns to 1.0)", 2.0, CYAN)
            t_end = time.monotonic() + 2.0
            while time.monotonic() < t_end:
                await send_vector(DECAY_VECTOR, "decay")
                await asyncio.sleep(INTERVAL)

            # ── Clean disconnect ───────────────────────────────────────
            await ws.send(json.dumps({"type": "stop"}))
            banner("Test complete — Bob disconnected", GREEN)
            print(f"{GREEN}  The session '{SESSION_ID}' will be closed by the server")
            print(f"  automatically once Alice also disconnects.{RESET}\n")

    except ConnectionRefusedError:
        print(f"\n{RED}{BOLD}✗ Connection refused.{RESET}")
        print("  Is the server running?  →  uvicorn app.main:app --reload --port 8000")
    except Exception as exc:
        print(f"\n{RED}{BOLD}✗ Unexpected error: {exc}{RESET}")
        raise


if __name__ == "__main__":
    # Enable ANSI colour codes on Windows
    if sys.platform == "win32":
        import ctypes
        try:
            kernel32 = ctypes.windll.kernel32          # type: ignore[attr-defined]
            kernel32.SetConsoleMode(kernel32.GetStdHandle(-11), 7)
        except Exception:
            pass  # Falls back to plain text on old Windows terminals

    asyncio.run(run_simulation())
