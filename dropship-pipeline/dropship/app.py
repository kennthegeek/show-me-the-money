"""Wiring: builds every component from Settings. One place to swap suppliers/storefronts."""

from __future__ import annotations

import logging
import logging.handlers
import sys
from dataclasses import dataclass
from pathlib import Path

from .config import Settings
from .db import Database
from .inventory import InventorySync
from .notify import Alerter, Mailer
from .orders import OrderRouter
from .sourcing import SourcingEngine
from .storefronts import MockStorefront, Storefront
from .suppliers import MockSupplier, Supplier
from .tracking import TrackingSync


class RedactingFilter(logging.Filter):
    """Belt-and-braces: keep secrets out of log files even if an exception echoes a request."""

    def __init__(self, secrets: list[str]):
        super().__init__()
        self.secrets = [x for x in secrets if x and len(x) >= 6]

    def filter(self, record: logging.LogRecord) -> bool:
        if self.secrets:
            msg = record.getMessage()
            for secret in self.secrets:
                msg = msg.replace(secret, "***")
            record.msg, record.args = msg, ()
        return True


def setup_logging(s: Settings) -> None:
    root = logging.getLogger()
    root.handlers.clear()
    root.setLevel(s.log_level.upper())
    fmt = logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    redact = RedactingFilter([s.shopify_access_token, s.cj_api_key, s.smtp_password, s.shopify_webhook_secret])
    console = logging.StreamHandler(sys.stderr)
    console.setFormatter(fmt)
    console.addFilter(redact)
    root.addHandler(console)
    if s.log_file:
        Path(s.log_file).parent.mkdir(parents=True, exist_ok=True)
        fh = logging.handlers.RotatingFileHandler(s.log_file, maxBytes=10_000_000, backupCount=5)
        fh.setFormatter(fmt)
        fh.addFilter(redact)
        root.addHandler(fh)
    logging.getLogger("httpx").setLevel(logging.WARNING)


def build_supplier(s: Settings) -> Supplier:
    if s.supplier == "mock":
        return MockSupplier()
    if s.supplier == "cj":
        from .suppliers.cj import CJSupplier

        return CJSupplier(s.cj_api_key, s.cj_base_url, logistic_name=s.cj_logistic_name,
                          from_country=s.cj_from_country, rate_per_sec=s.supplier_rate_per_sec)
    raise ValueError(f"unknown SUPPLIER {s.supplier!r} (supported: cj, mock)")


def build_storefront(s: Settings) -> Storefront:
    if s.storefront == "mock":
        return MockStorefront()
    if s.storefront == "shopify":
        from .storefronts.shopify import ShopifyStorefront

        return ShopifyStorefront(s.shopify_shop, s.shopify_access_token, s.shopify_api_version,
                                 s.shopify_location_id, rate_per_sec=s.shopify_rate_per_sec)
    raise ValueError(f"unknown STOREFRONT {s.storefront!r} (supported: shopify, mock)")


@dataclass
class App:
    settings: Settings
    db: Database
    supplier: Supplier
    store: Storefront
    mailer: Mailer
    alerter: Alerter
    sourcing: SourcingEngine
    inventory: InventorySync
    router: OrderRouter
    tracking: TrackingSync

    def close(self) -> None:
        self.supplier.close()
        self.store.close()
        self.db.close()


def build_app(s: Settings, *, supplier: Supplier | None = None, store: Storefront | None = None,
              db: Database | None = None, mailer: Mailer | None = None, alerter: Alerter | None = None) -> App:
    db = db or Database(s.database_url)
    db.init_schema()
    supplier = supplier or build_supplier(s)
    store = store or build_storefront(s)
    mailer = mailer or Mailer(s)
    alerter = alerter or Alerter(s, mailer)
    router = OrderRouter(s, db, supplier, alerter)
    return App(
        settings=s, db=db, supplier=supplier, store=store, mailer=mailer, alerter=alerter,
        sourcing=SourcingEngine(s, db, supplier, store, alerter),
        inventory=InventorySync(s, db, supplier, store, alerter),
        router=router,
        tracking=TrackingSync(s, db, supplier, store, router, mailer, alerter),
    )
