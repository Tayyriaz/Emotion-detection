# =============================================================================
# Render.com Docker deployment — Multimodal Emotion Analyzer
# =============================================================================
# Render sets PORT at runtime (often 10000). Do not hardcode 8000 in production.
# Dashboard: Web Service → Environment → Docker → uses this Dockerfile from repo root.
# =============================================================================

FROM python:3.11-slim-bookworm

WORKDIR /app

# --- Render / headless ML system libraries (OpenCV + MediaPipe Tasks) ---
# MediaPipe Tasks needs libGLESv2.so.2 (libgles2-mesa) + EGL/GBM on Linux Docker
RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 \
    libgomp1 \
    libgl1 \
    libgl1-mesa-glx \
    libgles2-mesa \
    libegl1-mesa \
    libegl1 \
    libgbm1 \
    libsm6 \
    libxext6 \
    libxrender1 \
    libxcb1 \
    libx11-6 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# --- Python env (Render logs + production defaults) ---
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HUB_DISABLE_SYMLINKS_WARNING=1 \
    MODEL_DEVICE=cpu \
    TORCH_NUM_THREADS=2 \
    FACE_DETECTION_BACKEND=auto \
    MEDIAPIPE_FACE_MODEL_PATH=data/mediapipe_models/blaze_face_full_range.tflite \
    MEDIAPIPE_POSE_MODEL_PATH=data/mediapipe_models/pose_landmarker_lite.task \
    ENABLE_BODY_LANGUAGE=true \
    ENABLE_FEEDBACK=true \
    ALLOW_EMOTION_INJECTION=false \
    NEUTRAL_CONFIDENCE_THRESHOLD=0.48 \
    MEDIAPIPE_MIN_DETECTION_CONFIDENCE=0.45 \
    POSTURE_FRAME_SKIP=6 \
    POSTURE_LABEL_STABLE_FRAMES=2 \
    POSTURE_INFERENCE_MAX_WIDTH=480

# --- Dependencies (layer cache: requirements.txt copied before app code) ---
COPY requirements.txt .

# Install numpy first so mediapipe and hsemotion both see the pinned version
# before any of their own install-time checks run.
# All versions are exact pins tested locally — do not add >= or < ranges here.
RUN pip install numpy==1.26.4 && \
    pip install -r requirements.txt

# --- OpenCV import smoke test ---
RUN python -c "import cv2; print('opencv', cv2.__version__)"

# --- Pre-cache models + verify MediaPipe Tasks (needs libGLESv2) ---
RUN mkdir -p data/mediapipe_models && python -c "\
from pathlib import Path; \
import urllib.request; \
models=[ \
 ('https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_full_range/float16/1/blaze_face_full_range.tflite', \
  'data/mediapipe_models/blaze_face_full_range.tflite'), \
 ('https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task', \
  'data/mediapipe_models/pose_landmarker_lite.task'), \
]; \
for url, dest in models: \
 p=Path(dest); \
 print('Downloading', dest); \
 urllib.request.urlretrieve(url, p); \
 print('Saved', p)" && \
python -c "\
from pathlib import Path; \
from mediapipe.tasks.python import BaseOptions; \
from mediapipe.tasks.python.vision import FaceDetector, FaceDetectorOptions, RunningMode; \
from mediapipe.tasks.python.vision import PoseLandmarker, PoseLandmarkerOptions; \
face=Path('data/mediapipe_models/blaze_face_full_range.tflite'); \
pose=Path('data/mediapipe_models/pose_landmarker_lite.task'); \
FaceDetector.create_from_options(FaceDetectorOptions( \
 base_options=BaseOptions(model_asset_path=str(face)), running_mode=RunningMode.IMAGE)); \
PoseLandmarker.create_from_options(PoseLandmarkerOptions( \
 base_options=BaseOptions(model_asset_path=str(pose)), running_mode=RunningMode.IMAGE, num_poses=1)); \
print('MediaPipe FaceDetector + PoseLandmarker runtime check OK')"

RUN python -c "\
from transformers import pipeline; \
print('Downloading animal ViT...'); \
pipeline('image-classification', model='dima806/pets_facial_expression_detection', device='cpu'); \
print('Animal ViT cached.')"

RUN python -c "\
from hsemotion.facial_emotions import HSEmotionRecognizer; \
print('Downloading HSEmotion model...'); \
HSEmotionRecognizer(model_name='enet_b0_8_best_vgaf', device='cpu'); \
print('HSEmotion model cached.')"

# --- Application ---
COPY models/ models/
COPY app/ app/
COPY static/ static/
COPY templates/ templates/
COPY docker/render-entrypoint.sh /usr/local/bin/render-entrypoint.sh
RUN chmod +x /usr/local/bin/render-entrypoint.sh

# Runtime writable dirs (feedback, sessions); models baked in at build time
RUN mkdir -p data/mediapipe_models data

# App-level smoke test — confirms posture + emotion services import on Render image
RUN python -c "\
import os; \
os.environ.setdefault('ENABLE_BODY_LANGUAGE', 'true'); \
from app.services.posture_service import PostureDetector; \
from app.services.models.hsemotion_detector import HSEmotionDetector; \
assert PostureDetector.is_available(), 'PostureDetector unavailable'; \
assert HSEmotionDetector.is_available(), 'HSEmotion unavailable'; \
d = PostureDetector.instance(); \
print('App smoke OK | posture=', d.backend_name(), '| hsemotion=ready')"

# Render injects PORT at runtime (e.g. 10000). Local: docker run -e PORT=8000 -p 8000:8000
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD python -c "import os,urllib.request; p=os.environ.get('PORT','8000'); urllib.request.urlopen('http://127.0.0.1:'+p+'/health', timeout=5)"

ENTRYPOINT ["/usr/local/bin/render-entrypoint.sh"]
