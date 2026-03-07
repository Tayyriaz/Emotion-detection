# Use Python 3.11 slim image
FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install system dependencies for OpenCV and PyTorch
RUN apt-get update && apt-get install -y \
    libglib2.0-0 \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for better caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download HSEmotion model during build to avoid rate limiting at runtime
# If download fails, model will be downloaded on first request
RUN mkdir -p /root/.hsemotion && \
    python -c "import urllib.request; import time; import sys; \
    url = 'https://github.com/HSE-asavchenko/face-emotion-recognition/blob/main/models/affectnet_emotions/enet_b0_8_best_afew.pt?raw=true'; \
    fpath = '/root/.hsemotion/enet_b0_8_best_afew.pt'; \
    max_retries = 10; retry_delay = 15; \
    success = False; \
    for attempt in range(max_retries): \
        try: \
            print(f'[BUILD] Downloading model (attempt {attempt + 1}/{max_retries})...'); \
            urllib.request.urlretrieve(url, fpath); \
            print('[BUILD] Model downloaded successfully'); \
            success = True; \
            break; \
        except Exception as e: \
            if attempt < max_retries - 1: \
                wait = retry_delay * (2 ** min(attempt, 4)); \
                print(f'[BUILD] Failed: {e}. Retrying in {wait}s...'); \
                time.sleep(wait); \
            else: \
                print(f'[BUILD] Warning: Failed to download model. Will retry at runtime.'); \
    if not success: \
        print('[BUILD] Model will be downloaded on first request at runtime.')" || true

# Copy application code
COPY . .

# Expose port (Render will set PORT env var)
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

# Run the application
CMD uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}
