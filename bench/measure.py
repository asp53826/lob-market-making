"""What the strategies are actually worth, and where they stop working.

Every comparison is paired: each strategy is run on the same seed set, so
differences are not seed luck. Single-run numbers are reported with their
spread, because realised edge varies enough between seeds to flip a ranking.

    uv run python bench/measure.py
"""

from __future__ import annotations

import statistics
import time

from lob.metrics import report
from lob.sim import Config, run
from lob.strategies import AvellanedaStoikov, InventorySkew, NaiveMM

SEEDS = list(range(1, 13))
STEPS = 20_000


def strategies():
    return [
        ("naive(2)", lambda: NaiveMM(half_spread=2)),
        ("naive(5)", lambda: NaiveMM(half_spread=5)),
        ("skew(2)", lambda: InventorySkew(half_spread=2)),
        ("skew(5)", lambda: InventorySkew(half_spread=5)),
        ("A-S(y=.02)", lambda: AvellanedaStoikov(gamma=0.02)),
        ("A-S(y=.1)", lambda: AvellanedaStoikov(gamma=0.1)),
        ("A-S(y=.5)", lambda: AvellanedaStoikov(gamma=0.5)),
    ]


def across(make, seeds=SEEDS, **cfg):
    return [report(run(make(), Config(steps=STEPS, seed=s, **cfg))) for s in seeds]


def ms(xs):
    return statistics.mean(xs), (statistics.stdev(xs) if len(xs) > 1 else 0.0)


def line(name, reps):
    pnl, pnl_sd = ms([r.pnl for r in reps])
    edge, edge_sd = ms([r.edge_per_share for r in reps])
    cap, _ = ms([r.decomposition.spread_capture for r in reps])
    invp, _ = ms([r.decomposition.inventory_pnl for r in reps])
    isd, _ = ms([r.inv_std for r in reps])
    vol, _ = ms([r.volume for r in reps])
    tox, _ = ms([r.toxic_share for r in reps])
    sh, sh_sd = ms([r.sharpe for r in reps])
    wins = sum(1 for r in reps if r.pnl > 0)
    print(f"  {name:<12}{pnl:>10,.0f}±{pnl_sd:<9,.0f}{edge:>7.3f}±{edge_sd:<6.3f}"
          f"{cap:>10,.0f}{invp:>11,.0f}{isd:>8.1f}{vol:>8,.0f}{tox:>7.1%}"
          f"{sh:>7.1f}{wins:>5}/{len(reps)}")


def header():
    print(f"  {'strategy':<12}{'PnL (mean±sd)':>20}{'edge/sh':>14}"
          f"{'capture':>10}{'inventory':>11}{'inv sd':>8}{'volume':>8}"
          f"{'toxic':>7}{'sharpe':>7}{'wins':>10}")
    print("  " + "-" * 114)


def main():
    t0 = time.perf_counter()

    print(f"\n=== strategy comparison ({len(SEEDS)} paired seeds x {STEPS:,} steps) ===\n")
    header()
    base = {}
    for name, make in strategies():
        reps = across(make)
        base[name] = reps
        line(name, reps)

    print("\n  PnL is marked to the efficient price, not the mid. `capture` and")
    print("  `inventory` are the exact decomposition of PnL and sum to it.")

    print(f"\n=== toxicity sweep: where market making stops paying ===\n")
    print(f"  {'informed':<10}" + "".join(f"{n:>22}" for n, _ in
                                          [("skew(2)", 0), ("skew(5)", 0), ("A-S(y=.1)", 0)]))
    print("  " + "-" * 76)
    sweep = [("skew(2)", lambda: InventorySkew(half_spread=2)),
             ("skew(5)", lambda: InventorySkew(half_spread=5)),
             ("A-S(y=.1)", lambda: AvellanedaStoikov(gamma=0.1))]
    for rate in (0.0, 0.1, 0.25, 0.5, 0.75, 1.0):
        cells = []
        for _, make in sweep:
            reps = across(make, seeds=SEEDS[:8], informed_rate=rate)
            pnl, sd = ms([r.pnl for r in reps])
            wins = sum(1 for r in reps if r.pnl > 0)
            cells.append(f"{pnl:>11,.0f} ({wins}/{len(reps)})")
        print(f"  {rate:<10.2f}" + "".join(f"{c:>22}" for c in cells))
    print("\n  cell = mean PnL (profitable seeds / total)")

    print(f"\n=== quote staleness: requoting less often ===\n")
    print(f"  {'requote':<10}{'PnL':>12}{'edge/share':>13}{'toxic share':>13}{'volume':>10}")
    print("  " + "-" * 58)
    for every in (1, 2, 5, 10, 25, 50):
        reps = across(lambda: InventorySkew(half_spread=2), seeds=SEEDS[:8],
                      requote_every=every)
        pnl, _ = ms([r.pnl for r in reps])
        edge, _ = ms([r.edge_per_share for r in reps])
        tox, _ = ms([r.toxic_share for r in reps])
        vol, _ = ms([r.volume for r in reps])
        print(f"  {every:<10}{pnl:>12,.0f}{edge:>13.3f}{tox:>12.1%}{vol:>10,.0f}")

    print(f"\n=== Avellaneda-Stoikov is only as good as its k ===\n")
    print("  A-S spread = gamma*sigma^2*(T-t) + (2/gamma)*ln(1 + gamma/k).")
    print("  k is the decay of fill intensity with distance and must be calibrated;")
    print("  the market's own spread here is ~5 ticks.\n")
    print(f"  {'gamma':>6}{'k':>7}{'spread term':>13}{'quoted':>9}{'PnL':>11}"
          f"{'edge/sh':>9}{'inv sd':>8}{'volume':>9}")
    print("  " + "-" * 72)
    import math as _m
    for g in (0.1, 0.5):
        for k in (1.5, 0.3, 0.05, 0.01):
            reps = across(lambda g=g, k=k: AvellanedaStoikov(gamma=g, k=k), seeds=SEEDS[:6])
            print(f"  {g:>6}{k:>7}{(2/g)*_m.log1p(g/k):>13.2f}"
                  f"{ms([r.quoted_spread for r in reps])[0]:>9.2f}"
                  f"{ms([r.pnl for r in reps])[0]:>11,.0f}"
                  f"{ms([r.edge_per_share for r in reps])[0]:>9.3f}"
                  f"{ms([r.inv_std for r in reps])[0]:>8.1f}"
                  f"{ms([r.volume for r in reps])[0]:>9,.0f}")
    print("\n  Note the last row of each block: edge per share can be made")
    print("  arbitrarily large by quoting so wide you barely trade. It is only")
    print("  meaningful read alongside volume and total PnL.")

    print(f"\ndone in {time.perf_counter()-t0:.1f}s\n")


if __name__ == "__main__":
    main()
