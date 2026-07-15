"""Verify MediaPipe FaceDetector + PoseLandmarker load in Docker (needs libGLESv2)."""
from __future__ import annotations

from pathlib import Path

from mediapipe.tasks.python import BaseOptions
from mediapipe.tasks.python.vision import (
    FaceDetector,
    FaceDetectorOptions,
    PoseLandmarker,
    PoseLandmarkerOptions,
    RunningMode,
)

FACE = Path("data/mediapipe_models/blaze_face_full_range.tflite")
POSE = Path("data/mediapipe_models/pose_landmarker_lite.task")


def main() -> None:
    if not FACE.is_file():
        raise SystemExit(f"Missing face model: {FACE}")
    if not POSE.is_file():
        raise SystemExit(f"Missing pose model: {POSE}")

    FaceDetector.create_from_options(
        FaceDetectorOptions(
            base_options=BaseOptions(model_asset_path=str(FACE)),
            running_mode=RunningMode.IMAGE,
        )
    )
    PoseLandmarker.create_from_options(
        PoseLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=str(POSE)),
            running_mode=RunningMode.IMAGE,
            num_poses=1,
        )
    )
    print("MediaPipe FaceDetector + PoseLandmarker runtime check OK")


if __name__ == "__main__":
    main()
