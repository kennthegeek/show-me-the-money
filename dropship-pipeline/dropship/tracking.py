"""Layer 4 — Tracking sync.

paid/submitted --(supplier has tracking)--> shipped --(storefront fulfilled + email)--> fulfilled

Split into two persisted steps so a storefront/email failure never loses a tracking
number and never double-notifies the customer.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime, timedelta

from .config import Settings
from .db import Database, OrderState
from .models import TrackingInfo
from .notify import Alerter, Mailer
from .orders import OrderRouter
from .storefronts import Storefront
from .suppliers import Supplier

log = logging.getLogger(__name__)


class TrackingSync:
    def __init__(self, s: Settings, db: Database, supplier: Supplier, store: Storefront,
                 router: OrderRouter, mailer: Mailer, alerter: Alerter):
        self.s, self.db, self.supplier, self.store = s, db, supplier, store
        self.router, self.mailer, self.alerter = router, mailer, alerter

    def run(self, limit: int = 200) -> dict:
        stats = {"checked": 0, "shipped": 0, "fulfilled": 0, "stale": 0, "errors": 0}
        stale_before = (datetime.now(UTC) - timedelta(days=self.s.tracking_stale_days)).strftime("%Y-%m-%dT%H:%M:%SZ")

        for row in self.db.orders_in(OrderState.PAID, OrderState.SUBMITTED, limit=limit):
            if not row["supplier_order_id"]:
                continue
            stats["checked"] += 1
            try:
                info = self.supplier.tracking(row["supplier_order_id"])
            except Exception as exc:
                stats["errors"] += 1
                log.warning("tracking lookup failed for %s: %s", row["order_name"], exc)
                continue
            if info is None:
                if row["updated_at"] < stale_before:
                    stats["stale"] += 1
                    self.alerter.alert(f"stale:{row['storefront_order_id']}",
                                       f"order {row['order_name']} has no tracking after "
                                       f"{self.s.tracking_stale_days} days (supplier order {row['supplier_order_id']})",
                                       level="warning")
                continue
            self.db.update_order(row["storefront_order_id"], state=OrderState.SHIPPED,
                                 tracking_number=info.tracking_number, tracking_url=info.url, carrier=info.carrier)
            stats["shipped"] += 1

        for row in self.db.orders_in(OrderState.SHIPPED, limit=limit):
            try:
                if self._fulfill(row):
                    stats["fulfilled"] += 1
            except Exception as exc:
                stats["errors"] += 1
                attempts = self.db.bump_attempt(row["storefront_order_id"], f"fulfill: {exc}")
                if attempts >= self.s.max_order_attempts:
                    self.alerter.alert(f"fulfill:{row['storefront_order_id']}",
                                       f"could not mark {row['order_name']} fulfilled after {attempts} tries: {exc}")
        return stats

    def _fulfill(self, row: dict) -> bool:
        order_id = row["storefront_order_id"]
        info = TrackingInfo(row["tracking_number"], row["carrier"] or "", row["tracking_url"] or "")
        if self.s.dry_run:
            log.info("[DRY RUN] would fulfill %s with %s %s", row["order_name"], info.carrier, info.tracking_number)
            return False

        payload = json.loads(row["payload"])
        routed = self.router.route(payload)
        line_ids = [ln.line_item_id for ln in routed.lines if ln.line_item_id] if routed else []
        notify_via_store = self.s.email_mode in ("shopify", "both") and self.s.shopify_notify_customer
        fulfillment_id = self.store.fulfill(order_id, info, line_ids, notify=notify_via_store)
        self.db.audit("order", order_id, "storefront_fulfilled", {"fulfillment_id": fulfillment_id})

        if self.s.email_mode in ("smtp", "both") and row["customer_email"]:
            try:
                self.mailer.send_tracking(row["customer_email"], row["customer_name"] or "", row["order_name"],
                                          info.tracking_number, info.carrier, info.url)
                self.db.audit("order", order_id, "tracking_email_sent", {"to": row["customer_email"]})
            except Exception as exc:
                # The fulfillment exists; don't re-run it. Flag the email for a human instead.
                self.db.audit("order", order_id, "tracking_email_failed", str(exc))
                self.alerter.alert(f"email:{order_id}", f"tracking email for {row['order_name']} failed: {exc}")

        self.db.update_order(order_id, state=OrderState.FULFILLED, last_error=None)
        return True
