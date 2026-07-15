"""App-level smoke test after COPY app/ (Docker build final check)."""
from __future__ import annotations

import os
import sys
from pathlib import Path

# Script lives in docker/ — ensure project root (/app) is on sys.path
_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))


def main() -> None:
    os.environ.setdefault("ENABLE_BODY_LANGUAGE", "true")

    from app.services.models.hsemotion_detector import HSEmotionDetector
    from app.services.posture_service import PostureDetector

    if not PostureDetector.is_available():
        raise SystemExit("PostureDetector unavailable")
    if not HSEmotionDetector.is_available():
        raise SystemExit("HSEmotion unavailable")

    detector = PostureDetector.instance()
    print(
        "App smoke OK | posture=",
        detector.backend_name(),
        "| hsemotion=ready",
    )


if __name__ == "__main__":
    main()
