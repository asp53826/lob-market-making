# Design notes

Two bugs in this repo produced *better-looking* results than the fixed version.
That is the failure mode a market-making backtest has to be built against: the
errors that flatter you are the ones nobody reports.

## The maker that was secretly a taker

Avellaneda-Stoikov at γ=0.5 was returning −175,958 mean PnL on a realised edge
of −1.43 ticks per share, with 117,693 shares of volume — roughly five times
what any other strategy traded. A market maker should not trade *more* as it
becomes more risk-averse.

Counting who was the aggressor on each trade:

```
strategy   maker    taker   taker share
naive(2)   27,340       0          0.0%
skew(2)    22,720       0          0.0%
A-S γ=.02  50,705     889          1.7%
A-S γ=.1   51,107  13,166         20.5%
A-S γ=.5   33,009  87,860         72.7%
```

The inventory term `q·γ·σ²·(T−t)` scales with γ, so at high risk aversion a
non-zero position pushes one quote clear across the book. `Book.limit()` does
what a limit order does — it matched immediately. The strategy was crossing the
spread on three quarters of its volume and booking the cost as market-making
PnL.

Real market makers do not submit orders that can cross; they use post-only,
which exchanges either reject or reprice. `Book.post()` reprices to the most
aggressive non-crossing level, and `test_market_maker_is_never_a_taker` asserts
zero taken volume for every strategy. Fixing it moved γ=0.5 from −175,958 to
−68,155 — still bad, but now bad for an honest reason.

The general lesson: any market-making simulator without post-only semantics
silently converts aggressive quoting into liquidity taking, and the more
aggressive the strategy, the more of its "results" are really the spread it paid.

## The metric that measured the random walk

Markout — the value of a fill measured some horizon after it happens — is the
standard adverse-selection metric, so the first version reported it at horizons
0, 1, 10, 100, 1000. The numbers were incoherent: with informed flow cranked to
0.9, markout at h=100 came out *higher* than at h=0, implying fills were
followed by favourable moves.

They weren't. The fair value is a driftless random walk, so `E[V(t+h) | V(t)] =
V(t)` and the long-horizon markout has an expectation equal to the short one and
a standard deviation of roughly `σ√h`. At σ=0.6 and h=100 that is about 6 ticks
of noise wrapped around an edge of 0.4. Averaged over ~1,400 fills the standard
error is ~0.36 — comparable to the entire quantity being estimated.

Two changes came out of that:

1. `markout()` returns `(mean, standard error)` at every horizon, so the noise
   is impossible to miss. There is a test asserting the long-horizon standard
   error is several times the short-horizon one.
2. The headline metric became `edge_per_share`: realised value against fair
   value *at the moment of the fill*. Markout decay is a proxy that exists
   because production cannot observe fair value. A simulator can, which makes
   the proxy strictly worse than the thing it proxies.

## Single seeds cannot rank strategies

While fixing the above, the seed-to-seed spread of realised edge turned out to
be about 0.25 ticks on a mean near 0.7 — a third of the signal. Two strategies
separated by less than that can be ranked either way depending on which seed
you happened to run.

Every comparison in `bench/measure.py` therefore runs the same seed set for
every strategy (common random numbers) and reports a standard deviation and a
count of profitable seeds. The informed-flow test compares clean against toxic
*at the same seed* for the same reason — paired, the effect is unambiguous at
every seed tried; unpaired, it would be buried.

`test_single_seed_edge_is_unreliable` fails if that variance ever collapses,
which would mean the flow model had stopped being stochastic in some way.

## Why PnL is marked to fair value

`Result.pnl()` marks the closing position at the latent fair value, not the book
mid. Marking to mid lets a strategy that finishes holding inventory book a
profit from wherever the book happens to be sitting — and a strategy that skews
hard has predictable end-of-run inventory, so it is exactly the strategies under
test that would benefit.

## The decomposition is exact, and that is the point

Marking to fair value `V`, a fill of `q` at price `p` moves PnL by `q(V−p)` on a
buy and `q(p−V)` on a sell, and carrying inventory across a price move
contributes `inv·(V(t+1) − V(t))`. Nothing else can move it. So

```
PnL = spread capture + inventory PnL
```

holds identically, and `test_pnl_decomposition_is_exact` asserts it for every
strategy. It is worth having as a test rather than a comment because it is a
genuine end-to-end check: it fails if fills are accounted on the wrong side, if
the inventory path is off by one step, or if the fair-value series is misaligned
with the fill timestamps.

It is also the metric that separates `naive(2)` from `skew(2)`. Their total PnL
differs by 35%; their *spread capture* differs by 11%. Almost all of the naive
strategy's apparent advantage is inventory PnL — an unhedged directional bet
that happened to pay on these seeds.

## What the strategies are allowed to see

`test_strategy_cannot_see_the_efficient_price` greps the strategy module for any
reference to fair value. It is a crude check and it is there because this is the
single shortcut that would invalidate the entire repo, and it is the kind of
thing that gets added during debugging and left in.

Volatility, which A-S needs, is estimated by each strategy from its own history
of observed mids rather than taken from the generator's σ, for the same reason.
