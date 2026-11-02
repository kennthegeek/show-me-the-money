"""Dynamic markup pricing.

price = round_charm( max( landed_cost * tier_multiplier + fixed_markup,
                          landed_cost + min_profit,
                          landed_cost / (1 - min_margin) ) )

`landed_cost` = (supplier cost [+ shipping]) * currency_rate. All math is Decimal.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_CEILING, ROUND_HALF_UP, Decimal

from .config import PricingConfig

CENT = Decimal("0.01")


@dataclass(frozen=True)
class Quote:
    landed_cost: Decimal
    price: Decimal
    compare_at: Decimal | None
    profit: Decimal
    margin_pct: Decimal


def _multiplier(cost: Decimal, tiers: list[dict]) -> Decimal:
    ordered = sorted(tiers, key=lambda t: float("inf") if t.get("max_cost") is None else float(t["max_cost"]))
    for tier in ordered:
        cap = tier.get("max_cost")
        if cap is None or cost <= Decimal(str(cap)):
            return Decimal(str(tier["multiplier"]))
    return Decimal(str(ordered[-1]["multiplier"])) if ordered else Decimal("2")


def _charm(value: Decimal, ending: str) -> Decimal:
    """Round *up* to the next price that ends in `ending` (e.g. 0.99 -> 24.99)."""
    if not ending:
        return value.quantize(CENT, rounding=ROUND_HALF_UP)
    end = Decimal(ending)
    whole = value.to_integral_value(rounding=ROUND_CEILING)
    candidate = whole - 1 + end
    if candidate < value:
        candidate += 1
    return candidate.quantize(CENT)


def quote(cost: Decimal, shipping: Decimal, cfg: PricingConfig) -> Quote:
    base = cost + (shipping if cfg.include_shipping_in_cost else Decimal("0"))
    landed = (base * cfg.currency_rate).quantize(CENT, rounding=ROUND_HALF_UP)
    if landed <= 0:
        raise ValueError(f"invalid landed cost {landed}")

    by_markup = landed * _multiplier(landed, cfg.tiers) + cfg.fixed_markup
    by_profit = landed + cfg.min_profit
    margin = cfg.min_margin_pct / Decimal(100)
    by_margin = landed / (1 - margin) if margin < 1 else by_markup
    price = _charm(max(by_markup, by_profit, by_margin), cfg.charm_ending)

    compare_at = None
    if cfg.compare_at_multiplier > 0:
        compare_at = _charm(price * cfg.compare_at_multiplier, cfg.charm_ending)
        if compare_at <= price:
            compare_at = None

    profit = price - landed
    return Quote(
        landed_cost=landed,
        price=price,
        compare_at=compare_at,
        profit=profit.quantize(CENT),
        margin_pct=(profit / price * 100).quantize(Decimal("0.1")),
    )
