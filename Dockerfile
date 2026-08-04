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
    PYTHONPATH=/app \
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
    MEDIAPIPE_MIN_DETECTION_CONFIDENCE=0.40 \
    ENABLE_FACE_LIGHTING_NORMALIZE=true \
    ENABLE_FACE_QUALITY_GATE=true \
    ENABLE_LIVENESS_CHECK=true \
    ENABLE_FACE_DETECTION_RETRY=true \
    POSTURE_FRAME_SKIP=6 \
    POSTURE_LABEL_STABLE_FRAMES=2 \
    POSTURE_INFERENCE_MAX_WIDTH=480

# --- Dependencies (layer cache: requirements.txt copied before app code) ---
COPY requirements.txt .

RUN pip install numpy==1.26.4 && \
    pip install -r requirements.txt

# Build helper scripts (no inline python -c — for-loops break in one-liners)
COPY docker/ docker/

RUN python -c "import cv2; print('opencv', cv2.__version__)"

RUN python docker/download_mediapipe_models.py && \
    python docker/verify_mediapipe_tasks.py

RUN python docker/cache_ml_models.py

# --- Application ---
COPY models/ models/
COPY app/ app/
COPY static/ static/
COPY templates/ templates/
RUN chmod +x docker/render-entrypoint.sh && \
    cp docker/render-entrypoint.sh /usr/local/bin/render-entrypoint.sh

RUN mkdir -p data/mediapipe_models data

# App-level smoke test — PYTHONPATH=/app so `import app` works from docker/*.py
RUN python docker/verify_app_smoke.py

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD python -c "import os,urllib.request; p=os.environ.get('PORT','8000'); urllib.request.urlopen('http://127.0.0.1:'+p+'/health', timeout=5)"

ENTRYPOINT ["/usr/local/bin/render-entrypoint.sh"]
