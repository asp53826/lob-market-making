"""Measurement.

Raw PnL is close to worthless on its own: it is dominated by whichever way the
price happened to drift against whatever inventory the strategy happened to be
holding. The metrics that survive scrutiny are the decomposition (how much came
from quoting versus from carrying a position) and markout (what the fills were
really worth once the price finished moving).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from .book import Side
from .sim import Result


@dataclass
class Decomposition:
    spread_capture: float     # value earned at the moment of each fill
    inventory_pnl: float      # value from holding a position while price moved
    total: float

    def check(self, actual: float, tol: float = 1e-6) -> bool:
        return abs(self.total - actual) <= tol * max(1.0, abs(actual))


def decompose(r: Result) -> Decomposition:
    """PnL = spread capture + inventory PnL, exactly.

    Marking the book to fair value V_t, a fill of q at price p on side s moves
    PnL by q*(V_t - p) for a buy and q*(p - V_t) for a sell, and holding
    inventory across a price move contributes inv*(V_{t+1} - V_t). Nothing else
    can move it, so the two terms must sum to the total.
    """
    capture = 0.0
    for ts, side, price, qty in r.mm.fills:
        v = r.fairs[min(ts, len(r.fairs) - 1)]
        capture += qty * (v - price) if side is Side.BUY else qty * (price - v)

    carry = 0.0
    for i in range(len(r.fairs) - 1):
        carry += r.inventory[i] * (r.fairs[i + 1] - r.fairs[i])

    return Decomposition(capture, carry, capture + carry)


def _per_share(r: Result, h: int) -> list[float]:
    n = len(r.fairs)
    out = []
    for ts, side, price, qty in r.mm.fills:
        v = r.fairs[min(ts + h, n - 1)]
        out.append((v - price) if side is Side.BUY else (price - v))
    return out


def edge_per_share(r: Result) -> float:
    """Realised edge per share against fair value at the moment of the fill.

    This is the exact adverse-selection measure. Being filled at a price on the
    wrong side of fair value *is* adverse selection, and here fair value is
    known, so no proxy is needed and no noise enters.
    """
    xs = _per_share(r, 0)
    return sum(xs) / len(xs) if xs else 0.0


def markout(r: Result, horizons=(0, 1, 10, 100, 1000)) -> dict[int, tuple[float, float]]:
    """Per-share PnL of each fill against fair value `h` steps later, as
    (mean, standard error).

    In production, markout decay is *the* adverse-selection metric, because
    fair value is unobservable and future mid is the only available proxy. In a
    simulator fair value is observable, which makes horizon 0 exact and makes
    the long horizons close to useless: over h steps the price wanders about
    sigma*sqrt(h), which at sigma=0.6 and h=100 is ~6 ticks against an edge of
    ~0.4. The standard errors below are reported precisely so that this is
    visible rather than being read as signal.
    """
    out: dict[int, tuple[float, float]] = {}
    for h in horizons:
        xs = _per_share(r, h)
        if not xs:
            out[h] = (0.0, 0.0)
            continue
        mu = sum(xs) / len(xs)
        var = sum((x - mu) ** 2 for x in xs) / max(len(xs) - 1, 1)
        out[h] = (mu, math.sqrt(var / len(xs)))
    return out


@dataclass
class Report:
    strategy: str
    pnl: float
    pnl_per_step: float
    decomposition: Decomposition
    edge_per_share: float
    markouts: dict[int, tuple[float, float]]
    fills: int
    volume: int
    inv_mean: float
    inv_std: float
    inv_max_abs: int
    end_inventory: int
    sharpe: float
    toxic_share: float
    quoted_spread: float


def _step_pnl(r: Result) -> list[float]:
    """Mark-to-fair PnL path, so risk is measured on the whole path rather than
    the endpoint."""
    cash = 0.0
    inv = 0
    path = []
    fills_by_ts: dict[int, list] = {}
    for f in r.mm.fills:
        fills_by_ts.setdefault(f[0], []).append(f)

    for ts in range(len(r.fairs)):
        for _, side, price, qty in fills_by_ts.get(ts, ()):
            if side is Side.BUY:
                inv += qty
                cash -= price * qty
            else:
                inv -= qty
                cash += price * qty
        path.append(cash + inv * r.fairs[ts])
    return path


def report(r: Result) -> Report:
    path = _step_pnl(r)
    rets = [b - a for a, b in zip(path, path[1:])]
    mu = sum(rets) / len(rets) if rets else 0.0
    var = sum((x - mu) ** 2 for x in rets) / max(len(rets) - 1, 1) if rets else 0.0
    sd = math.sqrt(var)

    inv = r.inventory
    im = sum(inv) / len(inv)
    isd = math.sqrt(sum((x - im) ** 2 for x in inv) / max(len(inv) - 1, 1))

    volume = sum(q for _, _, _, q in r.mm.fills)
    toxic = r.counterparties.get("informed", 0)

    spreads = [a - b for _, b, a in r.mm.quotes if b is not None and a is not None]

    return Report(
        strategy=r.mm.name,
        pnl=r.pnl(),
        pnl_per_step=r.pnl() / r.steps,
        decomposition=decompose(r),
        edge_per_share=edge_per_share(r),
        markouts=markout(r),
        fills=len(r.mm.fills),
        volume=volume,
        inv_mean=im,
        inv_std=isd,
        inv_max_abs=max((abs(x) for x in inv), default=0),
        end_inventory=r.mm.inventory,
        sharpe=(mu / sd * math.sqrt(len(rets))) if sd > 0 else 0.0,
        toxic_share=toxic / volume if volume else 0.0,
        quoted_spread=sum(spreads) / len(spreads) if spreads else 0.0,
    )
