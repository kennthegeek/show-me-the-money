"""Command-line entry point:  python -m dropship <command>   (or `dropship <command>` once installed)."""

from __future__ import annotations

import argparse
import json
import logging
import sys
import threading

from .app import App, build_app, setup_logging
from .config import load_settings, validate_for_live
from .db import Database, OrderState
from .scheduler import Scheduler
from .sourcing import preview
from .webhook import WebhookApp, make_server

log = logging.getLogger("dropship")


def _print(obj) -> None:
    print(json.dumps(obj, indent=2, default=lambda o: getattr(o, "__dict__", str(o))))


def _banner(app: App) -> None:
    s = app.settings
    mode = "DRY RUN (no writes, no purchases)" if s.dry_run else "LIVE"
    pay = "ON" if (s.enable_supplier_payments and not s.dry_run) else "OFF"
    log.info("mode=%s supplier=%s storefront=%s payments=%s caps: order<=%s day<=%s",
             mode, app.supplier.name, app.store.name, pay, s.max_order_cost, s.daily_spend_cap)


def build_scheduler(app: App) -> Scheduler:
    s = app.settings
    sched = Scheduler(app.db, app.alerter)
    sched.add("orders", s.order_interval, app.router.process)
    sched.add("tracking", s.tracking_interval, app.tracking.run)
    sched.add("inventory", s.inventory_interval, app.inventory.run)
    sched.add("sourcing", s.sourcing_interval, app.sourcing.run, run_immediately=False)
    return sched


def start_webhook(app: App) -> tuple[WebhookApp, object, threading.Thread]:
    s = app.settings
    if not s.shopify_webhook_secret:
        raise SystemExit("SHOPIFY_WEBHOOK_SECRET must be set to accept webhooks")
    wh = WebhookApp(s.shopify_webhook_secret, app.db, app.router)
    wh.start_worker()
    server = make_server(wh, s.webhook_host, s.webhook_port, health=lambda: {"ok": True, **app.db.status_summary()})
    t = threading.Thread(target=server.serve_forever, name="webhook-http", daemon=True)
    t.start()
    log.info("webhook listening on http://%s:%d/webhooks/shopify", s.webhook_host, s.webhook_port)
    return wh, server, t


def _db_command(args, s) -> int:
    """Commands that only need the database (no API credentials)."""
    db = Database(s.database_url)
    try:
        db.init_schema()
        if args.cmd == "init-db":
            print(f"database ready: {s.database_url}")
        elif args.cmd == "status":
            _print(db.status_summary())
        elif args.cmd == "retry-order":
            row = db.order(args.order_id)
            if not row:
                print("no such order", file=sys.stderr)
                return 1
            if row["state"] not in (OrderState.NEEDS_REVIEW, OrderState.SUBMITTING, OrderState.PAYING):
                print(f"order is {row['state']}; only needs_review/submitting/paying can be retried", file=sys.stderr)
                return 1
            target = OrderState.SUBMITTED if row["supplier_order_id"] else OrderState.RECEIVED
            db.update_order(args.order_id, state=target, attempts=0, last_error=None)
            print(f"order {row['order_name']} -> {target}")
        return 0
    finally:
        db.close()


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="dropship", description="Shopify <-> supplier dropshipping automation")
    p.add_argument("--env-file", default=".env", help="path to .env (default: ./.env)")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init-db", help="create database tables")
    sub.add_parser("check", help="validate configuration for a live run")
    pp = sub.add_parser("price-preview", help="show the computed retail price for a wholesale cost")
    pp.add_argument("--cost", required=True)
    pp.add_argument("--shipping", default="0")

    imp = sub.add_parser("import", help="source products by niche keyword and list them")
    imp.add_argument("--keyword", "-k", action="append", help="repeatable; defaults to NICHE_KEYWORDS")
    imp.add_argument("--limit", type=int, help="products per keyword (default IMPORT_PER_KEYWORD)")

    inv = sub.add_parser("sync-inventory", help="one inventory/price sync pass")
    inv.add_argument("--force", action="store_true", help="re-push every stock level")
    sub.add_parser("route-orders", help="one order-routing pass")
    sub.add_parser("sync-tracking", help="one tracking pass")
    sub.add_parser("serve", help="webhook listener only")
    sub.add_parser("worker", help="scheduled loops only (no webhook)")
    sub.add_parser("run", help="webhook listener + scheduled loops in one process (recommended)")
    sub.add_parser("status", help="order/product counts, today's spend, recent job runs")

    r = sub.add_parser("retry-order", help="re-queue an order parked in needs_review")
    r.add_argument("order_id")
    ing = sub.add_parser("ingest-order", help="feed an order JSON file through the router (testing)")
    ing.add_argument("path")

    args = p.parse_args(argv)
    s = load_settings(args.env_file)
    setup_logging(s)

    if args.cmd == "price-preview":
        _print(preview(args.cost, args.shipping, s))
        return 0
    if args.cmd == "check":
        problems = validate_for_live(s)
        _print({"dry_run": s.dry_run, "payments": s.enable_supplier_payments and not s.dry_run,
                "supplier": s.supplier, "storefront": s.storefront, "problems": problems})
        return 1 if problems else 0

    if args.cmd in ("init-db", "status", "retry-order"):
        return _db_command(args, s)

    app = build_app(s)
    try:
        if args.cmd == "import":
            _banner(app)
            _print(app.sourcing.run(args.keyword, args.limit))
        elif args.cmd == "sync-inventory":
            _banner(app)
            _print(app.inventory.run(force=args.force))
        elif args.cmd == "route-orders":
            _banner(app)
            _print(app.router.process())
        elif args.cmd == "sync-tracking":
            _banner(app)
            _print(app.tracking.run())
        elif args.cmd == "ingest-order":
            with open(args.path, encoding="utf-8") as fh:
                payload = json.load(fh)
            print("inserted" if app.router.ingest(payload) else "already present")
            app.router.process_one(str(payload["id"]))
            _print(app.db.order(str(payload["id"])))
        elif args.cmd in ("serve", "worker", "run"):
            _banner(app)
            problems = [] if s.dry_run else validate_for_live(s)
            if problems:
                log.error("refusing to start LIVE with config problems: %s", problems)
                return 2
            sched = build_scheduler(app)
            sched.install_signal_handlers()
            wh = server = None
            if args.cmd in ("serve", "run"):
                wh, server, _ = start_webhook(app)
            try:
                if args.cmd == "serve":
                    sched.stop_event.wait()
                else:
                    sched.run_forever()
            finally:
                if server:
                    server.shutdown()
                if wh:
                    wh.stop_worker()
    finally:
        app.close()
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
