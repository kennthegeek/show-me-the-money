"""Wire-level tests for the CJ and Shopify connectors using httpx.MockTransport."""

import json
from decimal import Decimal

import httpx

from dropship.models import OrderLine, ShippingAddress, TrackingInfo
from dropship.storefronts.shopify import ShopifyStorefront
from dropship.suppliers.cj import CJSupplier


def ok(data):
    return httpx.Response(200, json={"code": 200, "result": True, "message": "Success", "data": data})


def make_cj(routes, log):
    def handler(req: httpx.Request):
        log.append(req)
        return routes[req.url.path.split("/v1", 1)[1]](req)

    return CJSupplier("key-123", "https://cj.test/api2.0/v1", logistic_name="CJPacket Ordinary",
                      from_country="CN", rate_per_sec=1000, transport=httpx.MockTransport(handler),
                      sleep=lambda s: None)


def test_cj_auth_product_stock_and_order():
    log = []
    routes = {
        "/authentication/getAccessToken": lambda r: ok({"accessToken": "tok"}),
        "/product/query": lambda r: ok({
            "pid": "P1", "productNameEn": "Lamp", "productKeyEn": "Color-Size",
            "productImageSet": ["https://img/1.jpg"], "description": "<p>x</p>",
            "variants": [{"vid": "V1", "variantSku": "S1", "variantKey": "Black-L", "variantSellPrice": 3.2}],
        }),
        "/product/stock/queryByVid": lambda r: ok([{"storageNum": 40}, {"storageNum": 60}]),
        "/product/variant/queryByVid": lambda r: ok({"variantSellPrice": 3.4}),
        "/shopping/order/createOrderV2": lambda r: ok({"orderId": "CJO1", "orderAmount": 7.1}),
        "/shopping/order/getOrderDetail": lambda r: ok({"trackNumber": "YT9", "logisticName": "YunExpress"}),
    }
    cj = make_cj(routes, log)
    p = cj.product("P1")
    assert p.variants[0].options == {"Color": "Black", "Size": "L"}
    assert cj.stock(["V1"])["V1"].stock == 100
    assert cj.stock(["V1"])["V1"].cost == Decimal("3.4")

    addr = ShippingAddress("Jane Doe", "1 Main", "", "Austin", "Texas", "TX", "78701",
                           "United States", "US", "+1", "j@x.com")
    res = cj.create_order("SHOP-1", addr, [OrderLine("SKU", "V1", 2, Decimal("3.4"))])
    assert res.supplier_order_id == "CJO1" and res.total_cost == Decimal("7.1")
    body = json.loads(next(r for r in log if r.url.path.endswith("createOrderV2")).content)
    assert body["orderNumber"] == "SHOP-1" and body["products"] == [{"vid": "V1", "quantity": 2}]
    assert body["payType"] == 3  # never pays implicitly
    assert all(r.headers.get("CJ-Access-Token") == "tok" for r in log if "Token" not in r.url.path)
    assert sum(1 for r in log if r.url.path.endswith("getAccessToken")) == 1  # token cached

    t = cj.tracking("CJO1")
    assert t.tracking_number == "YT9" and "YT9" in t.url


def test_cj_business_error_is_raised():
    import pytest

    from dropship.http import ApiError

    routes = {
        "/authentication/getAccessToken": lambda r: ok({"accessToken": "tok"}),
        "/shopping/pay/payBalance": lambda r: httpx.Response(
            200, json={"code": 1600100, "result": False, "message": "Insufficient balance"}),
    }
    cj = make_cj(routes, [])
    with pytest.raises(ApiError, match="Insufficient balance"):
        cj.pay_order("CJO1")


def make_shopify(responses, log, version="2026-10"):
    it = iter(responses)

    def handler(req):
        log.append(json.loads(req.content))
        return next(it)

    return ShopifyStorefront("demo", "shpat_x", version, "123", rate_per_sec=1000,
                             transport=httpx.MockTransport(handler), sleep=lambda s: None)


def test_shopify_throttle_retry_and_modern_inventory_payload():
    log = []
    throttled = httpx.Response(200, json={
        "errors": [{"message": "Throttled", "extensions": {"code": "THROTTLED"}}],
        "extensions": {"cost": {"requestedQueryCost": 50,
                                "throttleStatus": {"currentlyAvailable": 10, "restoreRate": 50}}}})
    done = httpx.Response(200, json={"data": {"inventorySetQuantities": {"userErrors": []}}})
    shop = make_shopify([throttled, done], log)
    shop.set_inventory({"gid://shopify/InventoryItem/1": 7}, reference="r1")
    assert len(log) == 2
    v = log[1]["variables"]
    q = v["input"]["quantities"][0]
    assert q["changeFromQuantity"] is None and q["locationId"] == "gid://shopify/Location/123"
    assert "@idempotent" in log[1]["query"] and v["key"]


def test_shopify_legacy_inventory_payload():
    log = []
    shop = make_shopify([httpx.Response(200, json={"data": {"inventorySetQuantities": {"userErrors": []}}})],
                        log, version="2025-10")
    shop.set_inventory({"1": 3}, reference="r")
    inp = log[0]["variables"]["input"]
    assert inp["ignoreCompareQuantity"] is True and "changeFromQuantity" not in inp["quantities"][0]


def test_shopify_fulfill_selects_open_lines():
    log = []
    fo = httpx.Response(200, json={"data": {"order": {"fulfillmentOrders": {"nodes": [
        {"id": "FO1", "status": "OPEN", "lineItems": {"nodes": [
            {"id": "FOL1", "remainingQuantity": 1, "lineItem": {"id": "gid://shopify/LineItem/9001"}},
            {"id": "FOL2", "remainingQuantity": 1, "lineItem": {"id": "gid://shopify/LineItem/9002"}},
        ]}},
        {"id": "FO2", "status": "CLOSED", "lineItems": {"nodes": []}},
    ]}}}})
    created = httpx.Response(200, json={"data": {"fulfillmentCreate": {
        "fulfillment": {"id": "F1", "status": "SUCCESS"}, "userErrors": []}}})
    shop = make_shopify([fo, created], log)
    fid = shop.fulfill("5001", TrackingInfo("YT1", "YunExpress", "https://t/YT1"), ["9001"], notify=True)
    assert fid == "F1"
    f = log[1]["variables"]["fulfillment"]
    assert f["lineItemsByFulfillmentOrder"] == [
        {"fulfillmentOrderId": "FO1", "fulfillmentOrderLineItems": [{"id": "FOL1", "quantity": 1}]}]
    assert f["notifyCustomer"] is True and f["trackingInfo"]["number"] == "YT1"
    assert log[0]["variables"]["id"] == "gid://shopify/Order/5001"
