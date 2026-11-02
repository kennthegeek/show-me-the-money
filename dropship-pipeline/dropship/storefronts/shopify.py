"""Shopify Admin GraphQL connector (API version from SHOPIFY_API_VERSION, default 2026-10).

Notes for 2026-04+ API versions:
  * inventorySetQuantities requires `changeFromQuantity` per quantity and an
    `@idempotent(key:)` directive. We pass `changeFromQuantity: null` because the
    supplier is the source of truth for dropship stock, and a deterministic key.
GraphQL cost throttling (`THROTTLED`) is retried with backoff on top of the HTTP layer.
"""

from __future__ import annotations

import hashlib
import logging
import time
from decimal import Decimal
from typing import Any

import httpx

from ..http import ApiError, ResilientClient
from ..models import CreatedListing, CreatedVariant, Listing, TrackingInfo
from .base import Storefront

log = logging.getLogger(__name__)

PRODUCT_SET = """
mutation importProduct($input: ProductSetInput!) {
  productSet(synchronous: true, input: $input) {
    product {
      id
      variants(first: 100) { nodes { id sku inventoryItem { id } } }
    }
    userErrors { field message code }
  }
}
"""

INVENTORY_SET = """
mutation syncStock($input: InventorySetQuantitiesInput!, $key: String!) {
  inventorySetQuantities(input: $input) @idempotent(key: $key) {
    userErrors { field message code }
  }
}
"""

INVENTORY_SET_LEGACY = """
mutation syncStock($input: InventorySetQuantitiesInput!) {
  inventorySetQuantities(input: $input) {
    userErrors { field message code }
  }
}
"""

VARIANTS_BULK_UPDATE = """
mutation reprice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    userErrors { field message }
  }
}
"""

PRODUCT_UPDATE = """
mutation setStatus($product: ProductUpdateInput!) {
  productUpdate(product: $product) {
    product { id status }
    userErrors { field message }
  }
}
"""

FULFILLMENT_ORDERS = """
query fulfillmentOrders($id: ID!) {
  order(id: $id) {
    fulfillmentOrders(first: 20) {
      nodes {
        id
        status
        lineItems(first: 100) { nodes { id remainingQuantity lineItem { id } } }
      }
    }
  }
}
"""

FULFILLMENT_CREATE = """
mutation ship($fulfillment: FulfillmentInput!) {
  fulfillmentCreate(fulfillment: $fulfillment) {
    fulfillment { id status }
    userErrors { field message }
  }
}
"""


def gid(kind: str, value: str | int) -> str:
    s = str(value)
    return s if s.startswith("gid://") else f"gid://shopify/{kind}/{s}"


class ShopifyStorefront(Storefront):
    name = "shopify"

    def __init__(
        self,
        shop: str,
        token: str,
        api_version: str,
        location_id: str,
        *,
        rate_per_sec: float = 2.0,
        transport: httpx.BaseTransport | None = None,
        sleep=time.sleep,
    ):
        if not (shop and token):
            raise ValueError("SHOPIFY_SHOP and SHOPIFY_ACCESS_TOKEN are required")
        shop = shop.removeprefix("https://").rstrip("/")
        if "." not in shop:
            shop = f"{shop}.myshopify.com"
        self.api_version = api_version
        self.location_gid = gid("Location", location_id) if location_id else ""
        self._sleep = sleep
        self.http = ResilientClient(
            f"https://{shop}/admin/api/{api_version}",
            rate_per_sec=rate_per_sec,
            name="shopify",
            headers={"X-Shopify-Access-Token": token, "Content-Type": "application/json"},
            transport=transport,
            sleep=sleep,
        )

    # -- plumbing --------------------------------------------------------------
    def graphql(self, query: str, variables: dict[str, Any], *, max_throttle_retries: int = 5) -> dict:
        for attempt in range(max_throttle_retries + 1):
            body = self.http.request("POST", "/graphql.json", json={"query": query, "variables": variables}).json()
            errors = body.get("errors") or []
            throttled = any((e.get("extensions") or {}).get("code") == "THROTTLED" for e in errors)
            if throttled and attempt < max_throttle_retries:
                delay = _throttle_delay(body, attempt)
                log.warning("shopify THROTTLED; sleeping %.1fs", delay)
                self._sleep(delay)
                continue
            if errors:
                raise ApiError(f"shopify graphql error: {errors}", body=body, retryable=throttled)
            return body.get("data") or {}
        raise ApiError("shopify graphql: throttle retries exhausted", retryable=True)

    @staticmethod
    def _check(payload: dict, op: str) -> dict:
        errs = (payload or {}).get("userErrors") or []
        if errs:
            raise ApiError(f"shopify {op}: {errs}", body=errs)
        return payload

    def _modern_inventory_api(self) -> bool:
        return self.api_version >= "2026-04"

    # -- interface ---------------------------------------------------------------
    def create_listing(self, listing: Listing) -> CreatedListing:
        option_names: list[str] = []
        for v in listing.variants:
            for k in v.options:
                if k not in option_names:
                    option_names.append(k)
        if not option_names:
            option_names = ["Title"]
        product_options = [
            {
                "name": name,
                "position": i + 1,
                "values": [{"name": val} for val in dict.fromkeys(
                    v.options.get(name, "Default Title") for v in listing.variants)],
            }
            for i, name in enumerate(option_names)
        ]
        files = [
            {"originalSource": url, "contentType": "IMAGE", "alt": f"{listing.title} image {i + 1}"}
            for i, url in enumerate(listing.images)
        ]
        variants = []
        for v in listing.variants:
            entry: dict[str, Any] = {
                "optionValues": [
                    {"optionName": n, "name": v.options.get(n, "Default Title")} for n in option_names
                ],
                "price": str(v.price),
                "inventoryPolicy": "DENY",  # never sell past available stock
                "inventoryItem": {"sku": v.sku, "tracked": True,
                                  **({"cost": str(v.cost)} if v.cost is not None else {})},
            }
            if v.compare_at:
                entry["compareAtPrice"] = str(v.compare_at)
            if self.location_gid:
                entry["inventoryQuantities"] = [
                    {"locationId": self.location_gid, "name": "available", "quantity": v.quantity}
                ]
            if v.image:
                entry["file"] = {"originalSource": v.image, "contentType": "IMAGE"}
            variants.append(entry)

        data = self.graphql(PRODUCT_SET, {"input": {
            "title": listing.title,
            "descriptionHtml": listing.description_html,
            "vendor": listing.vendor,
            "productType": listing.product_type,
            "tags": listing.tags,
            "status": listing.status,
            "productOptions": product_options,
            "files": files,
            "variants": variants,
        }})
        result = self._check(data.get("productSet"), "productSet")
        product = result["product"]
        return CreatedListing(
            product_id=product["id"],
            variants=[
                CreatedVariant(sku=n["sku"], variant_id=n["id"], inventory_item_id=n["inventoryItem"]["id"])
                for n in product["variants"]["nodes"]
            ],
        )

    def set_inventory(self, items: dict[str, int], reference: str) -> None:
        if not items:
            return
        if not self.location_gid:
            raise ApiError("SHOPIFY_LOCATION_ID is required to set inventory")
        modern = self._modern_inventory_api()
        quantities = []
        for item_id, qty in items.items():
            q: dict[str, Any] = {"inventoryItemId": gid("InventoryItem", item_id),
                                 "locationId": self.location_gid, "quantity": max(0, int(qty))}
            if modern:
                q["changeFromQuantity"] = None  # supplier is source of truth; opt out of CAS
            quantities.append(q)
        for chunk_start in range(0, len(quantities), 100):  # keep mutations small
            chunk = quantities[chunk_start:chunk_start + 100]
            inp: dict[str, Any] = {"name": "available", "reason": "correction",
                                   "referenceDocumentUri": f"dropship://inventory-sync/{reference}",
                                   "quantities": chunk}
            if modern:
                key = hashlib.sha256(f"{reference}:{chunk}".encode()).hexdigest()[:64]
                data = self.graphql(INVENTORY_SET, {"input": inp, "key": key})
            else:
                inp["ignoreCompareQuantity"] = True
                data = self.graphql(INVENTORY_SET_LEGACY, {"input": inp})
            self._check(data.get("inventorySetQuantities"), "inventorySetQuantities")

    def update_prices(self, product_id: str, prices: dict[str, tuple[Decimal, Decimal | None]]) -> None:
        variants = [
            {"id": gid("ProductVariant", vid), "price": str(p), "compareAtPrice": str(c) if c else None}
            for vid, (p, c) in prices.items()
        ]
        data = self.graphql(VARIANTS_BULK_UPDATE, {"productId": gid("Product", product_id), "variants": variants})
        self._check(data.get("productVariantsBulkUpdate"), "productVariantsBulkUpdate")

    def set_product_status(self, product_id: str, status: str) -> None:
        data = self.graphql(PRODUCT_UPDATE, {"product": {"id": gid("Product", product_id), "status": status}})
        self._check(data.get("productUpdate"), "productUpdate")

    def fulfill(self, order_id: str, tracking: TrackingInfo, line_item_ids: list[str], notify: bool) -> str:
        wanted = {gid("LineItem", x) for x in line_item_ids}
        data = self.graphql(FULFILLMENT_ORDERS, {"id": gid("Order", order_id)})
        groups = []
        for fo in ((data.get("order") or {}).get("fulfillmentOrders") or {}).get("nodes", []):
            if fo["status"] not in ("OPEN", "IN_PROGRESS", "SCHEDULED"):
                continue
            items = [
                {"id": li["id"], "quantity": li["remainingQuantity"]}
                for li in fo["lineItems"]["nodes"]
                if li["remainingQuantity"] > 0 and (not wanted or li["lineItem"]["id"] in wanted)
            ]
            if items:
                groups.append({"fulfillmentOrderId": fo["id"], "fulfillmentOrderLineItems": items})
        if not groups:
            raise ApiError(f"shopify: no open fulfillment order lines for order {order_id}")
        data = self.graphql(FULFILLMENT_CREATE, {"fulfillment": {
            "lineItemsByFulfillmentOrder": groups,
            "notifyCustomer": notify,
            "trackingInfo": {"number": tracking.tracking_number, "company": tracking.carrier, "url": tracking.url},
        }})
        res = self._check(data.get("fulfillmentCreate"), "fulfillmentCreate")
        return res["fulfillment"]["id"]

    def close(self) -> None:
        self.http.close()


def _throttle_delay(body: dict, attempt: int) -> float:
    try:
        cost = body["extensions"]["cost"]
        status = cost["throttleStatus"]
        need = float(cost.get("requestedQueryCost", 100)) - float(status["currentlyAvailable"])
        return max(1.0, need / float(status["restoreRate"]))
    except (KeyError, TypeError, ValueError, ZeroDivisionError):
        return min(30.0, 2.0 ** attempt)
