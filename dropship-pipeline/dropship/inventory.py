"""Layer 2 — Inventory & price sync.

For every mapped variant: pull supplier stock + wholesale cost, then
  * push `max(0, stock - STOCK_BUFFER)` to the storefront (0 at/below OUT_OF_STOCK_THRESHOLD)
  * draft a product when every variant is out of stock (and re-activate it later,
    but only if *we* paused it — a product you drafted by hand stays drafted)
  * re-price when the wholesale cost moves, and alert on large swings
  * treat a variant the supplier no longer returns as delisted (stock 0 + alert)
"""

from __future__ import annotations

import logging
from collections import defaultdict
from dataclasses import dataclass, field
from decimal import Decimal

from .config import Settings
from .db import Database, utcnow
from .notify import Alerter
from .pricing import quote
from .storefronts import Storefront
from .suppliers import Supplier

log = logging.getLogger(__name__)

BATCH = 50


@dataclass
class SyncReport:
    checked: int = 0
    stock_updates: int = 0
    price_updates: int = 0
    paused: list[str] = field(default_factory=list)
    resumed: list[str] = field(default_factory=list)
    delisted: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


class InventorySync:
    def __init__(self, s: Settings, db: Database, supplier: Supplier, store: Storefront, alerter: Alerter):
        self.s, self.db, self.supplier, self.store, self.alerter = s, db, supplier, store, alerter

    def available(self, supplier_stock: int) -> int:
        if supplier_stock <= self.s.out_of_stock_threshold:
            return 0
        return max(0, supplier_stock - self.s.stock_buffer)

    def run(self, force: bool = False) -> SyncReport:
        """`force=True` re-pushes every stock level (repairs drift after manual edits)."""
        report = SyncReport()
        rows = self.db.products_for_supplier(self.supplier.name)
        if not rows:
            return report

        levels = {}
        for i in range(0, len(rows), BATCH):
            chunk = rows[i:i + BATCH]
            try:
                levels.update(self.supplier.stock([r["supplier_variant_id"] for r in chunk]))
            except Exception as exc:
                # One bad batch must not zero out stock: skip these rows this round.
                msg = f"stock lookup failed for {len(chunk)} variants: {exc}"
                report.errors.append(msg)
                self.alerter.alert("inventory-stock-lookup", msg)
                for r in chunk:
                    levels[r["supplier_variant_id"]] = None

        inventory_updates: dict[str, int] = {}
        price_updates: dict[str, dict[str, tuple[Decimal, Decimal | None]]] = defaultdict(dict)
        db_updates: dict[int, dict] = {}
        by_product: dict[str, list[tuple[dict, int]]] = defaultdict(list)

        for r in rows:
            vid = r["supplier_variant_id"]
            if vid in levels and levels[vid] is None:
                continue  # lookup failed this round; leave untouched
            report.checked += 1
            level = levels.get(vid)
            old_stock = int(r["stock"])
            changes: dict = {}
            if level is None:
                new_stock = 0
                report.delisted.append(r["sku"])
                self.alerter.alert(f"delisted:{r['sku']}",
                                   f"supplier no longer returns variant {vid} ({r['title']}); set to 0",
                                   level="warning")
            else:
                new_stock = level.stock
                old_cost = Decimal(r["cost"])
                if level.cost != old_cost and level.cost > 0:
                    changes.update(self._reprice(r, old_cost, level.cost, price_updates, report))
            avail_changed = force or self.available(new_stock) != self.available(old_stock)
            if avail_changed or new_stock != old_stock:
                if avail_changed and r["inventory_item_id"]:
                    inventory_updates[r["inventory_item_id"]] = self.available(new_stock)
                changes["stock"] = new_stock
            if changes:
                db_updates[r["id"]] = changes
            if r["storefront_product_id"]:
                by_product[r["storefront_product_id"]].append((r, self.available(new_stock)))

        report.stock_updates = len(inventory_updates)
        report.price_updates = sum(len(v) for v in price_updates.values())

        status_changes: dict[str, str] = {}
        if self.s.auto_pause_oos:
            for product_id, variants in by_product.items():
                any_stock = any(avail > 0 for _, avail in variants)
                statuses = {r["status"] for r, _ in variants}
                paused_by_us = any(r["paused_by_sync"] for r, _ in variants)
                if not any_stock and "active" in statuses:
                    status_changes[product_id] = "DRAFT"
                    report.paused.append(product_id)
                elif any_stock and paused_by_us:
                    status_changes[product_id] = "ACTIVE"
                    report.resumed.append(product_id)

        if self.s.dry_run:
            log.info("[DRY RUN] inventory: %d stock, %d price, pause=%s resume=%s",
                     report.stock_updates, report.price_updates, report.paused, report.resumed)
            return report

        # Storefront writes first; only record in DB what actually landed.
        if inventory_updates:
            try:
                self.store.set_inventory(inventory_updates, reference=utcnow())
            except Exception as exc:
                report.errors.append(f"set_inventory: {exc}")
                self.alerter.alert("inventory-push", f"failed to push {len(inventory_updates)} stock levels: {exc}")
                for changes in db_updates.values():
                    changes.pop("stock", None)
        for product_id, prices in price_updates.items():
            try:
                self.store.update_prices(product_id, prices)
            except Exception as exc:
                report.errors.append(f"update_prices {product_id}: {exc}")
                self.alerter.alert(f"reprice:{product_id}", f"price update failed for {product_id}: {exc}")
                for r in rows:
                    if r["storefront_product_id"] == product_id and r["id"] in db_updates:
                        db_updates[r["id"]].pop("price", None)
                        db_updates[r["id"]].pop("cost", None)
        for row_id, changes in db_updates.items():
            if changes:
                self.db.update_product(row_id, **changes)

        for product_id, status in status_changes.items():
            try:
                self.store.set_product_status(product_id, status)
            except Exception as exc:
                report.errors.append(f"status {product_id}: {exc}")
                self.alerter.alert(f"status:{product_id}", f"could not set {product_id} to {status}: {exc}")
                continue
            for r, _ in by_product[product_id]:
                if status == "DRAFT":
                    self.db.update_product(r["id"], status="draft", paused_by_sync=1)
                else:
                    self.db.update_product(r["id"], status="active", paused_by_sync=0)
            self.db.audit("product", product_id, "paused_oos" if status == "DRAFT" else "resumed")
            if status == "DRAFT":
                self.alerter.alert(f"oos:{product_id}", f"product {product_id} paused: all variants out of stock",
                                   level="warning")
        return report

    def _reprice(self, r: dict, old_cost: Decimal, new_cost: Decimal,
                 price_updates: dict, report: SyncReport) -> dict:
        pct = (new_cost - old_cost) / old_cost * 100 if old_cost else Decimal(100)
        self.db.audit("product", r["sku"], "cost_changed",
                      {"old": str(old_cost), "new": str(new_cost), "pct": f"{pct:.1f}"})
        if abs(pct) >= self.s.cost_change_alert_pct:
            self.alerter.alert(f"cost:{r['sku']}",
                               f"wholesale cost for {r['sku']} moved {pct:+.1f}% ({old_cost} -> {new_cost})",
                               level="warning")
        q = quote(new_cost, Decimal(r["shipping_cost"]), self.s.pricing)
        current_price = Decimal(r["price"])
        if not self.s.auto_reprice:
            if q.landed_cost >= current_price:
                self.alerter.alert(f"loss:{r['sku']}",
                                   f"{r['sku']} now sells at a loss ({current_price} <= landed {q.landed_cost}); "
                                   "AUTO_REPRICE is off")
            return {"cost": new_cost}
        if q.price != current_price and r["storefront_variant_id"]:
            price_updates[r["storefront_product_id"]][r["storefront_variant_id"]] = (q.price, q.compare_at)
            return {"cost": new_cost, "price": q.price}
        return {"cost": new_cost}
