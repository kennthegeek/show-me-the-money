"""Layer 3 — Order routing & fulfillment.

Webhook -> `ingest()` stores the raw order (state=received) and returns immediately.
`process()` then walks each order through:

    received --validate--> validated --create--> submitted --pay--> paid
         \\--> skipped (no supplier lines)   \\--> needs_review (any guard trips)

Guards before any money moves: order is paid & not cancelled, every routed SKU is
mapped, shipping address complete, destination allowed, supplier cost < revenue,
per-order cost <= MAX_ORDER_COST, today's spend + this order <= DAILY_SPEND_CAP.
Payment only happens when DRY_RUN=false AND ENABLE_SUPPLIER_PAYMENTS=true.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from .config import Settings
from .db import Database, OrderState
from .http import ApiError
from .models import OrderLine, ShippingAddress
from .notify import Alerter
from .suppliers import Supplier

log = logging.getLogger(__name__)

PHONE_PLACEHOLDER = "0000000000"


class ReviewRequired(Exception):
    """A guard failed — park the order for a human, do not retry automatically."""


@dataclass
class RoutedOrder:
    address: ShippingAddress
    lines: list[OrderLine]
    revenue: Decimal
    estimated_cost: Decimal


def parse_address(payload: dict) -> ShippingAddress:
    a = payload.get("shipping_address") or {}
    customer = payload.get("customer") or {}
    billing = payload.get("billing_address") or {}
    name = a.get("name") or " ".join(x for x in [a.get("first_name"), a.get("last_name")] if x)
    phone = (a.get("phone") or payload.get("phone") or billing.get("phone")
             or customer.get("phone") or PHONE_PLACEHOLDER)
    return ShippingAddress(
        name=(name or "").strip(),
        address1=(a.get("address1") or "").strip(),
        address2=(a.get("address2") or "").strip(),
        city=(a.get("city") or "").strip(),
        province=(a.get("province") or "").strip(),
        province_code=(a.get("province_code") or "").strip(),
        zip=(a.get("zip") or "").strip(),
        country=(a.get("country") or "").strip(),
        country_code=(a.get("country_code") or "").strip().upper(),
        phone=str(phone).strip(),
        email=(payload.get("email") or payload.get("contact_email") or customer.get("email") or "").strip(),
    )


class OrderRouter:
    def __init__(self, s: Settings, db: Database, supplier: Supplier, alerter: Alerter):
        self.s, self.db, self.supplier, self.alerter = s, db, supplier, alerter

    # -- intake -----------------------------------------------------------------
    def ingest(self, payload: dict) -> bool:
        order_id = str(payload.get("id") or "")
        if not order_id:
            raise ValueError("order payload has no id")
        addr = parse_address(payload)
        return self.db.insert_order(order_id, str(payload.get("name") or order_id), addr.email, addr.name, payload)

    def handle_update(self, payload: dict) -> None:
        """orders/paid and orders/updated: refresh the stored payload while still pre-submission."""
        order_id = str(payload.get("id") or "")
        row = self.db.order(order_id)
        if row is None:
            self.ingest(payload)
            return
        if row["state"] in (OrderState.RECEIVED, OrderState.NEEDS_REVIEW) and not row["supplier_order_id"]:
            state = OrderState.RECEIVED if row["state"] == OrderState.RECEIVED else None
            self.db.update_order(order_id, payload=json.dumps(payload), **({"state": state} if state else {}))

    def handle_cancel(self, payload: dict) -> None:
        order_id = str(payload.get("id") or "")
        row = self.db.order(order_id)
        if row is None:
            return
        if row["state"] in (OrderState.RECEIVED, OrderState.VALIDATED, OrderState.NEEDS_REVIEW,
                            OrderState.SKIPPED) and not row["supplier_order_id"]:
            self.db.update_order(order_id, state=OrderState.CANCELLED)
        elif row["state"] not in (OrderState.CANCELLED,):
            self.alerter.alert(f"cancel:{order_id}",
                               f"order {row['order_name']} was cancelled in the store but supplier order "
                               f"{row['supplier_order_id']} is already {row['state']} — cancel it at the supplier")

    # -- routing ------------------------------------------------------------------
    def route(self, payload: dict) -> RoutedOrder | None:
        lines: list[OrderLine] = []
        revenue = Decimal("0")
        for li in payload.get("line_items") or []:
            sku = (li.get("sku") or "").strip()
            if not sku:
                continue
            product = self.db.product_by_sku(sku)
            if product is None or product["supplier"] != self.supplier.name:
                continue
            qty = int(li.get("fulfillable_quantity", li.get("quantity", 0)) or 0)
            if qty <= 0:
                continue
            lines.append(OrderLine(sku=sku, supplier_variant_id=product["supplier_variant_id"], quantity=qty,
                                   unit_cost=Decimal(product["cost"]), line_item_id=str(li.get("id", ""))))
            revenue += Decimal(str(li.get("price") or "0")) * qty
            discounts = sum(Decimal(str(d.get("amount") or "0")) for d in li.get("discount_allocations") or [])
            revenue -= discounts
        if not lines:
            return None
        shipping = max((Decimal(self.db.product_by_sku(ln.sku)["shipping_cost"]) for ln in lines), default=Decimal(0))
        cost = sum((ln.unit_cost * ln.quantity for ln in lines), Decimal("0")) + shipping
        return RoutedOrder(parse_address(payload), lines, revenue, cost)

    def validate(self, payload: dict, routed: RoutedOrder) -> None:
        if payload.get("cancelled_at"):
            raise ReviewRequired("order is cancelled")
        if self.s.require_paid_orders and payload.get("financial_status") not in ("paid", None):
            raise ReviewRequired(f"financial_status is {payload.get('financial_status')!r}, not paid")
        if payload.get("test") and not self.s.dry_run:
            raise ReviewRequired("Shopify test order — not routing to supplier")
        missing = routed.address.missing_fields()
        if missing:
            raise ReviewRequired(f"shipping address missing {', '.join(missing)}")
        if self.s.allowed_countries and routed.address.country_code not in self.s.allowed_countries:
            raise ReviewRequired(f"destination {routed.address.country_code} not in ALLOWED_COUNTRIES")
        if routed.estimated_cost >= routed.revenue:
            raise ReviewRequired(f"supplier cost {routed.estimated_cost} >= revenue {routed.revenue}")
        if routed.estimated_cost > self.s.max_order_cost:
            raise ReviewRequired(f"estimated cost {routed.estimated_cost} > MAX_ORDER_COST {self.s.max_order_cost}")

    # -- worker entrypoint ---------------------------------------------------------
    def process(self, limit: int = 50) -> dict:
        stats = {"validated": 0, "submitted": 0, "paid": 0, "skipped": 0, "review": 0, "retry": 0}
        self._flag_stuck()
        for row in self.db.orders_in(OrderState.RECEIVED, OrderState.VALIDATED, OrderState.SUBMITTED, limit=limit):
            order_id = row["storefront_order_id"]
            try:
                self._advance(row, stats)
            except ReviewRequired as exc:
                stats["review"] += 1
                self._park(order_id, row["order_name"], str(exc))
            except Exception as exc:  # retryable / unexpected
                retryable = not isinstance(exc, ApiError) or exc.retryable or exc.status is None
                attempts = self.db.bump_attempt(order_id, str(exc))
                log.warning("order %s step failed (attempt %d): %s", row["order_name"], attempts, exc)
                if not retryable or attempts >= self.s.max_order_attempts:
                    stats["review"] += 1
                    self._park(order_id, row["order_name"], f"gave up after {attempts} attempt(s): {exc}")
                else:
                    stats["retry"] += 1
        return stats

    def process_one(self, order_id: str) -> None:
        """Called right after a webhook for near-instant routing (the loop is the safety net)."""
        row = self.db.order(order_id)
        if row and row["state"] in (OrderState.RECEIVED, OrderState.VALIDATED, OrderState.SUBMITTED):
            stats: dict = {k: 0 for k in ("validated", "submitted", "paid", "skipped", "review", "retry")}
            try:
                self._advance(row, stats)
            except ReviewRequired as exc:
                self._park(order_id, row["order_name"], str(exc))
            except Exception as exc:
                self.db.bump_attempt(order_id, str(exc))
                log.warning("instant routing for %s failed, loop will retry: %s", row["order_name"], exc)

    def _flag_stuck(self, minutes: int = 15) -> None:
        """A crash mid-call leaves SUBMITTING/PAYING behind. Outcome unknown -> human check."""
        cutoff = (datetime.now(UTC) - timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%SZ")
        for row in self.db.orders_in(OrderState.SUBMITTING, OrderState.PAYING):
            if row["updated_at"] < cutoff:
                self._park(row["storefront_order_id"], row["order_name"],
                           f"stuck in {row['state']} (worker crashed mid-call?) — check the supplier "
                           "dashboard before retrying")

    def _park(self, order_id: str, name: str, reason: str) -> None:
        self.db.update_order(order_id, state=OrderState.NEEDS_REVIEW, last_error=reason)
        self.alerter.alert(f"order-review:{order_id}", f"order {name} needs review: {reason}")

    def _advance(self, row: dict, stats: dict) -> None:
        order_id, name = row["storefront_order_id"], row["order_name"]
        payload = json.loads(row["payload"])
        state = row["state"]

        if state == OrderState.RECEIVED:
            routed = self.route(payload)
            if routed is None:
                self.db.update_order(order_id, state=OrderState.SKIPPED, last_error="no lines for this supplier")
                stats["skipped"] += 1
                return
            self.validate(payload, routed)
            self.db.update_order(order_id, state=OrderState.VALIDATED, revenue=routed.revenue,
                                 supplier_cost=routed.estimated_cost)
            stats["validated"] += 1
            state = OrderState.VALIDATED

        if state == OrderState.VALIDATED:
            routed = self.route(payload)
            if routed is None:
                raise ReviewRequired("order no longer has routable lines")
            if self.s.dry_run:
                if row.get("last_error") != "dry-run":
                    log.info("[DRY RUN] would submit %s to %s: %s (est. cost %s, revenue %s)", name,
                             self.supplier.name, [(ln.sku, ln.quantity) for ln in routed.lines],
                             routed.estimated_cost, routed.revenue)
                    self.db.update_order(order_id, last_error="dry-run")
                    self.db.audit("order", order_id, "dry_run_submit", {"cost": str(routed.estimated_cost)})
                return
            self._check_daily_cap(routed.estimated_cost)
            if not self.db.claim_state(order_id, OrderState.VALIDATED, OrderState.SUBMITTING):
                return  # another worker owns it
            try:
                result = self.supplier.create_order(self._reference(row), routed.address, routed.lines)
            except BaseException:
                self.db.claim_state(order_id, OrderState.SUBMITTING, OrderState.VALIDATED)
                raise
            self.db.update_order(order_id, state=OrderState.SUBMITTED, supplier_order_id=result.supplier_order_id,
                                 supplier_cost=result.total_cost, last_error=None, attempts=0)
            stats["submitted"] += 1
            row = {**row, "supplier_order_id": result.supplier_order_id, "supplier_cost": str(result.total_cost)}
            state = OrderState.SUBMITTED

        if state == OrderState.SUBMITTED:
            if self.s.dry_run:
                return
            if not self.s.enable_supplier_payments:
                if row.get("last_error") != "awaiting-manual-payment":
                    self.db.update_order(order_id, last_error="awaiting-manual-payment")
                    self.alerter.alert(f"pay:{order_id}",
                                       f"order {name} placed at supplier ({row['supplier_order_id']}) — pay it "
                                       "manually or set ENABLE_SUPPLIER_PAYMENTS=true", level="warning")
                return
            actual = Decimal(row["supplier_cost"] or "0")
            if actual > self.s.max_order_cost:
                raise ReviewRequired(f"supplier total {actual} > MAX_ORDER_COST; not paying")
            self._check_daily_cap(actual)
            if not self.db.claim_state(order_id, OrderState.SUBMITTED, OrderState.PAYING):
                return  # another worker owns it
            try:
                with self.db.transaction():
                    self._check_daily_cap(actual)
                    # Ledger row and payment succeed or fail together; a failed payment rolls back.
                    self.db.record_spend(order_id, actual)
                    self.supplier.pay_order(row["supplier_order_id"])
            except BaseException:
                self.db.claim_state(order_id, OrderState.PAYING, OrderState.SUBMITTED)
                raise
            self.db.update_order(order_id, state=OrderState.PAID, last_error=None, attempts=0)
            stats["paid"] += 1

    def _check_daily_cap(self, amount: Decimal) -> None:
        spent = self.db.spent_today()
        if spent + amount > self.s.daily_spend_cap:
            raise ReviewRequired(f"DAILY_SPEND_CAP reached ({spent} spent + {amount} > {self.s.daily_spend_cap})")

    @staticmethod
    def _reference(row: dict) -> str:
        # Stable per order so a retried create is rejected as a duplicate by the supplier
        # instead of shipping twice.
        return f"SHOP-{row['storefront_order_id']}"
