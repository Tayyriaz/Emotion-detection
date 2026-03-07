"""
Structured logging utilities for production.

Provides request ID tracking and consistent log formatting.
"""
from __future__ import annotations

import logging
import sys
import uuid
from contextvars import ContextVar
from typing import Optional

# Context variable for request ID (thread-safe, async-safe)
_request_id: ContextVar[Optional[str]] = ContextVar("request_id", default=None)


def get_request_id() -> Optional[str]:
    """Get the current request ID from context."""
    return _request_id.get()


def set_request_id(request_id: Optional[str] = None) -> str:
    """
    Set a request ID in the current context.

    If None is provided, generates a new UUID.
    Returns the request ID that was set.
    """
    if request_id is None:
        request_id = str(uuid.uuid4())[:8]  # Short ID for readability
    _request_id.set(request_id)
    return request_id


def configure_logging(log_level: str = "INFO") -> None:
    """
    Configure application-wide logging with structured format.

    Includes request ID in log messages when available.
    """
    level = getattr(logging, log_level.upper(), logging.INFO)

    class RequestIDFilter(logging.Filter):
        """Add request ID to log records."""

        def filter(self, record: logging.LogRecord) -> bool:
            record.request_id = get_request_id() or "-"
            return True

    # Create formatter with request ID
    formatter = logging.Formatter(
        fmt="%(asctime)s [%(levelname)s] [%(request_id)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    # Configure root logger
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)
    handler.addFilter(RequestIDFilter())

    root_logger = logging.getLogger()
    root_logger.setLevel(level)
    root_logger.addHandler(handler)

    # Reduce noise from third-party libraries
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("uvicorn.error").setLevel(logging.INFO)


def get_logger(name: str) -> logging.Logger:
    """Get a logger instance for a module."""
    return logging.getLogger(name)
