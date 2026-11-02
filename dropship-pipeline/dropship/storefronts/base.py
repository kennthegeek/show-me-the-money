"""Storefront interface. Shopify ships in-box; WooCommerce/BigCommerce can implement this."""

from __future__ import annotations

from abc import ABC, abstractmethod
from decimal import Decimal

from ..models import CreatedListing, Listing, TrackingInfo


class Storefront(ABC):
    name = "base"

    @abstractmethod
    def create_listing(self, listing: Listing) -> CreatedListing: ...

    @abstractmethod
    def set_inventory(self, items: dict[str, int], reference: str) -> None:
        """{inventory_item_id: available_quantity} at the configured location."""

    @abstractmethod
    def update_prices(self, product_id: str, prices: dict[str, tuple[Decimal, Decimal | None]]) -> None:
        """{variant_id: (price, compare_at)}"""

    @abstractmethod
    def set_product_status(self, product_id: str, status: str) -> None:
        """ACTIVE | DRAFT | ARCHIVED"""

    @abstractmethod
    def fulfill(self, order_id: str, tracking: TrackingInfo, line_item_ids: list[str], notify: bool) -> str:
        """Create a fulfillment with tracking for the given line items. Returns fulfillment id."""

    def close(self) -> None:  # pragma: no cover
        pass
