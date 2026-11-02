"""Resilient HTTP client: token-bucket rate limiting + exponential backoff with jitter.

Retries happen on network errors, 429 and 5xx. `Retry-After` is honoured. Non-idempotent
calls (anything that spends money) must pass `retry=False` or rely on a supplier-side
idempotency key — see orders.py.
"""

from __future__ import annotations

import logging
import random
import threading
import time
from typing import Any

import httpx

log = logging.getLogger(__name__)

RETRYABLE_STATUS = {408, 425, 429, 500, 502, 503, 504}


class ApiError(Exception):
    def __init__(self, message: str, status: int | None = None, body: Any = None, retryable: bool = False):
        super().__init__(message)
        self.status = status
        self.body = body
        self.retryable = retryable


class RateLimiter:
    """Thread-safe token bucket. `rate` tokens/sec, bursts up to `burst`."""

    def __init__(self, rate: float, burst: int | None = None):
        self.rate = max(rate, 0.01)
        self.capacity = float(burst if burst is not None else max(1, int(rate)))
        self.tokens = self.capacity
        self.updated = time.monotonic()
        self._lock = threading.Lock()

    def acquire(self) -> None:
        while True:
            with self._lock:
                now = time.monotonic()
                self.tokens = min(self.capacity, self.tokens + (now - self.updated) * self.rate)
                self.updated = now
                if self.tokens >= 1:
                    self.tokens -= 1
                    return
                wait = (1 - self.tokens) / self.rate
            time.sleep(wait)

    def penalize(self, seconds: float) -> None:
        """Drain the bucket after a 429 so other threads back off too."""
        with self._lock:
            self.tokens = -seconds * self.rate


class ResilientClient:
    def __init__(
        self,
        base_url: str,
        *,
        rate_per_sec: float = 2.0,
        max_retries: int = 5,
        base_delay: float = 1.0,
        max_delay: float = 60.0,
        timeout: float = 30.0,
        headers: dict[str, str] | None = None,
        transport: httpx.BaseTransport | None = None,
        name: str = "api",
        sleep=time.sleep,
    ):
        self.name = name
        self.limiter = RateLimiter(rate_per_sec)
        self.max_retries = max_retries
        self.base_delay = base_delay
        self.max_delay = max_delay
        self._sleep = sleep
        self.client = httpx.Client(
            base_url=base_url, timeout=timeout, headers=headers or {}, transport=transport
        )

    def _backoff(self, attempt: int, retry_after: str | None) -> float:
        if retry_after:
            try:
                return min(float(retry_after), self.max_delay)
            except ValueError:
                pass
        delay = min(self.max_delay, self.base_delay * (2**attempt))
        return delay * (0.5 + random.random() / 2)  # "equal jitter"

    def request(self, method: str, path: str, *, retry: bool = True, **kwargs: Any) -> httpx.Response:
        attempts = (self.max_retries + 1) if retry else 1
        last_exc: Exception | None = None
        for attempt in range(attempts):
            self.limiter.acquire()
            try:
                resp = self.client.request(method, path, **kwargs)
            except (httpx.TransportError, httpx.TimeoutException) as exc:
                last_exc = exc
                if attempt + 1 >= attempts:
                    break
                delay = self._backoff(attempt, None)
                log.warning("%s %s %s network error (%s); retry %d in %.1fs",
                            self.name, method, path, exc, attempt + 1, delay)
                self._sleep(delay)
                continue

            if resp.status_code in RETRYABLE_STATUS and attempt + 1 < attempts:
                delay = self._backoff(attempt, resp.headers.get("Retry-After"))
                if resp.status_code == 429:
                    self.limiter.penalize(delay)
                log.warning("%s %s %s -> %d; retry %d in %.1fs",
                            self.name, method, path, resp.status_code, attempt + 1, delay)
                self._sleep(delay)
                continue
            if resp.status_code >= 400:
                raise ApiError(
                    f"{self.name} {method} {path} failed with HTTP {resp.status_code}",
                    status=resp.status_code,
                    body=_safe_body(resp),
                    retryable=resp.status_code in RETRYABLE_STATUS,
                )
            return resp
        raise ApiError(f"{self.name} {method} {path}: retries exhausted ({last_exc})", retryable=True)

    def close(self) -> None:
        self.client.close()


def _safe_body(resp: httpx.Response) -> Any:
    try:
        return resp.json()
    except ValueError:
        return resp.text[:1000]
