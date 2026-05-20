# Python 3.11 slim — Render / production
FROM python:3.11-slim

WORKDIR /app

# OpenCV, MediaPipe (headless), PyTorch CPU
RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 \
    libgomp1 \
    libxcb1 \
    libx11-6 \
    libxext6 \
    libsm6 \
    libxrender1 \
    libgl1 \
    libgl1-mesa-glx \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

# Pin numpy before mediapipe to avoid numpy 2.x breakage with torch/hsemotion
RUN pip install --no-cache-dir "numpy>=1.24.0,<2.0.0" && \
    pip install --no-cache-dir -r requirements.txt

ENV HF_HUB_DISABLE_SYMLINKS_WARNING=1

# Pre-cache Hugging Face animal ViT at build time
RUN python -c "\
from transformers import pipeline; \
print('Downloading dima806/pets_facial_expression_detection...'); \
pipeline('image-classification', model='dima806/pets_facial_expression_detection', device='cpu'); \
print('Animal model cached.')"

# Pre-cache MediaPipe BlazeFace model (human face detection)
RUN python -c "\
from pathlib import Path; \
import urllib.request; \
url='https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_full_range/float16/1/blaze_face_full_range.tflite'; \
p=Path('data/mediapipe_models'); p.mkdir(parents=True, exist_ok=True); \
dest=p/'blaze_face_full_range.tflite'; \
print('Downloading', url); \
urllib.request.urlretrieve(url, dest); \
print('MediaPipe face model cached at', dest)"

COPY models/ models/
COPY . .

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
    CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8000')+'/health')" || exit 1

# Render injects PORT; default 8000 for local docker run
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
