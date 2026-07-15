"""App-level smoke test after COPY app/ (Docker build final check)."""
from __future__ import annotations

import os


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
