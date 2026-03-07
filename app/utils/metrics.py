"""
Simple in-memory metrics collection for production monitoring.

Tracks request latency, error rates, and model inference times.
"""
from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from threading import Lock
from typing import Dict, Optional

from app.utils.logging import get_logger

logger = get_logger(__name__)


@dataclass
class RequestMetrics:
    """Per-endpoint request metrics."""

    count: int = 0
    errors: int = 0
    latencies_ms: deque = field(default_factory=lambda: deque(maxlen=1000))  # Keep last 1000

    @property
    def error_rate(self) -> float:
        """Error rate as a fraction (0.0 to 1.0)."""
        if self.count == 0:
            return 0.0
        return self.errors / self.count

    @property
    def avg_latency_ms(self) -> float:
        """Average latency in milliseconds."""
        if not self.latencies_ms:
            return 0.0
        return sum(self.latencies_ms) / len(self.latencies_ms)

    @property
    def p50_latency_ms(self) -> float:
        """50th percentile latency."""
        return self._percentile(50)

    @property
    def p95_latency_ms(self) -> float:
        """95th percentile latency."""
        return self._percentile(95)

    @property
    def p99_latency_ms(self) -> float:
        """99th percentile latency."""
        return self._percentile(99)

    def _percentile(self, p: int) -> float:
        """Calculate percentile latency."""
        if not self.latencies_ms:
            return 0.0
        sorted_latencies = sorted(self.latencies_ms)
        idx = int(len(sorted_latencies) * p / 100)
        idx = min(idx, len(sorted_latencies) - 1)
        return float(sorted_latencies[idx])


class MetricsCollector:
    """
    Thread-safe metrics collector.

    Tracks per-endpoint metrics and model inference times.
    """

    def __init__(self) -> None:
        self._lock = Lock()
        self._endpoints: Dict[str, RequestMetrics] = {}
        self._model_times: deque = deque(maxlen=1000)

    def record_request(
        self,
        endpoint: str,
        latency_ms: float,
        is_error: bool = False,
    ) -> None:
        """Record a request metric."""
        with self._lock:
            if endpoint not in self._endpoints:
                self._endpoints[endpoint] = RequestMetrics()
            m = self._endpoints[endpoint]
            m.count += 1
            if is_error:
                m.errors += 1
            m.latencies_ms.append(latency_ms)

    def record_model_inference(self, time_ms: float) -> None:
        """Record model inference time."""
        with self._lock:
            self._model_times.append(time_ms)

    def get_endpoint_metrics(self, endpoint: str) -> Optional[RequestMetrics]:
        """Get metrics for a specific endpoint."""
        with self._lock:
            return self._endpoints.get(endpoint)

    def get_all_metrics(self) -> Dict[str, Dict[str, float]]:
        """
        Get summary of all metrics.

        Returns a dict suitable for JSON serialization.
        """
        with self._lock:
            result: Dict[str, Dict[str, float]] = {}
            for endpoint, metrics in self._endpoints.items():
                result[endpoint] = {
                    "count": metrics.count,
                    "errors": metrics.errors,
                    "error_rate": metrics.error_rate,
                    "avg_latency_ms": metrics.avg_latency_ms,
                    "p50_latency_ms": metrics.p50_latency_ms,
                    "p95_latency_ms": metrics.p95_latency_ms,
                    "p99_latency_ms": metrics.p99_latency_ms,
                }

            if self._model_times:
                sorted_times = sorted(self._model_times)
                result["model_inference"] = {
                    "avg_ms": sum(sorted_times) / len(sorted_times),
                    "p50_ms": sorted_times[int(len(sorted_times) * 0.5)],
                    "p95_ms": sorted_times[int(len(sorted_times) * 0.95)],
                    "p99_ms": sorted_times[int(len(sorted_times) * 0.99)],
                }

            return result

    def reset(self) -> None:
        """Reset all metrics (useful for testing)."""
        with self._lock:
            self._endpoints.clear()
            self._model_times.clear()


# Global singleton instance
_metrics = MetricsCollector()


def get_metrics() -> MetricsCollector:
    """Get the global metrics collector instance."""
    return _metrics
