"""Supplier interface. Add Zendrop/AliExpress/etc. by implementing this class."""

from __future__ import annotations

from abc import ABC, abstractmethod
from decimal import Decimal

from ..models import (
    OrderLine,
    ShippingAddress,
    StockLevel,
    SupplierOrderResult,
    SupplierProduct,
    TrackingInfo,
)


class Supplier(ABC):
    name: str = "base"

    @abstractmethod
    def search(self, keyword: str, limit: int) -> list[str]:
        """Return supplier product ids matching a niche keyword."""

    @abstractmethod
    def product(self, product_id: str) -> SupplierProduct:
        """Full product detail incl. variants, images, description."""

    @abstractmethod
    def stock(self, variant_ids: list[str]) -> dict[str, StockLevel]:
        """Current stock + wholesale cost per variant id."""

    @abstractmethod
    def shipping_quote(self, variant_id: str, country_code: str) -> Decimal:
        """Cheapest shipping cost for one unit to a destination."""

    @abstractmethod
    def create_order(
        self, reference: str, address: ShippingAddress, lines: list[OrderLine]
    ) -> SupplierOrderResult:
        """Place (but do not pay) an order. `reference` must be idempotent."""

    @abstractmethod
    def pay_order(self, supplier_order_id: str) -> None:
        """Pay a placed order from pre-funded balance / linked payment method."""

    @abstractmethod
    def tracking(self, supplier_order_id: str) -> TrackingInfo | None:
        """Tracking info once shipped, else None."""

    def close(self) -> None:  # pragma: no cover - optional
        pass


def tracking_url(number: str) -> str:
    return f"https://t.17track.net/en#nums={number}"
