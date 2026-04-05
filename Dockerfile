# Use Python 3.11 slim image
FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install system dependencies for OpenCV and PyTorch
RUN apt-get update && apt-get install -y \
    libglib2.0-0 \
    libgomp1 \
    libxcb1 \
    libx11-6 \
    libxext6 \
    libgl1 \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for better caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the animal emotion ViT model at build time
# This bakes the weights into the image so Render starts instantly
ENV HF_HUB_DISABLE_SYMLINKS_WARNING=1
RUN python -c "\
from transformers import pipeline; \
print('Downloading dima806/pets_facial_expression_detection...'); \
pipeline('image-classification', model='dima806/pets_facial_expression_detection', device='cpu'); \
print('Model cached successfully.')"

# Copy models directory first (includes pre-downloaded HSEmotion weights)
COPY models/ models/

# Copy application code
COPY . .

# Expose port (Render will set PORT env var)
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

# Run the application
CMD uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}
