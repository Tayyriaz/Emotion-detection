# Project History — Multimodal Emotion Analyzer

## Project Overview

A production-ready FastAPI application that performs **multimodal emotion analysis** across three distinct domains: human face emotion (HSEmotion / EfficientNet), speech emotion (Groq Whisper + LLaMA), and animal (cat/dog) emotion (Hugging Face ViT). All three modalities share a unified dark-mode dashboard and individual standalone pages.

---

## Milestones & Key Decisions

### Phase 1 — Human Image Emotion Detection
- **Model**: `enet_b0_8_best_afew.pt` via `hsemotion` library (EfficientNet-B0, trained on AffectNet).
- **Pattern**: Singleton with double-checked locking (`HSEmotionDetector`) for thread-safe loading.
- **Endpoints**: `POST /image/emotion`, `WS /video/emotion`.
- **Frontend**: `static/image_emotion.html`, `static/video_emotion.html` + unified tab in `templates/index.html`.
- **Decision**: OpenCV Haar Cascade for fast CPU-side face detection before model inference.

### Phase 2 — Audio Speech Emotion Detection
- **Stack**: Groq API — Whisper transcription → LLaMA emotion analysis.
- **Endpoint**: `POST /api/audio/analyze`.
- **Frontend**: `static/audio_emotion.html` + Audio tab in dashboard.
- **Config**: `GROQ_API_KEY` via environment variable / `.env`.

### Phase 3 — Pet (Cat/Dog) Detection via YOLO (removed in v2)
- Initially added `yolov8n.pt` via `ultralytics`.
- Deployment issues: large model download (~6 MB), ~90 s startup on Render Free.
- Decision: removed entirely in favour of a lighter, semantically richer model.

### Phase 4 — Animal Emotion Detection via Hugging Face ViT (current)
- **Model**: `dima806/pets_facial_expression_detection`
  (Vision Transformer fine-tuned from `google/vit-base-patch16-224-in21k`, 4 labels: Angry / happy / Sad / Other).
- **Singleton**: `app/utils/models.py → AnimalEmotionModel` — lazy-loaded on first request.
- **Endpoint**: `POST /api/animal/analyze` — returns `label`, `confidence_score`, `all_emotions`, `timestamp`.
- **Frontend**: `static/animal_emotion.html` (standalone) + **Animal Emotion** tab in unified dashboard.
- **Memory**: CPU-only PyTorch (`torch==2.2.2+cpu`) specified in `requirements.txt` via
  `--extra-index-url https://download.pytorch.org/whl/cpu` to avoid ~1.5 GB RAM overhead of the CUDA build on Render Starter.

---

## Architecture

```
Hamza-Project/
├── app/
│   ├── config.py                  # pydantic-settings (env vars + defaults)
│   ├── main.py                    # Application factory (create_app)
│   ├── middleware/
│   │   └── request_tracking.py    # X-Request-ID, latency logging
│   ├── models/
│   │   └── schemas.py             # Pydantic response schemas
│   ├── routes/
│   │   ├── image.py               # POST /image/emotion
│   │   ├── video.py               # WS /video/emotion
│   │   ├── audio.py               # POST /api/audio/analyze
│   │   └── animal_emotion.py      # POST /api/animal/analyze  ← NEW v2
│   ├── services/
│   │   └── models/
│   │       └── hsemotion_detector.py  # HSEmotion singleton
│   └── utils/
│       ├── logging.py
│       ├── metrics.py
│       └── models.py              # AnimalEmotionModel singleton  ← NEW v2
├── static/
│   ├── css/
│   │   ├── style.css              # Global dark-mode design tokens
│   │   └── animal_emotion.css     # Standalone animal page styles
│   ├── js/
│   │   ├── app.js                 # Unified dashboard JS
│   │   ├── audio_emotion_standalone.js
│   │   └── animal_emotion_standalone.js  ← NEW v2
│   ├── audio_emotion.html
│   ├── image_emotion.html
│   ├── video_emotion.html
│   └── animal_emotion.html        ← NEW v2
├── templates/
│   └── index.html                 # Unified 4-tab dashboard
├── models/
│   └── enet_b0_8_best_afew.pt     # HSEmotion weights (local)
├── Dockerfile
├── render.yaml
├── requirements.txt
└── .env
```

---

## Completed Features

| Feature | Status |
|---|---|
| Image emotion detection (EfficientNet) | ✅ |
| Live webcam video emotion (WebSocket) | ✅ |
| Audio speech emotion (Groq) | ✅ |
| Animal emotion detection (ViT, Hugging Face) | ✅ |
| Unified dark-mode dashboard | ✅ |
| Standalone pages for each modality | ✅ |
| CPU-only PyTorch for Render RAM | ✅ |
| Lazy model loading (fast startup) | ✅ |
| Input validation: size, format, MIME | ✅ |
| Structured logging + request tracking | ✅ |
| `/health/model` endpoint | ✅ |
| Docker + Render deployment | ✅ |

---

## Pending / Next Steps

- [ ] Rate limiting on `/api/animal/analyze` (protect Render free tier).
- [ ] Auth middleware (API key or JWT) for production use.
- [ ] Cache animal model predictions for identical images (Redis or in-memory LRU).
- [ ] Add webcam/live streaming support to Animal Emotion tab.
- [ ] Batch image endpoint (`POST /api/animal/batch`).
- [ ] Playwright / pytest-asyncio integration tests for all endpoints.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `GROQ_API_KEY` | *(required)* | Groq API key for audio analysis |
| `ANIMAL_MODEL_NAME` | `dima806/pets_facial_expression_detection` | HF model ID |
| `MODEL_WARMUP` | `true` | Whether to warm up HSEmotion on startup |
| `LOG_LEVEL` | `INFO` | Python logging level |
| `CORS_ORIGINS` | `[]` (→ `*`) | Allowed CORS origins |

---

## Deployment — Render

```yaml
# render.yaml (excerpt)
services:
  - type: web
    name: emotion-detection
    env: docker
    autoDeploy: true
    envVars:
      - key: GROQ_API_KEY
        sync: false
```

Push to `main` → Render auto-builds Docker image → server starts in ~10–15 s (HSEmotion
loads eagerly; Animal ViT loads lazily on first `/api/animal/analyze` request).

---

*Last updated: 2026-04-05*
