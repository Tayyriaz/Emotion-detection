"""Download MediaPipe Tasks model files into data/mediapipe_models/ (Docker build step)."""
from __future__ import annotations

import urllib.request
from pathlib import Path

MODELS = [
    (
        "https://storage.googleapis.com/mediapipe-models/face_detector/"
        "blaze_face_full_range/float16/1/blaze_face_full_range.tflite",
        "data/mediapipe_models/blaze_face_full_range.tflite",
    ),
    (
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
        "pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
        "data/mediapipe_models/pose_landmarker_lite.task",
    ),
]


def main() -> None:
    for url, dest in MODELS:
        path = Path(dest)
        path.parent.mkdir(parents=True, exist_ok=True)
        print(f"Downloading {dest} …")
        urllib.request.urlretrieve(url, path)
        print(f"Saved {path} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
