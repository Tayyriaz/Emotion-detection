#!/bin/sh
# Render web service entrypoint — bind to $PORT (injected by Render, e.g. 10000)
set -e
PORT="${PORT:-8000}"
exec uvicorn app.main:app --host 0.0.0.0 --port "$PORT" --workers 1
