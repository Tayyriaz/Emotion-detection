"""
Request tracking middleware for logging and metrics.

Adds request IDs, logs requests, and collects metrics.
"""
from __future__ import annotations

import time
from typing import Callable

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

from app.utils.logging import get_logger, set_request_id
from app.utils.metrics import get_metrics

logger = get_logger(__name__)


class RequestTrackingMiddleware(BaseHTTPMiddleware):
    """
    Middleware that adds request IDs, logs requests, and collects metrics.

    - Generates a unique request ID per request
    - Logs request start/end with timing
    - Records metrics (latency, errors)
    """

    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app)

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        """Process request with tracking."""
        # Generate and set request ID
        request_id = set_request_id()
        request.state.request_id = request_id

        # Start timing
        start_time = time.time()

        # Log request start
        logger.info(
            f"{request.method} {request.url.path} - "
            f"Client: {request.client.host if request.client else 'unknown'}"
        )

        # Process request
        try:
            response = await call_next(request)
            is_error = response.status_code >= 400
        except Exception as exc:
            is_error = True
            logger.exception(f"Unhandled exception: {exc}")
            raise
        finally:
            # Calculate latency
            latency_ms = (time.time() - start_time) * 1000

            # Record metrics (skip static files)
            if not request.url.path.startswith("/static"):
                endpoint = f"{request.method} {request.url.path}"
                get_metrics().record_request(endpoint, latency_ms, is_error=is_error)

            # Log request completion
            status_emoji = "❌" if is_error else "✅"
            logger.info(
                f"{status_emoji} {request.method} {request.url.path} - "
                f"Status: {response.status_code if not is_error else 'ERROR'} - "
                f"Latency: {latency_ms:.1f}ms"
            )

        # Add request ID to response headers (useful for debugging)
        response.headers["X-Request-ID"] = request_id

        return response
