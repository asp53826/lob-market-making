import pytest

from lob.book import Side
from lob.metrics import decompose, edge_per_share, markout, report
from lob.sim import Config, run
from lob.strategies import AvellanedaStoikov, InventorySkew, MarketMaker, NaiveMM

FAST = Config(steps=4000, seed=3)


def test_pnl_decomposition_is_exact():
    """Spread capture + inventory PnL must equal total PnL. If it doesn't, one
    of the three is computed wrong and every conclusion downstream is void."""
    for mk in (NaiveMM, InventorySkew, AvellanedaStoikov):
        r = run(mk(), FAST)
        d = decompose(r)
        assert d.check(r.pnl()), f"{mk.__name__}: {d.total} != {r.pnl()}"


def test_markout_at_zero_is_the_capture_side_of_the_decomposition():
    """Both measure value earned at fill time; markout is per share, capture is
    the total, so they agree once size-weighting is undone."""
    r = run(InventorySkew(), FAST)
    d = decompose(r)
    tot = sum(
        q * m for (_, _, _, q), m in zip(r.mm.fills, _per_share_at_zero(r))
    )
    assert tot == pytest.approx(d.spread_capture, rel=1e-9)


def _per_share_at_zero(r):
    from lob.metrics import _per_share
    return _per_share(r, 0)


def test_informed_flow_erodes_realised_edge():
    """The core property the whole simulator exists to produce: more informed
    flow means the maker is filled further on the wrong side of fair value.

    Compared under common random numbers — same seed, only the informed rate
    varies — because the seed-to-seed spread in edge is as large as the effect
    being measured (see test_single_seed_edge_is_unreliable).
    """
    for seed in (5, 6, 7, 8):
        clean = edge_per_share(
            run(InventorySkew(), Config(steps=8000, seed=seed, informed_rate=0.0)))
        toxic = edge_per_share(
            run(InventorySkew(), Config(steps=8000, seed=seed, informed_rate=0.9)))
        assert toxic < clean, f"seed {seed}: {toxic} !< {clean}"


def test_single_seed_edge_is_unreliable():
    """Why the benchmark runs many seeds and compares them paired.

    Realised edge varies enough between seeds that any two strategies could be
    ranked either way on a single run.
    """
    import statistics

    edges = [
        edge_per_share(run(InventorySkew(), Config(steps=8000, seed=s)))
        for s in range(20, 27)
    ]
    assert statistics.stdev(edges) > 0.1 * abs(statistics.mean(edges))


def test_long_horizon_markout_is_dominated_by_noise():
    """Documents why the headline metric is horizon 0 rather than markout decay.

    The claim is about stability, not one seed: at sigma=0.6 the price wanders
    ~6 ticks over 100 steps against an edge below 1, so the horizon-100 number
    moves around from run to run while horizon 0 stays put.
    """
    import statistics

    se0s, se100s = [], []
    for seed in range(20, 27):
        m = markout(run(InventorySkew(), Config(steps=8000, seed=seed)), (0, 100))
        se0s.append(m[0][1])
        se100s.append(m[100][1])

    # variance of the estimator grows with the horizon it integrates over
    assert statistics.mean(se100s) > 2.5 * statistics.mean(se0s)


def test_informed_traders_take_more_from_a_tighter_quote():
    wide = report(run(NaiveMM(half_spread=8), FAST))
    tight = report(run(NaiveMM(half_spread=1), FAST))
    assert tight.toxic_share > wide.toxic_share


def test_inventory_skew_holds_less_risk_than_naive():
    n = report(run(NaiveMM(half_spread=2), FAST))
    s = report(run(InventorySkew(half_spread=2), FAST))
    assert s.inv_std < n.inv_std


def test_inventory_limit_is_respected():
    r = run(NaiveMM(half_spread=1, max_inventory=40), Config(steps=6000, seed=2))
    # the cap gates new quotes, so a single fill can overshoot by one clip
    assert max(abs(x) for x in r.inventory) <= 40 + r.mm.size * 3


def test_market_maker_never_quotes_crossed():
    class Crossing(MarketMaker):
        name = "crossing"

        def desired_quotes(self, book, ts):
            m = book.mid()
            return (int(m + 5), int(m - 5)) if m else (None, None)

    r = run(Crossing(), Config(steps=1500, seed=4))
    assert not r.book.is_crossed()
    for _, b, a in r.mm.quotes:
        if b is not None and a is not None:
            assert b < a


def test_book_is_never_crossed_during_a_run():
    r = run(InventorySkew(), FAST)
    assert not r.book.is_crossed()


def test_pnl_is_marked_to_fair_not_mid():
    """Marking to mid lets a strategy book profit from where the book happens
    to sit rather than what the position is worth."""
    r = run(NaiveMM(), FAST)
    assert r.pnl() == pytest.approx(r.mm.cash + r.mm.inventory * r.fairs[-1])


def test_runs_are_reproducible():
    a = report(run(InventorySkew(), Config(steps=3000, seed=11)))
    b = report(run(InventorySkew(), Config(steps=3000, seed=11)))
    assert (a.pnl, a.fills, a.volume) == (b.pnl, b.fills, b.volume)


def test_different_seeds_give_different_results():
    a = report(run(InventorySkew(), Config(steps=3000, seed=11)))
    b = report(run(InventorySkew(), Config(steps=3000, seed=12)))
    assert a.pnl != b.pnl


def test_strategy_cannot_see_the_efficient_price():
    """Guards the one shortcut that would invalidate everything: a strategy
    reading fair value instead of inferring it from the book."""
    import inspect

    from lob import strategies

    src = inspect.getsource(strategies)
    assert "EfficientPrice" not in src
    assert "fair" not in src.lower().replace("fairly", "")


def test_wider_quotes_fill_less():
    tight = report(run(NaiveMM(half_spread=1), FAST))
    wide = report(run(NaiveMM(half_spread=10), FAST))
    assert wide.volume < tight.volume


def test_counterparties_account_for_all_volume():
    r = run(InventorySkew(), FAST)
    rep = report(r)
    assert sum(r.counterparties.values()) == rep.volume


def test_market_maker_is_never_a_taker():
    """Post-only is what separates market making from paying the spread. Before
    it existed, Avellaneda-Stoikov at gamma=0.5 took liquidity on 73% of its
    volume and reported that as market-making PnL."""
    for mk in (lambda: NaiveMM(half_spread=2), lambda: InventorySkew(half_spread=2),
               lambda: AvellanedaStoikov(gamma=0.5), lambda: AvellanedaStoikov(gamma=0.02)):
        r = run(mk(), Config(steps=6000, seed=3))
        taken = sum(t.qty for t in r.book.trades if t.taker_agent == r.mm.name)
        assert taken == 0, f"{r.mm.name} took {taken} shares"
