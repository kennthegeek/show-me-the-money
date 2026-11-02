# Dropship Pipeline

Automates the four repetitive parts of a Shopify dropshipping store backed by a wholesale
supplier API (CJ Dropshipping included; others plug in behind one interface):

| Layer | What it does | Module |
|---|---|---|
| 1. Sourcing & import | Keyword → supplier catalog → filter (stock, images) → clean title/description → markup pricing → Shopify listing (as DRAFT by default) | `dropship/sourcing.py`, `pricing.py` |
| 2. Inventory & price sync | Polls supplier stock and wholesale cost → pushes buffered stock, re-prices, drafts sold-out products and re-activates them on restock | `dropship/inventory.py` |
| 3. Order routing | Signed Shopify webhook → validate → place supplier order → pay from balance (only if you allow it) | `dropship/webhook.py`, `orders.py` |
| 4. Tracking & audit | Polls the supplier for tracking → creates the Shopify fulfillment → emails the customer → logs every state change | `dropship/tracking.py`, `db.py` |

The only runtime dependency is Python 3.11+ and `httpx`. SQLite is the default database, and PostgreSQL is optional.

---

## Architecture

```
                 ┌──────────────── Shopify ────────────────┐
  orders/create  │                                          │  productSet / inventorySetQuantities
  orders/paid ───┼──► webhook.py (HMAC, dedupe) ──┐          │  productVariantsBulkUpdate / fulfillmentCreate
  orders/cancel  │                                ▼          ▲
                 │                     ┌─────── SQLite / Postgres ───────┐
                 │                     │ products · orders · spend_ledger│
                 │                     │ audit_log · sync_runs · events  │
                 │                     └─────────────▲───────────────────┘
                 │                                   │
   scheduler.py ─┼─ every 60s   orders.py   ── create_order / pay_order ──►┐
                 │  every 15m   inventory.py ── stock / cost ─────────────►│ CJ Dropshipping
                 │  every 30m   tracking.py  ── order detail / tracking ──►│ (suppliers/cj.py)
                 │  manual      sourcing.py  ── search / product / freight►┘
                 └──────────────────────────────────────────┘
```

**Order state machine** (each transition is written to `audit_log`):

```
received ─► validated ─► submitting ─► submitted ─► paying ─► paid ─► shipped ─► fulfilled
   │            │                          │
   ├─► skipped  └─► needs_review ◄─────────┘ (failed guard, retries used up, or stuck mid-call)
   └─► cancelled
```

### Reliability features
- **HTTP layer** (`http.py`): a token-bucket rate limiter per API, plus exponential backoff with jitter on network errors, 429 and 5xx. It honours `Retry-After`, and after a 429 it empties the rate-limit bucket so other threads slow down too.
- **Shopify GraphQL cost throttling**: when Shopify returns `THROTTLED`, the client waits based on `throttleStatus.restoreRate`.
- **Calls that spend money are never retried blindly.** `create_order` and `pay_order` are sent once. Each order is placed with a stable `orderNumber` (`SHOP-<shopify id>`), so if a retry repeats it, the supplier rejects it as a duplicate instead of shipping twice.
- **Atomic state claims** (`submitting`, `paying`) stop two processes from submitting the same order. If a worker crashes mid-call, the order goes to `needs_review` after 15 minutes, because nobody knows whether the call went through.
- **The webhook stores the order first, replies within Shopify's 5-second limit, then routes it on a background thread.** The 60-second order loop is the safety net. Duplicate deliveries are dropped by event id.
- **A failed supplier lookup never sets stock to zero.** If a stock request fails, those rows are skipped for that round.
- **Products you draft by hand stay drafted.** The pipeline only re-activates products that it paused itself.
- **Tracking runs in two persisted steps** (tracking number saved, then fulfillment created). A Shopify or email failure therefore never loses a tracking number or emails the customer twice.
- **Secrets are redacted from logs.** Log files rotate at 10 MB, keeping 5 files.

---

## Quick start: local, offline, no API keys

```bash
cd dropship-pipeline
python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
make test        # 36 tests: pricing, retry/backoff, connectors, full order lifecycle, webhook
make demo        # imports mock products, routes examples/order.json to "paid", prints status
```

`make demo` uses `SUPPLIER=mock STOREFRONT=mock`, so it makes no network calls and spends nothing.

---

## Setup for real stores

### 1. Install

```bash
cd dropship-pipeline
python3 -m venv .venv
.venv/bin/pip install -e .            # add ".[postgres]" for PostgreSQL
cp .env.example .env && chmod 600 .env
```

### 2. Create the Shopify custom app
1. In Shopify admin, go to **Settings → Apps and sales channels → Develop apps → Create an app**.
2. Under Admin API scopes, enable: `write_products`, `write_inventory`, `read_locations`, `read_orders`, `write_merchant_managed_fulfillment_orders`, `write_fulfillments`.
3. Install the app. Copy the **Admin API access token** into `SHOPIFY_ACCESS_TOKEN` and the **API secret key** into `SHOPIFY_WEBHOOK_SECRET`.
4. Find the location id: open **Settings → Locations**, click the location, and copy the number at the end of the URL into `SHOPIFY_LOCATION_ID`.
   Shopify must track inventory at that location.

### 3. Get the CJ API key
In the CJ dashboard, go to **Authorization → API** and generate a key. Put it in `CJ_API_KEY`.
For automatic payment, pre-fund your CJ wallet balance. The pipeline pays with `payBalance` and never charges a card itself.

> CJ revises its API from time to time. The connector parses responses defensively: a renamed field
> raises an error and does not silently zero your stock. Before going live, compare the endpoints in
> `dropship/suppliers/cj.py` with https://developers.cjdropshipping.com/. The connector uses
> `getAccessToken`, `product/list`, `product/query`, `product/stock/queryByVid`, `product/variant/queryByVid`,
> `logistic/freightCalculate`, `shopping/order/createOrderV2`, `shopping/pay/payBalance` and
> `shopping/order/getOrderDetail`.

### 4. Check config and initialise

```bash
.venv/bin/dropship check          # lists missing/contradictory settings, exits non-zero on problems
.venv/bin/dropship init-db
.venv/bin/dropship price-preview --cost 4.20 --shipping 3.50
# {"landed_cost": "7.70", "price": "19.99", "compare_at": "27.99", "profit": "12.29", "margin_pct": "61.5"}
```

### 5. Expose the webhook and register it
The listener speaks plain HTTP on `127.0.0.1:8080`. Put HTTPS in front of it with one of these:

```bash
cloudflared tunnel --url http://localhost:8080          # quickest
# or Caddy:  shop-hooks.example.com { reverse_proxy 127.0.0.1:8080 }
```

Then, in Shopify admin, go to **Settings → Notifications → Webhooks** and create three webhooks. Use JSON format and the same API version as `SHOPIFY_API_VERSION`.

| Event | URL |
|---|---|
| Order creation | `https://<your-host>/webhooks/shopify` |
| Order payment | `https://<your-host>/webhooks/shopify` |
| Order cancellation | `https://<your-host>/webhooks/shopify` |

Webhooks created in admin are signed with a key shown on that page. If you register them there instead of through the app, put that key in `SHOPIFY_WEBHOOK_SECRET`.
To check the endpoint is up: `curl https://<your-host>/healthz`.

---

## Running the worker loops safely: a staged rollout

Go through the stages in order. Each stage is one `.env` change.

| Stage | `.env` | What happens | Move on when |
|---|---|---|---|
| **0. Dry run** | `DRY_RUN=true` (default) | Reads live data. Logs `[DRY RUN] would import / would submit / would fulfill`. Writes nothing anywhere. | The logged prices, SKUs and order mappings look right |
| **1. Catalog only** | `DRY_RUN=false`, `PUBLISH_STATUS=DRAFT`, `ENABLE_SUPPLIER_PAYMENTS=false` | Imports products as drafts and syncs stock and prices. Orders are placed at CJ **unpaid**, and you get an alert to pay each one by hand. | You've reviewed the drafts and published them, and a few orders have gone through cleanly after you paid them manually |
| **2. Auto-pay, small caps** | `ENABLE_SUPPLIER_PAYMENTS=true`, `MAX_ORDER_COST=40`, `DAILY_SPEND_CAP=100` | Orders are paid from your CJ balance automatically, within the caps | A week with no surprises in `needs_review` |
| **3. Steady state** | Raise the caps to fit your volume | Fully automatic | n/a |

Commands:

```bash
# one-shot passes (good for cron or debugging)
dropship import -k "pet hair remover" -k "led desk lamp" --limit 3
dropship sync-inventory            # add --force to re-push every stock level
dropship route-orders
dropship sync-tracking
dropship status                    # order counts by state, today's spend, last 10 job runs

# long-running (recommended): webhook + all loops in ONE process
dropship run
# or split them: `dropship serve` (webhook only) + `dropship worker` (loops only).
# This is safe because state claims are atomic in the DB, but one process is simpler.
```

**Guards on every order, checked before any supplier call.** An order goes to `needs_review` and you get an alert if any of these fail:
- the order is paid (`REQUIRE_PAID_ORDERS`), not cancelled, and not a Shopify test order
- every routed SKU (`DS-CJ-<vid>`) is mapped in `products`
- the shipping address has a name, address1, city, zip and country, and the country is in `ALLOWED_COUNTRIES`
- the supplier cost is less than the revenue for those lines, after discounts
- the cost is at most `MAX_ORDER_COST`
- today's ledger plus this order is at most `DAILY_SPEND_CAP`

The cap is checked again with the supplier's real total just before paying.

Line items whose SKU isn't one of yours (for example, hand-made products) are ignored. An order with no such lines becomes `skipped`.

**Handling `needs_review`:** run `dropship status`, read `last_error` for the order (in the DB or the alert), fix the cause, then run `dropship retry-order <shopify_order_id>`.
If an order was stuck in `submitting` or `paying`, **check the CJ dashboard first**: the call may have gone through.

**Stopping:** Ctrl-C or SIGTERM lets the job that's running finish, then exits. Nothing is left half-written.

### Run it continuously

**Docker (recommended):**
```bash
cp .env.example .env    # fill in
docker compose up -d --build
docker compose logs -f dropship
docker compose exec dropship dropship status
```
The SQLite DB and logs persist in `./data`. Port 8080 is published on localhost only. Point your tunnel or reverse proxy at it.

**systemd (VM / VPS):**
```ini
# /etc/systemd/system/dropship.service
[Unit]
Description=Dropship pipeline
After=network-online.target

[Service]
WorkingDirectory=/opt/dropship-pipeline
ExecStart=/opt/dropship-pipeline/.venv/bin/dropship run
Restart=on-failure
RestartSec=10
User=dropship
KillSignal=SIGTERM
TimeoutStopSec=120

[Install]
WantedBy=multi-user.target
```

**cron instead of the built-in loops** (if you only want periodic passes plus `dropship serve` for webhooks):
```cron
*/2  * * * *  cd /opt/dropship-pipeline && .venv/bin/dropship route-orders   >> data/cron.log 2>&1
*/15 * * * *  cd /opt/dropship-pipeline && .venv/bin/dropship sync-inventory >> data/cron.log 2>&1
*/30 * * * *  cd /opt/dropship-pipeline && .venv/bin/dropship sync-tracking  >> data/cron.log 2>&1
```

---

## Pricing rules

```
landed  = (supplier_cost + shipping*) × PRICING_CURRENCY_RATE        *if PRICING_INCLUDE_SHIPPING
price   = max( landed × tier_multiplier + PRICING_FIXED_MARKUP,
               landed + PRICING_MIN_PROFIT,
               landed / (1 − PRICING_MIN_MARGIN_PCT/100) )
        → rounded UP to PRICING_CHARM_ENDING (e.g. 19.25 → 19.99)
compare_at = price × PRICING_COMPARE_AT_MULTIPLIER (charm-rounded)
```
All of this uses `Decimal` math. Change the tiers in `PRICING_TIERS` (JSON), and use `dropship price-preview` to try them out.

## Alerts

Set `ALERT_WEBHOOK_URL` (a Slack or Discord incoming webhook), `ALERT_EMAIL`, or both. Each alert key is sent at most once per `ALERT_COOLDOWN_SEC`.

You get alerts for:
- failed jobs, and when they recover
- orders that need review or need manual payment
- a cancelled Shopify order whose supplier order is already placed
- cost swings of at least `COST_CHANGE_ALERT_PCT`
- items selling at a loss while `AUTO_REPRICE=false`
- products paused because they're out of stock
- variants the supplier has delisted
- orders with no tracking after `TRACKING_STALE_DAYS`
- failed fulfillments or tracking emails

## Database

| Table | Purpose |
|---|---|
| `products` | Supplier variant ↔ Shopify product/variant/inventory item, cost, price, stock, `paused_by_sync` |
| `orders` | One row per Shopify order: state, raw payload, supplier order id, cost, revenue, tracking, attempts, last error |
| `spend_ledger` | Every supplier payment, used to enforce `DAILY_SPEND_CAP` |
| `audit_log` | Append-only history of every state change, import, price change and email |
| `sync_runs` | Each job run with its outcome and summary |
| `webhook_events` | Webhook event ids already seen (dedupe) |

```bash
sqlite3 data/dropship.db "SELECT created_at, event, detail FROM audit_log WHERE entity_id='<order id>' ORDER BY id"
```

## Adding another supplier or storefront

Implement `dropship/suppliers/base.py::Supplier` (Zendrop, AliExpress DS, Spocket, …) or
`dropship/storefronts/base.py::Storefront` (WooCommerce, BigCommerce, …), then register it in
`dropship/app.py::build_supplier` / `build_storefront`. The mock versions in each package are short reference implementations.

## Project layout

```
dropship-pipeline/
├── dropship/
│   ├── cli.py            # all commands
│   ├── app.py            # wiring + logging
│   ├── config.py         # typed settings from .env (safe defaults)
│   ├── db.py             # schema, order state machine, ledger, audit
│   ├── http.py           # rate limiter + retry/backoff client
│   ├── pricing.py        # markup engine
│   ├── sourcing.py       # layer 1
│   ├── inventory.py      # layer 2
│   ├── orders.py         # layer 3 (routing + guards)
│   ├── webhook.py        # layer 3 (HMAC listener)
│   ├── tracking.py       # layer 4
│   ├── notify.py         # SMTP + Slack/Discord alerts
│   ├── scheduler.py      # interval loops, backoff, graceful shutdown
│   ├── suppliers/        # base, cj, mock
│   └── storefronts/      # base, shopify, mock
├── tests/                # 36 tests, all offline
├── examples/order.json   # sample orders/create payload
├── .env.example
├── Dockerfile · docker-compose.yml · Makefile · pyproject.toml
```

## Before you sell

- **Shipping times.** CJPacket from CN usually takes 7–20 days to the US. Show realistic delivery estimates in your store. Both the FTC Mail Order Rule and Shopify's policies expect this.
- **Products.** Imports land as DRAFT so a person checks claims, images and restricted categories (electronics certification, cosmetics, kids' items) before anything goes live.
- **Customer data.** The `orders` table stores names, addresses and emails. Keep `data/` out of git (it's in `.gitignore`), restrict file permissions, and delete old rows according to your privacy policy.
