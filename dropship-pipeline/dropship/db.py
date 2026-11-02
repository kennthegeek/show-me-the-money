"""Persistence: product mappings, order state machine, spend ledger and audit log.

SQLite is the default (zero setup, WAL mode, safe across the worker and webhook
processes). PostgreSQL works too when `psycopg` is installed and DATABASE_URL starts
with postgres:// — the SQL below is written to run unchanged on both.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any


def utcnow() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


# Order lifecycle. Transitions only move forward; failures park the order for review.
class OrderState:
    RECEIVED = "received"  # webhook stored, not yet validated
    VALIDATED = "validated"  # passed all checks, ready to submit
    SUBMITTING = "submitting"  # claimed by a worker, supplier call in flight
    SUBMITTED = "submitted"  # supplier order created, not paid
    PAYING = "paying"  # claimed by a worker, payment call in flight
    PAID = "paid"  # supplier order paid, awaiting shipment
    SHIPPED = "shipped"  # supplier gave a tracking number
    FULFILLED = "fulfilled"  # storefront fulfillment created + customer notified
    SKIPPED = "skipped"  # nothing for this supplier in the order
    NEEDS_REVIEW = "needs_review"  # validation failed or retries exhausted
    CANCELLED = "cancelled"


SCHEMA = [
    """
    CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        supplier TEXT NOT NULL,
        supplier_product_id TEXT NOT NULL,
        supplier_variant_id TEXT NOT NULL,
        sku TEXT NOT NULL UNIQUE,
        title TEXT,
        storefront_product_id TEXT,
        storefront_variant_id TEXT,
        inventory_item_id TEXT,
        cost TEXT NOT NULL,
        shipping_cost TEXT NOT NULL DEFAULT '0',
        price TEXT NOT NULL,
        stock INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        paused_by_sync INTEGER NOT NULL DEFAULT 0,
        last_synced_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (supplier, supplier_variant_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        storefront_order_id TEXT NOT NULL UNIQUE,
        order_name TEXT,
        customer_email TEXT,
        customer_name TEXT,
        state TEXT NOT NULL,
        payload TEXT NOT NULL,
        supplier_order_id TEXT,
        supplier_cost TEXT,
        revenue TEXT,
        tracking_number TEXT,
        tracking_url TEXT,
        carrier TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS webhook_events (
        event_id TEXT PRIMARY KEY,
        topic TEXT,
        received_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS spend_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        storefront_order_id TEXT NOT NULL,
        amount TEXT NOT NULL,
        day TEXT NOT NULL,
        created_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity TEXT NOT NULL,
        entity_id TEXT,
        event TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        ok INTEGER,
        summary TEXT
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_orders_state ON orders (state)",
    "CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log (entity, entity_id)",
    "CREATE INDEX IF NOT EXISTS idx_spend_day ON spend_ledger (day)",
]


class Database:
    def __init__(self, url: str):
        self.url = url
        self._lock = threading.RLock()
        if url.startswith("sqlite:///"):
            path = url.removeprefix("sqlite:///")
            if path != ":memory:":
                Path(path).parent.mkdir(parents=True, exist_ok=True)
            self._conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
            self._conn.row_factory = sqlite3.Row
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA busy_timeout=10000")
            self._conn.execute("PRAGMA foreign_keys=ON")
            self.dialect = "sqlite"
        elif url.startswith(("postgres://", "postgresql://")):
            try:
                import psycopg
                from psycopg.rows import dict_row
            except ImportError as exc:  # pragma: no cover - optional dep
                raise RuntimeError("Install psycopg[binary] to use PostgreSQL") from exc
            self._conn = psycopg.connect(url, autocommit=True, row_factory=dict_row)
            self.dialect = "postgres"
        else:
            raise ValueError(f"Unsupported DATABASE_URL: {url}")

    # -- low level ------------------------------------------------------------
    def _sql(self, sql: str) -> str:
        if self.dialect == "postgres":
            sql = sql.replace("?", "%s")
            sql = sql.replace("INTEGER PRIMARY KEY AUTOINCREMENT", "BIGSERIAL PRIMARY KEY")
        return sql

    def execute(self, sql: str, params: tuple = ()) -> Any:
        with self._lock:
            return self._conn.execute(self._sql(sql), params)

    def query(self, sql: str, params: tuple = ()) -> list[dict]:
        with self._lock:
            cur = self._conn.execute(self._sql(sql), params)
            return [dict(r) for r in cur.fetchall()]

    def one(self, sql: str, params: tuple = ()) -> dict | None:
        rows = self.query(sql, params)
        return rows[0] if rows else None

    @contextmanager
    def transaction(self) -> Iterator[None]:
        with self._lock:
            if self.dialect == "sqlite":
                self._conn.execute("BEGIN IMMEDIATE")
                try:
                    yield
                    self._conn.execute("COMMIT")
                except BaseException:
                    self._conn.execute("ROLLBACK")
                    raise
            else:  # pragma: no cover
                with self._conn.transaction():
                    yield

    def init_schema(self) -> None:
        for stmt in SCHEMA:
            self.execute(stmt)

    def close(self) -> None:
        self._conn.close()

    # -- audit ---------------------------------------------------------------
    def audit(self, entity: str, entity_id: str | None, event: str, detail: Any = None) -> None:
        text = detail if isinstance(detail, str) or detail is None else json.dumps(detail, default=str)
        self.execute(
            "INSERT INTO audit_log (entity, entity_id, event, detail, created_at) VALUES (?, ?, ?, ?, ?)",
            (entity, entity_id, event, text, utcnow()),
        )

    # -- sync runs ----------------------------------------------------------------
    def start_run(self, job: str) -> int:
        cur = self.execute(
            "INSERT INTO sync_runs (job, started_at) VALUES (?, ?) RETURNING id", (job, utcnow())
        )
        return int(dict(cur.fetchone())["id"])

    def finish_run(self, run_id: int, ok: bool, summary: Any) -> None:
        self.execute(
            "UPDATE sync_runs SET finished_at = ?, ok = ?, summary = ? WHERE id = ?",
            (utcnow(), 1 if ok else 0, json.dumps(summary, default=str), run_id),
        )

    # -- products ---------------------------------------------------------------
    def upsert_product(self, row: dict) -> None:
        now = utcnow()
        self.execute(
            """
            INSERT INTO products (supplier, supplier_product_id, supplier_variant_id, sku, title,
                storefront_product_id, storefront_variant_id, inventory_item_id, cost, shipping_cost,
                price, stock, status, paused_by_sync, last_synced_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
            ON CONFLICT (supplier, supplier_variant_id) DO UPDATE SET
                title = excluded.title,
                storefront_product_id = excluded.storefront_product_id,
                storefront_variant_id = excluded.storefront_variant_id,
                inventory_item_id = excluded.inventory_item_id,
                cost = excluded.cost, shipping_cost = excluded.shipping_cost,
                price = excluded.price, stock = excluded.stock,
                status = excluded.status, last_synced_at = excluded.last_synced_at
            """,
            (
                row["supplier"], row["supplier_product_id"], row["supplier_variant_id"], row["sku"],
                row.get("title"), row.get("storefront_product_id"), row.get("storefront_variant_id"),
                row.get("inventory_item_id"), str(row["cost"]), str(row.get("shipping_cost", "0")),
                str(row["price"]), int(row.get("stock", 0)), row.get("status", "active"), now, now,
            ),
        )

    def product_by_sku(self, sku: str) -> dict | None:
        return self.one("SELECT * FROM products WHERE sku = ?", (sku,))

    def products_for_supplier(self, supplier: str) -> list[dict]:
        return self.query(
            "SELECT * FROM products WHERE supplier = ? AND status != 'archived' ORDER BY id", (supplier,)
        )

    def known_supplier_products(self, supplier: str) -> set[str]:
        rows = self.query("SELECT DISTINCT supplier_product_id FROM products WHERE supplier = ?", (supplier,))
        return {r["supplier_product_id"] for r in rows}

    def update_product(self, product_id: int, **fields: Any) -> None:
        if not fields:
            return
        fields["last_synced_at"] = utcnow()
        cols = ", ".join(f"{k} = ?" for k in fields)
        vals = tuple(str(v) if isinstance(v, Decimal) else v for v in fields.values())
        self.execute(f"UPDATE products SET {cols} WHERE id = ?", (*vals, product_id))

    # -- webhook idempotency --------------------------------------------------------
    def claim_webhook_event(self, event_id: str, topic: str) -> bool:
        """Return True the first time an event id is seen, False for duplicates."""
        try:
            self.execute(
                "INSERT INTO webhook_events (event_id, topic, received_at) VALUES (?, ?, ?)",
                (event_id, topic, utcnow()),
            )
            return True
        except Exception as exc:  # sqlite3.IntegrityError / psycopg UniqueViolation
            if "UNIQUE" in str(exc).upper() or "duplicate" in str(exc).lower():
                return False
            raise

    # -- orders ---------------------------------------------------------------
    def insert_order(self, order_id: str, name: str, email: str, customer: str, payload: dict) -> bool:
        now = utcnow()
        cur = self.execute(
            """
            INSERT INTO orders (storefront_order_id, order_name, customer_email, customer_name, state,
                payload, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (storefront_order_id) DO NOTHING
            """,
            (order_id, name, email, customer, OrderState.RECEIVED, json.dumps(payload), now, now),
        )
        inserted = (cur.rowcount or 0) > 0
        if inserted:
            self.audit("order", order_id, "received", {"name": name})
        return inserted

    def order(self, order_id: str) -> dict | None:
        return self.one("SELECT * FROM orders WHERE storefront_order_id = ?", (order_id,))

    def orders_in(self, *states: str, limit: int = 100) -> list[dict]:
        marks = ", ".join("?" for _ in states)
        return self.query(
            f"SELECT * FROM orders WHERE state IN ({marks}) ORDER BY id LIMIT ?", (*states, limit)
        )

    def update_order(self, order_id: str, *, state: str | None = None, **fields: Any) -> None:
        if state:
            fields["state"] = state
        fields["updated_at"] = utcnow()
        cols = ", ".join(f"{k} = ?" for k in fields)
        vals = tuple(str(v) if isinstance(v, Decimal) else v for v in fields.values())
        self.execute(f"UPDATE orders SET {cols} WHERE storefront_order_id = ?", (*vals, order_id))
        if state:
            self.audit("order", order_id, f"state:{state}", {k: v for k, v in fields.items() if k != "updated_at"})

    def claim_state(self, order_id: str, expected: str, new: str) -> bool:
        """Atomic compare-and-set on order state; prevents two processes double-submitting."""
        cur = self.execute(
            "UPDATE orders SET state = ?, updated_at = ? WHERE storefront_order_id = ? AND state = ?",
            (new, utcnow(), order_id, expected),
        )
        return (cur.rowcount or 0) == 1

    def bump_attempt(self, order_id: str, error: str) -> int:
        self.execute(
            "UPDATE orders SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE storefront_order_id = ?",
            (error[:2000], utcnow(), order_id),
        )
        row = self.order(order_id)
        return int(row["attempts"]) if row else 0

    # -- spend ledger -------------------------------------------------------------
    def spent_today(self) -> Decimal:
        day = utcnow()[:10]
        rows = self.query("SELECT amount FROM spend_ledger WHERE day = ?", (day,))
        return sum((Decimal(r["amount"]) for r in rows), Decimal("0"))

    def record_spend(self, order_id: str, amount: Decimal) -> None:
        now = utcnow()
        self.execute(
            "INSERT INTO spend_ledger (storefront_order_id, amount, day, created_at) VALUES (?, ?, ?, ?)",
            (order_id, str(amount), now[:10], now),
        )

    # -- reporting -------------------------------------------------------------
    def status_summary(self) -> dict:
        orders = self.query("SELECT state, COUNT(*) AS n FROM orders GROUP BY state")
        products = self.query("SELECT status, COUNT(*) AS n FROM products GROUP BY status")
        runs = self.query(
            "SELECT job, started_at, finished_at, ok, summary FROM sync_runs ORDER BY id DESC LIMIT 10"
        )
        return {
            "orders": {r["state"]: r["n"] for r in orders},
            "products": {r["status"]: r["n"] for r in products},
            "spent_today": str(self.spent_today()),
            "recent_runs": runs,
        }
