"""In-memory supplier for local dry runs and tests. Never touches the network."""

from __future__ import annotations

import itertools
from decimal import Decimal

from ..models import (
    OrderLine,
    ShippingAddress,
    StockLevel,
    SupplierOrderResult,
    SupplierProduct,
    SupplierVariant,
    TrackingInfo,
)
from .base import Supplier, tracking_url


class MockSupplier(Supplier):
    name = "mock"

    def __init__(self) -> None:
        self.catalog: dict[str, SupplierProduct] = {}
        self.orders: dict[str, dict] = {}
        self.paid: set[str] = set()
        self._ids = itertools.count(1000)
        self.fail_next_create: Exception | None = None
        for i, (title, cost) in enumerate(
            [("Reusable Pet Hair Remover Roller", "4.20"), ("Dimmable LED Desk Lamp", "11.80"),
             ("Magnetic Phone Car Mount", "2.90")], start=1):
            pid = f"P{i:03d}"
            self.catalog[pid] = SupplierProduct(
                product_id=pid,
                title=title,
                description_html=f"<p>{title}. Durable, lightweight and easy to use.</p>",
                images=[f"https://example.com/img/{pid}-{n}.jpg" for n in range(1, 4)],
                variants=[
                    SupplierVariant(f"{pid}-V{c}", f"{pid}-{c}", color, Decimal(cost), 500,
                                    options={"Color": color})
                    for c, color in enumerate(["Black", "White"], start=1)
                ],
                category="Home",
            )

    # -- test helpers ---------------------------------------------------------
    def _variant(self, vid: str) -> SupplierVariant:
        for p in self.catalog.values():
            for v in p.variants:
                if v.variant_id == vid:
                    return v
        raise KeyError(vid)

    def set_stock(self, vid: str, qty: int) -> None:
        self._variant(vid).stock = qty

    def set_cost(self, vid: str, cost: str) -> None:
        self._variant(vid).cost = Decimal(cost)

    def ship(self, supplier_order_id: str, number: str = "YT2400000000001") -> None:
        self.orders[supplier_order_id]["tracking"] = number

    # -- interface ------------------------------------------------------------
    def search(self, keyword: str, limit: int) -> list[str]:
        words = keyword.lower().split()
        hits = [pid for pid, p in self.catalog.items() if any(w in p.title.lower() for w in words)]
        return hits[:limit]

    def product(self, product_id: str) -> SupplierProduct:
        return self.catalog[product_id]

    def stock(self, variant_ids: list[str]) -> dict[str, StockLevel]:
        return {vid: StockLevel(vid, self._variant(vid).stock, self._variant(vid).cost) for vid in variant_ids}

    def shipping_quote(self, variant_id: str, country_code: str) -> Decimal:
        return Decimal("3.50")

    def create_order(self, reference: str, address: ShippingAddress, lines: list[OrderLine]) -> SupplierOrderResult:
        if self.fail_next_create:
            exc, self.fail_next_create = self.fail_next_create, None
            raise exc
        for existing_id, o in self.orders.items():
            if o["reference"] == reference:
                return SupplierOrderResult(existing_id, o["total"], raw=o)
        oid = f"CJ{next(self._ids)}"
        total = sum((self._variant(ln.supplier_variant_id).cost * ln.quantity for ln in lines), Decimal("0"))
        total += Decimal("3.50")
        self.orders[oid] = {"reference": reference, "total": total, "lines": lines, "tracking": None}
        return SupplierOrderResult(oid, total, raw={"orderId": oid})

    def pay_order(self, supplier_order_id: str) -> None:
        self.paid.add(supplier_order_id)

    def tracking(self, supplier_order_id: str) -> TrackingInfo | None:
        number = self.orders.get(supplier_order_id, {}).get("tracking")
        if not number:
            return None
        return TrackingInfo(number, "YunExpress", tracking_url(number), "SHIPPED")
