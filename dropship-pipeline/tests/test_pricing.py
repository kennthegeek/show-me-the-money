from decimal import Decimal

from dropship.config import PricingConfig
from dropship.pricing import _charm, quote


def test_tiered_markup_and_charm_rounding():
    q = quote(Decimal("4.20"), Decimal("3.50"), PricingConfig())
    assert q.landed_cost == Decimal("7.70")
    assert q.price == Decimal("19.99")  # 7.70 * 2.5 = 19.25 -> 19.99
    assert q.compare_at == Decimal("27.99")


def test_min_profit_floor_wins_for_cheap_items():
    cfg = PricingConfig(tiers=[{"max_cost": None, "multiplier": 1.1}], min_profit=Decimal("8"),
                        min_margin_pct=Decimal("0"), compare_at_multiplier=Decimal("0"))
    q = quote(Decimal("2"), Decimal("0"), cfg)
    assert q.price == Decimal("10.99")
    assert q.compare_at is None


def test_min_margin_floor():
    cfg = PricingConfig(tiers=[{"max_cost": None, "multiplier": 1.2}], min_profit=Decimal("0"),
                        min_margin_pct=Decimal("40"), charm_ending="")
    q = quote(Decimal("60"), Decimal("0"), cfg)
    assert q.price == Decimal("100.00")
    assert q.margin_pct >= Decimal("40")


def test_currency_conversion_applied():
    cfg = PricingConfig(currency_rate=Decimal("1.5"), include_shipping_in_cost=False)
    assert quote(Decimal("10"), Decimal("99"), cfg).landed_cost == Decimal("15.00")


def test_charm_never_rounds_down():
    assert _charm(Decimal("24.00"), "0.99") == Decimal("24.99")
    assert _charm(Decimal("24.995"), "0.99") == Decimal("25.99")
    assert _charm(Decimal("24.50"), "0.95") == Decimal("24.95")
