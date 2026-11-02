"""CJ Dropshipping API v2 connector.

Docs: https://developers.cjdropshipping.com/  (verify endpoint/field names against the
current docs before going live — CJ revises them periodically; every response is parsed
defensively so a renamed field fails loudly instead of silently zeroing stock).
"""

from __future__ import annotations

import json
import logging
import threading
import time
from decimal import Decimal
from typing import Any

import httpx

from ..http import ApiError, ResilientClient
from ..models import (
    OrderLine,
    ShippingAddress,
    StockLevel,
    SupplierOrderResult,
    SupplierProduct,
    SupplierVariant,
    TrackingInfo,
)
from .base import Supplier, tracking_url

log = logging.getLogger(__name__)

TOKEN_TTL_SEC = 14 * 24 * 3600  # CJ access tokens last ~15 days; refresh a day early


class CJSupplier(Supplier):
    name = "cj"

    def __init__(
        self,
        api_key: str,
        base_url: str,
        *,
        logistic_name: str,
        from_country: str,
        rate_per_sec: float = 1.0,
        transport: httpx.BaseTransport | None = None,
        sleep=time.sleep,
    ):
        if not api_key:
            raise ValueError("CJ_API_KEY is required for the CJ supplier")
        self.api_key = api_key
        self.logistic_name = logistic_name
        self.from_country = from_country
        self.http = ResilientClient(
            base_url, rate_per_sec=rate_per_sec, name="cj", transport=transport, sleep=sleep
        )
        self._token: str | None = None
        self._token_expiry = 0.0
        self._lock = threading.Lock()

    # -- plumbing -------------------------------------------------------------
    def _access_token(self) -> str:
        with self._lock:
            if self._token and time.time() < self._token_expiry:
                return self._token
            resp = self.http.request(
                "POST", "/authentication/getAccessToken", json={"apiKey": self.api_key}
            )
            data = self._unwrap(resp.json(), "getAccessToken")
            self._token = data["accessToken"]
            self._token_expiry = time.time() + TOKEN_TTL_SEC
            return self._token

    @staticmethod
    def _unwrap(body: dict, op: str) -> Any:
        if not isinstance(body, dict):
            raise ApiError(f"cj {op}: unexpected response {body!r}")
        if body.get("result") is False or body.get("code") not in (200, None):
            msg = str(body.get("message", "unknown error"))
            retryable = "too many" in msg.lower() or "frequen" in msg.lower()
            raise ApiError(f"cj {op}: {msg}", status=body.get("code"), body=body, retryable=retryable)
        return body.get("data")

    def _call(self, method: str, path: str, *, retry: bool = True, **kw: Any) -> Any:
        for attempt in range(2):
            headers = {"CJ-Access-Token": self._access_token()}
            resp = self.http.request(method, path, headers=headers, retry=retry, **kw)
            body = resp.json()
            # Expired/invalid token -> refresh once.
            if body.get("code") in (1600001, 1600003) and attempt == 0:
                with self._lock:
                    self._token = None
                continue
            return self._unwrap(body, path)
        raise ApiError(f"cj {path}: authentication failed")

    # -- catalog --------------------------------------------------------------
    def search(self, keyword: str, limit: int) -> list[str]:
        data = self._call(
            "GET", "/product/list",
            params={"productNameEn": keyword, "pageNum": 1, "pageSize": max(1, min(limit * 2, 50))},
        ) or {}
        return [str(p["pid"]) for p in (data.get("list") or []) if p.get("pid")][: limit * 2]

    def product(self, product_id: str) -> SupplierProduct:
        d = self._call("GET", "/product/query", params={"pid": product_id}) or {}
        images = _image_list(d.get("productImageSet") or d.get("productImage"))
        variants: list[SupplierVariant] = []
        option_names = [n.strip() for n in str(d.get("productKeyEn") or "").split("-") if n.strip()]
        for v in d.get("variants") or []:
            values = [x.strip() for x in str(v.get("variantKey") or "").split("-") if x.strip()]
            names = option_names if len(option_names) == len(values) else [f"Option{i+1}" for i in range(len(values))]
            variants.append(
                SupplierVariant(
                    variant_id=str(v["vid"]),
                    sku=str(v.get("variantSku") or v["vid"]),
                    name=str(v.get("variantNameEn") or v.get("variantKey") or "Default"),
                    cost=Decimal(str(v.get("variantSellPrice") or d.get("sellPrice") or "0")),
                    stock=0,  # filled by stock() — catalog detail does not carry live stock
                    image=v.get("variantImage"),
                    options=dict(zip(names, values, strict=False)) if values else {},
                    weight_g=int(float(v["variantWeight"])) if v.get("variantWeight") else None,
                )
            )
        return SupplierProduct(
            product_id=str(d.get("pid", product_id)),
            title=str(d.get("productNameEn") or ""),
            description_html=str(d.get("description") or ""),
            images=images,
            variants=variants,
            category=str(d.get("categoryName") or ""),
        )

    def stock(self, variant_ids: list[str]) -> dict[str, StockLevel]:
        out: dict[str, StockLevel] = {}
        for vid in variant_ids:
            rows = self._call("GET", "/product/stock/queryByVid", params={"vid": vid}) or []
            if isinstance(rows, dict):
                rows = [rows]
            qty = 0
            for r in rows:
                qty += int(r.get("totalInventoryNum") or r.get("storageNum") or 0)
            variant = self._call("GET", "/product/variant/queryByVid", params={"vid": vid}) or {}
            cost = variant.get("variantSellPrice")
            if cost is None:
                raise ApiError(f"cj stock: no variantSellPrice for vid {vid}")
            out[vid] = StockLevel(variant_id=vid, stock=qty, cost=Decimal(str(cost)))
        return out

    def shipping_quote(self, variant_id: str, country_code: str) -> Decimal:
        data = self._call(
            "POST", "/logistic/freightCalculate",
            json={
                "startCountryCode": self.from_country,
                "endCountryCode": country_code,
                "products": [{"quantity": 1, "vid": variant_id}],
            },
        ) or []
        prices = [Decimal(str(o["logisticPrice"])) for o in data if o.get("logisticPrice") is not None]
        preferred = [Decimal(str(o["logisticPrice"])) for o in data if o.get("logisticName") == self.logistic_name]
        if preferred:
            return preferred[0]
        if not prices:
            raise ApiError(f"cj freight: no shipping options for {variant_id} -> {country_code}")
        return min(prices)

    # -- orders ---------------------------------------------------------------
    def create_order(self, reference: str, address: ShippingAddress, lines: list[OrderLine]) -> SupplierOrderResult:
        payload = {
            "orderNumber": reference,  # CJ rejects duplicate orderNumber -> natural idempotency key
            "shippingCountryCode": address.country_code,
            "shippingCountry": address.country,
            "shippingProvince": address.province or address.province_code,
            "shippingCity": address.city,
            "shippingAddress": address.address1,
            "shippingAddress2": address.address2,
            "shippingZip": address.zip,
            "shippingCustomerName": address.name,
            "shippingPhone": address.phone,
            "email": address.email,
            "logisticName": self.logistic_name,
            "fromCountryCode": self.from_country,
            "payType": 3,  # create only; payment is an explicit, separately-gated step
            "products": [{"vid": ln.supplier_variant_id, "quantity": ln.quantity} for ln in lines],
        }
        # Never auto-retry an order creation at the HTTP layer; the router retries
        # at the job level after checking whether the order already exists.
        data = self._call("POST", "/shopping/order/createOrderV2", json=payload, retry=False) or {}
        order_id = str(data.get("orderId") or "")
        if not order_id:
            raise ApiError("cj createOrderV2: response had no orderId", body=data)
        total = data.get("orderAmount") or data.get("productAmount")
        if total is None:
            total = sum((ln.unit_cost * ln.quantity for ln in lines), Decimal("0"))
        return SupplierOrderResult(order_id, Decimal(str(total)), raw=data)

    def pay_order(self, supplier_order_id: str) -> None:
        self._call("POST", "/shopping/pay/payBalance", json={"orderId": supplier_order_id}, retry=False)

    def tracking(self, supplier_order_id: str) -> TrackingInfo | None:
        d = self._call("GET", "/shopping/order/getOrderDetail", params={"orderId": supplier_order_id}) or {}
        number = d.get("trackNumber")
        if not number:
            return None
        return TrackingInfo(
            tracking_number=str(number),
            carrier=str(d.get("logisticName") or self.logistic_name),
            url=tracking_url(str(number)),
            status=str(d.get("orderStatus") or ""),
        )

    def close(self) -> None:
        self.http.close()


def _image_list(value: Any) -> list[str]:
    if not value:
        return []
    if isinstance(value, list):
        return [str(v) for v in value if v]
    text = str(value).strip()
    if text.startswith("["):
        try:
            return [str(v) for v in json.loads(text) if v]
        except ValueError:
            pass
    return [p.strip() for p in text.split(",") if p.strip()]
