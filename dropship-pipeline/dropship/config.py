"""Typed configuration loaded from environment variables (and an optional .env file).

Every safety-relevant switch defaults to the *safe* value: DRY_RUN is on, supplier
payments are off, spend caps are small. You have to opt in to spending money.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path


def load_dotenv(path: str | os.PathLike[str] = ".env") -> None:
    """Minimal .env loader (no dependency). Real environment variables win."""
    p = Path(path)
    if not p.is_file():
        return
    for raw in p.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip().removeprefix("export ").strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        else:
            value = value.split(" #", 1)[0].strip()
        os.environ.setdefault(key, value)


def _bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    if v is None or v == "":
        return default
    return v.strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int) -> int:
    v = os.environ.get(name, "")
    return int(v) if v.strip() else default


def _float(name: str, default: float) -> float:
    v = os.environ.get(name, "")
    return float(v) if v.strip() else default


def _dec(name: str, default: str) -> Decimal:
    v = os.environ.get(name, "")
    return Decimal(v.strip() if v.strip() else default)


def _str(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _list(name: str, default: str = "") -> list[str]:
    return [x.strip() for x in _str(name, default).split(",") if x.strip()]


DEFAULT_TIERS = (
    '[{"max_cost": 5, "multiplier": 3.0},'
    ' {"max_cost": 20, "multiplier": 2.5},'
    ' {"max_cost": 60, "multiplier": 2.0},'
    ' {"max_cost": null, "multiplier": 1.6}]'
)


@dataclass(frozen=True)
class PricingConfig:
    tiers: list[dict] = field(default_factory=lambda: json.loads(DEFAULT_TIERS))
    fixed_markup: Decimal = Decimal("0")
    include_shipping_in_cost: bool = True
    min_profit: Decimal = Decimal("5.00")
    min_margin_pct: Decimal = Decimal("25")
    charm_ending: str = "0.99"  # "" disables psychological rounding
    compare_at_multiplier: Decimal = Decimal("1.4")  # 0 disables compare-at price
    currency_rate: Decimal = Decimal("1")  # supplier currency -> store currency


@dataclass(frozen=True)
class Settings:
    # --- runtime / safety ---
    dry_run: bool
    enable_supplier_payments: bool
    max_order_cost: Decimal
    daily_spend_cap: Decimal
    allowed_countries: list[str]
    require_paid_orders: bool
    log_level: str
    log_file: str
    database_url: str

    # --- storefront ---
    storefront: str
    shopify_shop: str
    shopify_access_token: str
    shopify_api_version: str
    shopify_webhook_secret: str
    shopify_location_id: str
    shopify_notify_customer: bool
    shopify_rate_per_sec: float
    publish_status: str  # ACTIVE or DRAFT for newly imported products

    # --- supplier ---
    supplier: str
    cj_api_key: str
    cj_base_url: str
    cj_logistic_name: str
    cj_from_country: str
    supplier_rate_per_sec: float
    sku_prefix: str

    # --- sourcing ---
    niche_keywords: list[str]
    import_per_keyword: int
    min_supplier_stock: int
    max_images: int

    # --- inventory sync ---
    stock_buffer: int
    out_of_stock_threshold: int
    cost_change_alert_pct: Decimal
    auto_reprice: bool
    auto_pause_oos: bool

    # --- schedules (seconds) ---
    inventory_interval: int
    order_interval: int
    tracking_interval: int
    sourcing_interval: int  # 0 = disabled in the worker loop
    max_order_attempts: int
    tracking_stale_days: int

    # --- webhook server ---
    webhook_host: str
    webhook_port: int

    # --- email / alerts ---
    email_mode: str  # shopify | smtp | both | none
    smtp_host: str
    smtp_port: int
    smtp_user: str
    smtp_password: str
    smtp_use_tls: bool
    email_from: str
    store_name: str
    alert_webhook_url: str
    alert_email: str
    alert_cooldown_sec: int

    pricing: PricingConfig

    @property
    def sqlite_path(self) -> str | None:
        if self.database_url.startswith("sqlite:///"):
            return self.database_url.removeprefix("sqlite:///")
        return None


def load_settings(env_file: str | None = ".env") -> Settings:
    if env_file:
        load_dotenv(env_file)
    pricing = PricingConfig(
        tiers=json.loads(_str("PRICING_TIERS", DEFAULT_TIERS)),
        fixed_markup=_dec("PRICING_FIXED_MARKUP", "0"),
        include_shipping_in_cost=_bool("PRICING_INCLUDE_SHIPPING", True),
        min_profit=_dec("PRICING_MIN_PROFIT", "5.00"),
        min_margin_pct=_dec("PRICING_MIN_MARGIN_PCT", "25"),
        charm_ending=_str("PRICING_CHARM_ENDING", "0.99"),
        compare_at_multiplier=_dec("PRICING_COMPARE_AT_MULTIPLIER", "1.4"),
        currency_rate=_dec("PRICING_CURRENCY_RATE", "1"),
    )
    return Settings(
        dry_run=_bool("DRY_RUN", True),
        enable_supplier_payments=_bool("ENABLE_SUPPLIER_PAYMENTS", False),
        max_order_cost=_dec("MAX_ORDER_COST", "75"),
        daily_spend_cap=_dec("DAILY_SPEND_CAP", "300"),
        allowed_countries=[c.upper() for c in _list("ALLOWED_COUNTRIES", "US,CA,GB,AU")],
        require_paid_orders=_bool("REQUIRE_PAID_ORDERS", True),
        log_level=_str("LOG_LEVEL", "INFO"),
        log_file=_str("LOG_FILE", "data/dropship.log"),
        database_url=_str("DATABASE_URL", "sqlite:///data/dropship.db"),
        storefront=_str("STOREFRONT", "shopify").lower(),
        shopify_shop=_str("SHOPIFY_SHOP"),
        shopify_access_token=_str("SHOPIFY_ACCESS_TOKEN"),
        shopify_api_version=_str("SHOPIFY_API_VERSION", "2026-10"),
        shopify_webhook_secret=_str("SHOPIFY_WEBHOOK_SECRET"),
        shopify_location_id=_str("SHOPIFY_LOCATION_ID"),
        shopify_notify_customer=_bool("SHOPIFY_NOTIFY_CUSTOMER", True),
        shopify_rate_per_sec=_float("SHOPIFY_RATE_PER_SEC", 2.0),
        publish_status=_str("PUBLISH_STATUS", "DRAFT").upper(),
        supplier=_str("SUPPLIER", "cj").lower(),
        cj_api_key=_str("CJ_API_KEY"),
        cj_base_url=_str("CJ_BASE_URL", "https://developers.cjdropshipping.com/api2.0/v1"),
        cj_logistic_name=_str("CJ_LOGISTIC_NAME", "CJPacket Ordinary"),
        cj_from_country=_str("CJ_FROM_COUNTRY", "CN"),
        supplier_rate_per_sec=_float("SUPPLIER_RATE_PER_SEC", 1.0),
        sku_prefix=_str("SKU_PREFIX", "DS"),
        niche_keywords=_list("NICHE_KEYWORDS", "pet hair remover,led desk lamp"),
        import_per_keyword=_int("IMPORT_PER_KEYWORD", 5),
        min_supplier_stock=_int("MIN_SUPPLIER_STOCK", 50),
        max_images=_int("MAX_IMAGES", 8),
        stock_buffer=_int("STOCK_BUFFER", 5),
        out_of_stock_threshold=_int("OUT_OF_STOCK_THRESHOLD", 3),
        cost_change_alert_pct=_dec("COST_CHANGE_ALERT_PCT", "10"),
        auto_reprice=_bool("AUTO_REPRICE", True),
        auto_pause_oos=_bool("AUTO_PAUSE_OOS", True),
        inventory_interval=_int("INVENTORY_SYNC_INTERVAL", 900),
        order_interval=_int("ORDER_ROUTER_INTERVAL", 60),
        tracking_interval=_int("TRACKING_SYNC_INTERVAL", 1800),
        sourcing_interval=_int("SOURCING_INTERVAL", 0),
        max_order_attempts=_int("MAX_ORDER_ATTEMPTS", 5),
        tracking_stale_days=_int("TRACKING_STALE_DAYS", 12),
        webhook_host=_str("WEBHOOK_HOST", "127.0.0.1"),
        webhook_port=_int("WEBHOOK_PORT", 8080),
        email_mode=_str("EMAIL_MODE", "shopify").lower(),
        smtp_host=_str("SMTP_HOST"),
        smtp_port=_int("SMTP_PORT", 587),
        smtp_user=_str("SMTP_USER"),
        smtp_password=_str("SMTP_PASSWORD"),
        smtp_use_tls=_bool("SMTP_USE_TLS", True),
        email_from=_str("EMAIL_FROM"),
        store_name=_str("STORE_NAME", "Our Store"),
        alert_webhook_url=_str("ALERT_WEBHOOK_URL"),
        alert_email=_str("ALERT_EMAIL"),
        alert_cooldown_sec=_int("ALERT_COOLDOWN_SEC", 900),
        pricing=pricing,
    )


def validate_for_live(s: Settings) -> list[str]:
    """Return a list of problems that would break a non-mock run."""
    problems: list[str] = []
    if s.storefront == "shopify":
        for name, val in [
            ("SHOPIFY_SHOP", s.shopify_shop),
            ("SHOPIFY_ACCESS_TOKEN", s.shopify_access_token),
            ("SHOPIFY_WEBHOOK_SECRET", s.shopify_webhook_secret),
            ("SHOPIFY_LOCATION_ID", s.shopify_location_id),
        ]:
            if not val:
                problems.append(f"{name} is not set")
    if s.supplier == "cj" and not s.cj_api_key:
        problems.append("CJ_API_KEY is not set")
    if s.email_mode in {"smtp", "both"} and not (s.smtp_host and s.email_from):
        problems.append("EMAIL_MODE uses smtp but SMTP_HOST / EMAIL_FROM are not set")
    if s.enable_supplier_payments and s.dry_run:
        problems.append("ENABLE_SUPPLIER_PAYMENTS has no effect while DRY_RUN=true")
    return problems
