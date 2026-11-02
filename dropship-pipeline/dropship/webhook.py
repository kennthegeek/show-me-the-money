"""Shopify webhook listener (stdlib HTTP server — put it behind HTTPS: Caddy, nginx, Cloudflare Tunnel).

* Verifies X-Shopify-Hmac-Sha256 against the raw body (constant-time compare)
* De-duplicates on X-Shopify-Event-Id / X-Shopify-Webhook-Id (Shopify retries deliveries)
* Persists first, answers 200 fast, then routes the order on a background thread
  (Shopify expects a response within 5s; the order loop is the safety net).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import queue
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .db import Database
from .orders import OrderRouter

log = logging.getLogger(__name__)

MAX_BODY = 2 * 1024 * 1024
ORDER_TOPICS = {"orders/create", "orders/paid", "orders/updated", "orders/cancelled"}


def verify_hmac(secret: str, body: bytes, header: str | None) -> bool:
    if not secret or not header:
        return False
    digest = base64.b64encode(hmac.new(secret.encode(), body, hashlib.sha256).digest()).decode()
    return hmac.compare_digest(digest, header.strip())


class WebhookApp:
    """Transport-agnostic handler so it is unit-testable without sockets."""

    def __init__(self, secret: str, db: Database, router: OrderRouter, *, instant: bool = True):
        self.secret = secret
        self.db = db
        self.router = router
        self.instant = instant
        self.jobs: queue.Queue[str | None] = queue.Queue()
        self._worker: threading.Thread | None = None

    def start_worker(self) -> None:
        if self.instant and self._worker is None:
            self._worker = threading.Thread(target=self._drain, name="order-instant", daemon=True)
            self._worker.start()

    def stop_worker(self) -> None:
        if self._worker:
            self.jobs.put(None)
            self._worker.join(timeout=10)

    def _drain(self) -> None:
        while True:
            order_id = self.jobs.get()
            if order_id is None:
                return
            try:
                self.router.process_one(order_id)
            except Exception:
                log.exception("instant processing failed for %s", order_id)

    def handle(self, path: str, headers: dict[str, str], body: bytes) -> tuple[int, dict]:
        h = {k.lower(): v for k, v in headers.items()}
        if path != "/webhooks/shopify":
            return 404, {"error": "not found"}
        if not verify_hmac(self.secret, body, h.get("x-shopify-hmac-sha256")):
            log.warning("rejected webhook with bad HMAC (topic=%s)", h.get("x-shopify-topic"))
            return 401, {"error": "invalid signature"}
        topic = h.get("x-shopify-topic", "")
        event_id = h.get("x-shopify-event-id") or h.get("x-shopify-webhook-id")
        if event_id and not self.db.claim_webhook_event(event_id, topic):
            return 200, {"status": "duplicate"}
        if topic not in ORDER_TOPICS:
            return 200, {"status": "ignored", "topic": topic}
        try:
            payload = json.loads(body)
        except ValueError:
            return 400, {"error": "invalid json"}
        if not isinstance(payload, dict) or not payload.get("id"):
            return 400, {"error": "payload missing id"}

        order_id = str(payload["id"])
        if topic == "orders/create":
            self.router.ingest(payload)
        elif topic == "orders/cancelled":
            self.router.handle_cancel(payload)
            return 200, {"status": "ok"}
        else:
            self.router.handle_update(payload)
        self.db.audit("webhook", order_id, topic, {"event_id": event_id})
        if self.instant:
            self.jobs.put(order_id)
        return 200, {"status": "accepted"}


def make_server(app: WebhookApp, host: str, port: int, health=None) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        server_version = "dropship-webhook/1.0"

        def _send(self, code: int, obj: dict) -> None:
            data = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/healthz":
                self._send(200, health() if health else {"ok": True})
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_BODY:
                self._send(413 if length > MAX_BODY else 400, {"error": "bad length"})
                return
            body = self.rfile.read(length)
            try:
                code, resp = app.handle(self.path, dict(self.headers.items()), body)
            except Exception:
                log.exception("webhook handler crashed")
                code, resp = 500, {"error": "internal"}  # Shopify will retry
            self._send(code, resp)

        def log_message(self, fmt: str, *args) -> None:
            log.debug("http %s - %s", self.address_string(), fmt % args)

    return ThreadingHTTPServer((host, port), Handler)
