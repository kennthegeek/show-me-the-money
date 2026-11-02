"""In-memory storefront used for dry runs and tests."""

from __future__ import annotations

import itertools
from decimal import Decimal

from ..models import CreatedListing, CreatedVariant, Listing, TrackingInfo
from .base import Storefront


class MockStorefront(Storefront):
    name = "mock"

    def __init__(self) -> None:
        self.products: dict[str, dict] = {}
        self.inventory: dict[str, int] = {}
        self.prices: dict[str, tuple[Decimal, Decimal | None]] = {}
        self.fulfillments: list[dict] = []
        self._ids = itertools.count(1)

    def create_listing(self, listing: Listing) -> CreatedListing:
        pid = f"gid://shopify/Product/{next(self._ids)}"
        variants = []
        for v in listing.variants:
            n = next(self._ids)
            cv = CreatedVariant(v.sku, f"gid://shopify/ProductVariant/{n}", f"gid://shopify/InventoryItem/{n}")
            self.inventory[cv.inventory_item_id] = v.quantity
            self.prices[cv.variant_id] = (v.price, v.compare_at)
            variants.append(cv)
        self.products[pid] = {"listing": listing, "status": listing.status}
        return CreatedListing(pid, variants)

    def set_inventory(self, items: dict[str, int], reference: str) -> None:
        self.inventory.update(items)

    def update_prices(self, product_id: str, prices: dict[str, tuple[Decimal, Decimal | None]]) -> None:
        self.prices.update(prices)

    def set_product_status(self, product_id: str, status: str) -> None:
        self.products[product_id]["status"] = status

    def fulfill(self, order_id: str, tracking: TrackingInfo, line_item_ids: list[str], notify: bool) -> str:
        fid = f"gid://shopify/Fulfillment/{next(self._ids)}"
        self.fulfillments.append({"id": fid, "order_id": order_id, "tracking": tracking,
                                  "lines": line_item_ids, "notify": notify})
        return fid
