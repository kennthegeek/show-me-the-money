"""Layer 1 — Product sourcing & import.

keyword -> supplier search -> filter (stock, images, price sanity, not already imported)
-> clean title/description -> markup pricing -> storefront listing -> DB mapping.
"""

from __future__ import annotations

import html
import logging
import re
from dataclasses import dataclass, field
from decimal import Decimal

from .config import Settings
from .db import Database
from .models import Listing, ListingVariant, SupplierProduct
from .notify import Alerter
from .pricing import quote
from .storefronts import Storefront
from .suppliers import Supplier

log = logging.getLogger(__name__)

# Phrases suppliers stuff into titles that hurt conversion / trigger marketplace policy flags.
NOISE = re.compile(
    r"\b(hot sale|new arrival|free shipping|dropshipping|drop shipping|wholesale|factory|20\d\d|"
    r"cross[- ]border|amazon|ebay|aliexpress|best seller|high quality)\b",
    re.I,
)
UNSAFE_TAGS = re.compile(r"<\s*(script|iframe|style|object|embed|form)[^>]*>.*?<\s*/\s*\1\s*>", re.I | re.S)
EVENT_ATTRS = re.compile(r"\s+on\w+\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)", re.I)
SUPPLIER_IMG = re.compile(r"<img[^>]*>", re.I)


def clean_title(raw: str, max_len: int = 80) -> str:
    t = html.unescape(raw)
    t = NOISE.sub(" ", t)
    t = re.sub(r"[\[\]【】(){}|/\\]+", " ", t)
    t = re.sub(r"\s+", " ", t).strip(" -,")
    words = t.split()
    # De-duplicate repeated words ("Lamp LED Lamp Desk Lamp") while keeping order.
    seen: set[str] = set()
    out = [w for w in words if not (w.lower() in seen or seen.add(w.lower()))]
    title = " ".join(w if w.isupper() and len(w) <= 4 else w.capitalize() for w in out)
    if len(title) > max_len:
        title = title[:max_len].rsplit(" ", 1)[0]
    return title


def clean_description(raw: str, title: str) -> str:
    d = UNSAFE_TAGS.sub("", raw or "")
    d = EVENT_ATTRS.sub("", d)
    d = SUPPLIER_IMG.sub("", d)  # supplier-hosted inline images often carry watermarks / hotlink limits
    d = re.sub(r"(?i)\b(cj ?dropshipping|aliexpress|1688|taobao)\b", "", d)
    d = re.sub(r"(<br\s*/?>\s*){3,}", "<br><br>", d).strip()
    if not re.sub(r"<[^>]+>", "", d).strip():
        d = f"<p>{html.escape(title)}</p>"
    return d


def build_tags(keyword: str, product: SupplierProduct) -> list[str]:
    tags = {keyword.strip().lower(), "dropship"}
    if product.category:
        tags.add(product.category.strip().lower())
    tags.update(t.lower() for t in product.tags)
    return sorted(t for t in tags if t)[:25]


@dataclass
class ImportReport:
    imported: list[str] = field(default_factory=list)
    skipped: dict[str, str] = field(default_factory=dict)
    failed: dict[str, str] = field(default_factory=dict)


class SourcingEngine:
    def __init__(self, s: Settings, db: Database, supplier: Supplier, store: Storefront, alerter: Alerter):
        self.s, self.db, self.supplier, self.store, self.alerter = s, db, supplier, store, alerter

    def sku_for(self, variant_id: str) -> str:
        return f"{self.s.sku_prefix}-{self.supplier.name.upper()}-{variant_id}"

    def run(self, keywords: list[str] | None = None, per_keyword: int | None = None) -> ImportReport:
        report = ImportReport()
        keywords = keywords or self.s.niche_keywords
        per_keyword = per_keyword or self.s.import_per_keyword
        known = self.db.known_supplier_products(self.supplier.name)
        dest = self.s.allowed_countries[0] if self.s.allowed_countries else "US"

        for kw in keywords:
            imported_for_kw = 0
            try:
                candidates = self.supplier.search(kw, per_keyword)
            except Exception as exc:
                report.failed[f"search:{kw}"] = str(exc)
                self.alerter.alert(f"sourcing-search:{kw}", f"supplier search failed for '{kw}': {exc}")
                continue
            for pid in candidates:
                if imported_for_kw >= per_keyword:
                    break
                if pid in known:
                    report.skipped[pid] = "already imported"
                    continue
                try:
                    reason = self._import_one(pid, kw, dest)
                except Exception as exc:
                    log.exception("import of %s failed", pid)
                    report.failed[pid] = str(exc)
                    self.db.audit("product", pid, "import_failed", str(exc))
                    continue
                if reason:
                    report.skipped[pid] = reason
                else:
                    report.imported.append(pid)
                    known.add(pid)
                    imported_for_kw += 1
        return report

    def _import_one(self, pid: str, keyword: str, dest_country: str) -> str | None:
        """Import a product. Returns a skip reason, or None on success."""
        product = self.supplier.product(pid)
        if not product.variants:
            return "no variants"
        if not product.images:
            return "no images"

        stock = self.supplier.stock([v.variant_id for v in product.variants])
        for v in product.variants:
            if v.variant_id in stock:
                v.stock = stock[v.variant_id].stock
                v.cost = stock[v.variant_id].cost
        sellable = [v for v in product.variants if v.stock >= self.s.min_supplier_stock and v.cost > 0]
        if not sellable:
            return f"no variant with stock >= {self.s.min_supplier_stock}"

        shipping = self.supplier.shipping_quote(sellable[0].variant_id, dest_country)
        title = clean_title(product.title) or product.title
        listing_variants: list[ListingVariant] = []
        quotes = {}
        for v in sellable:
            q = quote(v.cost, shipping, self.s.pricing)
            quotes[v.variant_id] = q
            listing_variants.append(ListingVariant(
                sku=self.sku_for(v.variant_id),
                price=q.price,
                compare_at=q.compare_at,
                quantity=max(0, v.stock - self.s.stock_buffer),
                options=v.options or {"Title": v.name or "Default Title"},
                image=v.image,
                cost=q.landed_cost,
            ))
        # Shopify requires unique option combinations.
        combos = [tuple(sorted(lv.options.items())) for lv in listing_variants]
        if len(set(combos)) != len(combos):
            for lv, v in zip(listing_variants, sellable, strict=False):
                lv.options = {"Style": v.name or v.variant_id}

        listing = Listing(
            title=title,
            description_html=clean_description(product.description_html, title),
            images=product.images[: self.s.max_images],
            tags=build_tags(keyword, product),
            product_type=product.category or "General",
            vendor=self.s.store_name,
            status=self.s.publish_status if self.s.publish_status in {"ACTIVE", "DRAFT"} else "DRAFT",
            variants=listing_variants,
        )

        if self.s.dry_run:
            log.info("[DRY RUN] would import %s '%s' with %d variants (from %s)",
                     pid, title, len(listing_variants), min(q.price for q in quotes.values()))
            self.db.audit("product", pid, "dry_run_import",
                          {"title": title, "prices": {k: str(q.price) for k, q in quotes.items()}})
            return None

        created = self.store.create_listing(listing)
        by_sku = {cv.sku: cv for cv in created.variants}
        for v in sellable:
            sku = self.sku_for(v.variant_id)
            cv = by_sku.get(sku)
            if cv is None:
                raise RuntimeError(f"storefront did not return variant for sku {sku}")
            self.db.upsert_product({
                "supplier": self.supplier.name,
                "supplier_product_id": pid,
                "supplier_variant_id": v.variant_id,
                "sku": sku,
                "title": title,
                "storefront_product_id": created.product_id,
                "storefront_variant_id": cv.variant_id,
                "inventory_item_id": cv.inventory_item_id,
                "cost": v.cost,
                "shipping_cost": shipping,
                "price": quotes[v.variant_id].price,
                "stock": v.stock,
                "status": "active" if listing.status == "ACTIVE" else "draft",
            })
        self.db.audit("product", pid, "imported", {
            "storefront_product_id": created.product_id, "title": title,
            "variants": len(sellable), "min_price": str(min(q.price for q in quotes.values())),
        })
        log.info("imported %s -> %s (%d variants)", pid, created.product_id, len(sellable))
        return None


def preview(cost: str, shipping: str, s: Settings) -> dict:
    q = quote(Decimal(cost), Decimal(shipping), s.pricing)
    return {"landed_cost": str(q.landed_cost), "price": str(q.price),
            "compare_at": str(q.compare_at) if q.compare_at else None,
            "profit": str(q.profit), "margin_pct": str(q.margin_pct)}
