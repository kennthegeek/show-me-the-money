"""End-to-end flows against the mock supplier + mock storefront."""

import base64
import hashlib
import hmac
import json
from decimal import Decimal

from dropship.db import OrderState
from dropship.webhook import WebhookApp, verify_hmac

from .conftest import shopify_order


def _import(app):
    report = app.sourcing.run()
    assert report.imported, report
    return report


# -- Layer 1: sourcing -----------------------------------------------------------
def test_import_creates_listings_and_mappings(make_app):
    app = make_app()
    report = _import(app)
    assert set(report.imported) == {"P001", "P002"}
    row = app.db.product_by_sku("DS-MOCK-P001-V1")
    assert row["storefront_variant_id"].startswith("gid://shopify/ProductVariant/")
    assert Decimal(row["price"]) == Decimal("19.99")
    listing = next(iter(app.store.products.values()))["listing"]
    assert listing.variants[0].quantity == 500 - app.settings.stock_buffer
    # Second run is idempotent.
    again = app.sourcing.run()
    assert not again.imported and again.skipped["P001"] == "already imported"


def test_dry_run_import_writes_nothing(make_app):
    app = make_app(DRY_RUN="true")
    report = app.sourcing.run()
    assert report.imported and not app.store.products
    assert app.db.product_by_sku("DS-MOCK-P001-V1") is None


def test_import_skips_low_stock(make_app):
    app = make_app()
    for vid in ("P001-V1", "P001-V2"):
        app.supplier.set_stock(vid, 2)
    report = app.sourcing.run(["pet hair"])
    assert "P001" in report.skipped and not report.imported


# -- Layer 2: inventory ------------------------------------------------------------
def test_oos_pauses_product_and_restock_resumes(make_app):
    app = make_app()
    _import(app)
    row = app.db.product_by_sku("DS-MOCK-P001-V1")
    pid = row["storefront_product_id"]
    app.supplier.set_stock("P001-V1", 1)
    app.supplier.set_stock("P001-V2", 0)
    report = app.inventory.run()
    assert pid in report.paused
    assert app.store.products[pid]["status"] == "DRAFT"
    assert app.store.inventory[row["inventory_item_id"]] == 0
    assert app.db.product_by_sku("DS-MOCK-P001-V1")["paused_by_sync"] == 1

    app.supplier.set_stock("P001-V1", 200)
    report = app.inventory.run()
    assert pid in report.resumed
    assert app.store.products[pid]["status"] == "ACTIVE"
    assert app.store.inventory[row["inventory_item_id"]] == 195


def test_manually_drafted_product_is_not_reactivated(make_app):
    app = make_app()
    _import(app)
    row = app.db.product_by_sku("DS-MOCK-P001-V1")
    for r in app.db.products_for_supplier("mock"):
        if r["storefront_product_id"] == row["storefront_product_id"]:
            app.db.update_product(r["id"], status="draft")
    app.inventory.run()
    assert row["storefront_product_id"] not in app.inventory.run().resumed


def test_cost_increase_reprices_and_alerts(make_app):
    app = make_app()
    _import(app)
    app.supplier.set_cost("P001-V1", "9.00")
    report = app.inventory.run()
    assert report.price_updates == 1
    row = app.db.product_by_sku("DS-MOCK-P001-V1")
    assert Decimal(row["cost"]) == Decimal("9.00")
    assert Decimal(row["price"]) > Decimal("19.99")
    assert app.store.prices[row["storefront_variant_id"]][0] == Decimal(row["price"])
    assert any(k.startswith("cost:") for k, _ in app.alerter.sent)


def test_failed_stock_lookup_does_not_zero_inventory(make_app):
    app = make_app()
    _import(app)

    def boom(_ids):
        raise RuntimeError("supplier down")

    app.supplier.stock = boom
    report = app.inventory.run()
    assert report.errors and report.checked == 0
    assert all(q > 0 for q in app.store.inventory.values())


# -- Layer 3: orders -------------------------------------------------------------
def test_order_flows_to_paid(make_app):
    app = make_app()
    _import(app)
    assert app.router.ingest(shopify_order())
    stats = app.router.process()
    assert stats["paid"] == 1
    row = app.db.order("5001")
    assert row["state"] == OrderState.PAID
    assert row["supplier_order_id"] in app.supplier.paid
    assert app.db.spent_today() == Decimal(row["supplier_cost"])
    sup = app.supplier.orders[row["supplier_order_id"]]
    assert sup["reference"] == "SHOP-5001" and sup["lines"][0].quantity == 1


def test_duplicate_ingest_is_ignored(make_app):
    app = make_app()
    _import(app)
    assert app.router.ingest(shopify_order())
    assert not app.router.ingest(shopify_order())


def test_payments_disabled_stops_at_submitted(make_app):
    app = make_app(ENABLE_SUPPLIER_PAYMENTS="false")
    _import(app)
    app.router.ingest(shopify_order())
    app.router.process()
    row = app.db.order("5001")
    assert row["state"] == OrderState.SUBMITTED and not app.supplier.paid
    assert any(k.startswith("pay:") for k, _ in app.alerter.sent)


def test_dry_run_never_calls_supplier(make_app):
    app = make_app()
    _import(app)
    # Settings are frozen, so build a second (dry-run) app over the same database.
    dry = make_app(DRY_RUN="true")
    dry.db = app.db
    dry.router.db = app.db
    app.router.ingest(shopify_order())
    dry.router.process()
    assert app.db.order("5001")["state"] == OrderState.VALIDATED
    assert not dry.supplier.orders


def test_guards_park_orders_for_review(make_app):
    app = make_app(MAX_ORDER_COST="10")
    _import(app)
    app.router.ingest(shopify_order(5002, qty=5, price="19.99"))  # cost ~24.5 > 10
    app.router.ingest(shopify_order(5003, financial_status="pending"))
    bad = shopify_order(5004)
    bad["shipping_address"]["country_code"] = "KP"
    app.router.ingest(bad)
    app.router.ingest(shopify_order(5005, price="1.00"))  # sells below cost
    app.router.process()
    for oid in ("5002", "5003", "5004", "5005"):
        assert app.db.order(oid)["state"] == OrderState.NEEDS_REVIEW, oid
    assert not app.supplier.orders


def test_daily_spend_cap(make_app):
    app = make_app(DAILY_SPEND_CAP="10")
    _import(app)
    app.router.ingest(shopify_order(6001))
    app.router.ingest(shopify_order(6002))
    app.router.process()
    states = [app.db.order(o)["state"] for o in ("6001", "6002")]
    assert states == [OrderState.PAID, OrderState.NEEDS_REVIEW]
    assert app.db.spent_today() <= Decimal("10")


def test_orders_without_supplier_lines_are_skipped(make_app):
    app = make_app()
    _import(app)
    app.router.ingest(shopify_order(7001, sku="HANDMADE-1"))
    app.router.process()
    assert app.db.order("7001")["state"] == OrderState.SKIPPED


def test_transient_failure_retries_then_succeeds(make_app):
    app = make_app()
    _import(app)
    app.supplier.fail_next_create = ConnectionError("timeout")
    app.router.ingest(shopify_order())
    assert app.router.process()["retry"] == 1
    assert app.db.order("5001")["state"] == OrderState.VALIDATED
    assert app.router.process()["paid"] == 1


def test_cancel_before_submission(make_app):
    app = make_app(DRY_RUN="true")
    app.router.ingest(shopify_order())
    app.router.handle_cancel({"id": 5001})
    assert app.db.order("5001")["state"] == OrderState.CANCELLED


# -- Layer 4: tracking -------------------------------------------------------------
def test_tracking_fulfills_and_emails(make_app):
    app = make_app()
    _import(app)
    app.router.ingest(shopify_order())
    app.router.process()
    assert app.tracking.run()["shipped"] == 0  # not shipped yet
    row = app.db.order("5001")
    app.supplier.ship(row["supplier_order_id"], "YT123")
    stats = app.tracking.run()
    assert stats["shipped"] == 1 and stats["fulfilled"] == 1
    row = app.db.order("5001")
    assert row["state"] == OrderState.FULFILLED and row["tracking_number"] == "YT123"
    f = app.store.fulfillments[0]
    assert f["lines"] == ["9001"] and f["tracking"].tracking_number == "YT123" and f["notify"] is False
    assert len(app.sent_mail) == 1
    mail = app.sent_mail[0]
    assert mail["To"] == "jane@example.com" and "YT123" in mail.get_body(("plain",)).get_content()
    # Idempotent: nothing more happens.
    assert app.tracking.run()["fulfilled"] == 0 and len(app.sent_mail) == 1


def test_audit_log_records_lifecycle(make_app):
    app = make_app()
    _import(app)
    app.router.ingest(shopify_order())
    app.router.process()
    events = [r["event"] for r in app.db.query(
        "SELECT event FROM audit_log WHERE entity='order' AND entity_id='5001' ORDER BY id")]
    assert events[:4] == ["received", "state:validated", "state:submitted", "state:paid"]


# -- webhook -----------------------------------------------------------------
def _sign(body: bytes, secret="test-secret") -> str:
    return base64.b64encode(hmac.new(secret.encode(), body, hashlib.sha256).digest()).decode()


def test_webhook_verifies_dedupes_and_routes(make_app):
    app = make_app()
    _import(app)
    wh = WebhookApp("test-secret", app.db, app.router, instant=False)
    body = json.dumps(shopify_order()).encode()
    headers = {"X-Shopify-Topic": "orders/create", "X-Shopify-Hmac-Sha256": _sign(body),
               "X-Shopify-Event-Id": "evt-1"}
    assert wh.handle("/webhooks/shopify", headers, body) == (200, {"status": "accepted"})
    assert wh.handle("/webhooks/shopify", headers, body) == (200, {"status": "duplicate"})
    assert app.db.order("5001")["state"] == OrderState.RECEIVED

    bad = {**headers, "X-Shopify-Hmac-Sha256": _sign(body, "wrong"), "X-Shopify-Event-Id": "evt-2"}
    assert wh.handle("/webhooks/shopify", bad, body)[0] == 401
    assert wh.handle("/nope", headers, body)[0] == 404


def test_webhook_instant_worker_processes_order(make_app):
    app = make_app()
    _import(app)
    wh = WebhookApp("test-secret", app.db, app.router, instant=True)
    wh.start_worker()
    body = json.dumps(shopify_order()).encode()
    wh.handle("/webhooks/shopify", {"X-Shopify-Topic": "orders/create",
                                     "X-Shopify-Hmac-Sha256": _sign(body)}, body)
    wh.stop_worker()  # drains the queue
    assert app.db.order("5001")["state"] == OrderState.PAID


def test_hmac_rejects_missing_secret_or_header():
    assert not verify_hmac("", b"{}", "x")
    assert not verify_hmac("s", b"{}", None)
