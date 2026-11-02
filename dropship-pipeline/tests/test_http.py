import httpx
import pytest

from dropship.http import ApiError, ResilientClient


def client(handler, **kw):
    sleeps = []
    c = ResilientClient("https://api.test", rate_per_sec=1000, transport=httpx.MockTransport(handler),
                        sleep=sleeps.append, **kw)
    return c, sleeps


def test_retries_429_honouring_retry_after_then_succeeds():
    calls = []

    def handler(req):
        calls.append(req)
        if len(calls) < 3:
            return httpx.Response(429, headers={"Retry-After": "2"})
        return httpx.Response(200, json={"ok": True})

    c, sleeps = client(handler)
    assert c.request("GET", "/x").json() == {"ok": True}
    assert len(calls) == 3
    assert sleeps[:2] == [2.0, 2.0]


def test_exponential_backoff_on_5xx_then_gives_up():
    c, sleeps = client(lambda req: httpx.Response(503), max_retries=3, base_delay=1)
    with pytest.raises(ApiError) as e:
        c.request("GET", "/x")
    assert e.value.status == 503 and e.value.retryable
    assert len(sleeps) == 3
    assert sleeps[0] <= 1 and 1 <= sleeps[1] <= 2 and 2 <= sleeps[2] <= 4


def test_4xx_is_not_retried():
    calls = []
    c, _ = client(lambda req: calls.append(1) or httpx.Response(422, json={"error": "bad"}))
    with pytest.raises(ApiError) as e:
        c.request("POST", "/x")
    assert len(calls) == 1 and e.value.body == {"error": "bad"} and not e.value.retryable


def test_retry_false_makes_a_single_attempt():
    calls = []
    c, _ = client(lambda req: calls.append(1) or httpx.Response(500))
    with pytest.raises(ApiError):
        c.request("POST", "/pay", retry=False)
    assert len(calls) == 1


def test_network_errors_are_retried():
    calls = []

    def handler(req):
        calls.append(1)
        if len(calls) == 1:
            raise httpx.ConnectError("boom", request=req)
        return httpx.Response(200, json={})

    c, sleeps = client(handler)
    c.request("GET", "/x")
    assert len(calls) == 2 and len(sleeps) == 1
