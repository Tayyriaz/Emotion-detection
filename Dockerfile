# =============================================================================
# Render.com Docker deployment — Multimodal Emotion Analyzer
# =============================================================================
# Render sets PORT at runtime (often 10000). Do not hardcode 8000 in production.
# Dashboard: Web Service → Environment → Docker → uses this Dockerfile from repo root.
# =============================================================================

FROM python:3.11-slim-bookworm

WORKDIR /app

# --- Render / headless ML system libraries (OpenCV + MediaPipe Tasks) ---
RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 \
    libgomp1 \
    libgl1 \
    libgl1-mesa-glx \
    libsm6 \
    libxext6 \
    libxrender1 \
    libxcb1 \
    libx11-6 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# --- Python env (Render logs + smaller image) ---
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HUB_DISABLE_SYMLINKS_WARNING=1 \
    MODEL_DEVICE=cpu \
    TORCH_NUM_THREADS=2 \
    FACE_DETECTION_BACKEND=auto \
    MEDIAPIPE_FACE_MODEL_PATH=data/mediapipe_models/blaze_face_full_range.tflite

# --- Dependencies (layer cache) ---
COPY requirements.txt .

# numpy<2 first — mediapipe must not upgrade torch/hsemotion stack to numpy 2.x
RUN pip install "numpy>=1.24.0,<2.0.0" && \
    pip install -r requirements.txt && \
    pip uninstall -y opencv-contrib-python 2>/dev/null || true && \
    pip install --force-reinstall --no-deps opencv-python-headless==4.10.0.84

# --- Verify critical imports at build time (fail fast on Render build) ---
RUN python -c "\
import cv2; \
import mediapipe as mp; \
assert hasattr(mp, 'tasks'), 'mediapipe.tasks required (0.10.31+)'; \
print('opencv', cv2.__version__); \
print('mediapipe', mp.__version__)"

# --- Pre-cache models (Render has no persistent HF cache on free/starter) ---
RUN mkdir -p data/mediapipe_models && python -c "\
from pathlib import Path; \
import urllib.request; \
url='https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_full_range/float16/1/blaze_face_full_range.tflite'; \
dest=Path('data/mediapipe_models/blaze_face_full_range.tflite'); \
print('Downloading MediaPipe model...'); \
urllib.request.urlretrieve(url, dest); \
print('Saved', dest)"

RUN python -c "\
from transformers import pipeline; \
print('Downloading animal ViT...'); \
pipeline('image-classification', model='dima806/pets_facial_expression_detection', device='cpu'); \
print('Animal ViT cached.')"

# --- Application ---
COPY models/ models/
COPY app/ app/
COPY static/ static/
COPY templates/ templates/
COPY docker/render-entrypoint.sh /usr/local/bin/render-entrypoint.sh
RUN chmod +x /usr/local/bin/render-entrypoint.sh

# Render injects PORT at runtime (e.g. 10000). Local: docker run -e PORT=8000 -p 8000:8000
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD python -c "import os,urllib.request; p=os.environ.get('PORT','8000'); urllib.request.urlopen('http://127.0.0.1:'+p+'/health', timeout=5)"

ENTRYPOINT ["/usr/local/bin/render-entrypoint.sh"]
