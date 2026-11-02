"""Customer emails (tracking links) and operator alerts (Slack/Discord webhook + email)."""

from __future__ import annotations

import html
import logging
import smtplib
import ssl
import threading
import time
from email.message import EmailMessage

import httpx

from .config import Settings

log = logging.getLogger(__name__)


class Mailer:
    def __init__(self, s: Settings, sender=None):
        self.s = s
        self._send = sender or self._smtp_send

    @property
    def enabled(self) -> bool:
        return bool(self.s.smtp_host and self.s.email_from)

    def _smtp_send(self, msg: EmailMessage) -> None:
        ctx = ssl.create_default_context()
        if self.s.smtp_port == 465:
            with smtplib.SMTP_SSL(self.s.smtp_host, self.s.smtp_port, context=ctx, timeout=30) as smtp:
                if self.s.smtp_user:
                    smtp.login(self.s.smtp_user, self.s.smtp_password)
                smtp.send_message(msg)
            return
        with smtplib.SMTP(self.s.smtp_host, self.s.smtp_port, timeout=30) as smtp:
            if self.s.smtp_use_tls:
                smtp.starttls(context=ctx)
            if self.s.smtp_user:
                smtp.login(self.s.smtp_user, self.s.smtp_password)
            smtp.send_message(msg)

    def send(self, to: str, subject: str, text: str, html_body: str | None = None) -> None:
        msg = EmailMessage()
        msg["From"] = self.s.email_from
        msg["To"] = to
        msg["Subject"] = subject
        msg.set_content(text)
        if html_body:
            msg.add_alternative(html_body, subtype="html")
        self._send(msg)

    def send_tracking(self, to: str, customer: str, order_name: str, number: str, carrier: str, url: str) -> None:
        store = self.s.store_name
        first = (customer or "there").split()[0]
        subject = f"Your {store} order {order_name} has shipped"
        text = (
            f"Hi {first},\n\nGood news: your order {order_name} is on its way.\n\n"
            f"Carrier: {carrier}\nTracking number: {number}\nTrack it here: {url}\n\n"
            f"Tracking can take 24-48h to show the first scan.\n\nThanks for shopping with {store}!"
        )
        e = html.escape
        html_body = (
            f"<p>Hi {e(first)},</p><p>Good news: your order <b>{e(order_name)}</b> is on its way.</p>"
            f"<p>Carrier: {e(carrier)}<br>Tracking number: <b>{e(number)}</b></p>"
            f'<p><a href="{e(url)}">Track your package</a></p>'
            f"<p>Tracking can take 24-48h to show the first scan.</p><p>Thanks for shopping with {e(store)}!</p>"
        )
        self.send(to, subject, text, html_body)


class Alerter:
    """Sends operator alerts, de-duplicated per key for `alert_cooldown_sec`."""

    def __init__(self, s: Settings, mailer: Mailer | None = None, http_post=None):
        self.s = s
        self.mailer = mailer
        self._post = http_post or (lambda url, payload: httpx.post(url, json=payload, timeout=10))
        self._last: dict[str, float] = {}
        self._lock = threading.Lock()
        self.sent: list[tuple[str, str]] = []  # for inspection in tests / status

    def alert(self, key: str, message: str, *, level: str = "error") -> bool:
        now = time.monotonic()
        with self._lock:
            if now - self._last.get(key, -1e9) < self.s.alert_cooldown_sec:
                return False
            self._last[key] = now
        text = f"[dropship:{level}] {message}"
        log.log(logging.ERROR if level == "error" else logging.WARNING, "ALERT %s: %s", key, message)
        self.sent.append((key, message))
        if self.s.alert_webhook_url:
            try:
                # "text" works for Slack; "content" for Discord. Sending both is harmless.
                self._post(self.s.alert_webhook_url, {"text": text, "content": text})
            except Exception:  # alerting must never crash a worker
                log.exception("alert webhook failed")
        if self.s.alert_email and self.mailer and self.mailer.enabled:
            try:
                self.mailer.send(self.s.alert_email, f"[dropship] {key}", text)
            except Exception:
                log.exception("alert email failed")
        return True
