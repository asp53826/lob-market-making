from __future__ import annotations

import itertools
import random
from dataclasses import dataclass, field

from .book import Book, Side
from .flow import BackgroundLP, EfficientPrice, InformedTrader, NoiseTrader
from .strategies import MarketMaker


@dataclass
class Result:
    mm: MarketMaker
    fairs: list[float]
    mids: list[float | None]
    inventory: list[int]
    book: Book
    steps: int
    counterparties: dict[str, int] = field(default_factory=dict)

    @property
    def final_fair(self) -> float:
        return self.fairs[-1]

    def pnl(self) -> float:
        """Marked to the efficient price, not the mid.

        Marking to mid lets a strategy that ends holding a large position book a
        profit purely from where the book happens to sit.
        """
        return self.mm.mark_to(self.final_fair)


@dataclass
class Config:
    steps: int = 20_000
    seed: int = 1
    sigma: float = 0.6
    jump_prob: float = 0.002
    noise_rate: float = 0.55
    informed_rate: float = 0.18
    informed_edge: float = 1.0
    requote_every: int = 1
    warmup: int = 200


def run(mm: MarketMaker, cfg: Config = Config()) -> Result:
    rng = random.Random(cfg.seed)
    fair = EfficientPrice(sigma=cfg.sigma, jump_prob=cfg.jump_prob,
                          rng=random.Random(cfg.seed + 1))
    book = Book()
    ids = itertools.count(1)

    lp = BackgroundLP(random.Random(cfg.seed + 2))
    noise = NoiseTrader(random.Random(cfg.seed + 3), rate=cfg.noise_rate)
    informed = InformedTrader(random.Random(cfg.seed + 4), rate=cfg.informed_rate,
                              edge=cfg.informed_edge)

    fairs: list[float] = []
    mids: list[float | None] = []
    inv: list[int] = []
    counterparties: dict[str, int] = {}
    seen_trades = 0

    for ts in range(cfg.steps):
        fair.step()
        lp.act(book, fair, ts, ids)

        # let a book form before the market maker starts quoting into nothing
        if ts >= cfg.warmup and ts % cfg.requote_every == 0:
            mm.act(book, ts, ids)

        noise.act(book, fair, ts, ids)
        informed.act(book, fair, ts, ids)

        for t in book.trades[seen_trades:]:
            if t.maker_agent == mm.name:
                mm.on_fill(t.ts, t.aggressor.opposite, t.price, t.qty)
                counterparties[t.taker_agent] = counterparties.get(t.taker_agent, 0) + t.qty
            elif t.taker_agent == mm.name:
                mm.on_fill(t.ts, t.aggressor, t.price, t.qty)
                counterparties[t.maker_agent] = counterparties.get(t.maker_agent, 0) + t.qty
        seen_trades = len(book.trades)

        fairs.append(fair.value)
        mids.append(book.mid())
        inv.append(mm.inventory)

    return Result(mm, fairs, mids, inv, book, cfg.steps, counterparties)
