import os

import pytest

from dropship.app import build_app
from dropship.config import load_settings
from dropship.notify import Alerter, Mailer
from dropship.storefronts import MockStorefront
from dropship.suppliers import MockSupplier

BASE_ENV = {
    "DRY_RUN": "false",
    "ENABLE_SUPPLIER_PAYMENTS": "true",
    "SUPPLIER": "mock",
    "STOREFRONT": "mock",
    "DATABASE_URL": "sqlite:///:memory:",
    "LOG_FILE": "",
    "SHOPIFY_WEBHOOK_SECRET": "test-secret",
    "EMAIL_MODE": "smtp",
    "SMTP_HOST": "smtp.test",
    "EMAIL_FROM": "shop@test.dev",
    "ALERT_COOLDOWN_SEC": "0",
    "MIN_SUPPLIER_STOCK": "10",
    "NICHE_KEYWORDS": "pet hair,desk lamp",
    "IMPORT_PER_KEYWORD": "2",
    "PUBLISH_STATUS": "ACTIVE",
}


@pytest.fixture
def make_app(monkeypatch):
    created = []

    def _make(**overrides):
        for k in list(os.environ):
            if k in BASE_ENV or k.startswith(("SHOPIFY_", "CJ_", "PRICING_", "SMTP_")):
                monkeypatch.delenv(k, raising=False)
        for k, v in {**BASE_ENV, **overrides}.items():
            monkeypatch.setenv(k, v)
        s = load_settings(env_file=None)
        sent = []
        mailer = Mailer(s, sender=sent.append)
        posted = []
        alerter = Alerter(s, mailer, http_post=lambda url, payload: posted.append(payload))
        app = build_app(s, supplier=MockSupplier(), store=MockStorefront(), mailer=mailer, alerter=alerter)
        app.sent_mail = sent
        created.append(app)
        return app

    yield _make
    for a in created:
        a.db.close()


def shopify_order(order_id=5001, sku="DS-MOCK-P001-V1", qty=1, price="19.99", **extra):
    order = {
        "id": order_id,
        "name": f"#{order_id}",
        "email": "jane@example.com",
        "financial_status": "paid",
        "cancelled_at": None,
        "shipping_address": {
            "first_name": "Jane", "last_name": "Doe", "address1": "1 Main St", "address2": "",
            "city": "Austin", "province": "Texas", "province_code": "TX", "zip": "78701",
            "country": "United States", "country_code": "US", "phone": "+15125550100",
        },
        "line_items": [{"id": 9001, "sku": sku, "quantity": qty, "fulfillable_quantity": qty, "price": price}],
    }
    order.update(extra)
    return order
