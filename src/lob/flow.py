"""Order flow.

The market maker sees only the book. The efficient price is hidden from it and
visible to informed traders — that asymmetry is the entire point. A simulator
with only noise traders makes market making look like free money, because
nothing ever picks off a stale quote.
"""

from __future__ import annotations

import random
from dataclasses import dataclass

from .book import Book, Order, Side


class EfficientPrice:
    """Latent fair value. A random walk with occasional jumps, in ticks."""

    def __init__(self, start: int = 10_000, sigma: float = 0.6,
                 jump_prob: float = 0.002, jump_size: float = 25.0,
                 rng: random.Random | None = None):
        self.value = float(start)
        self.sigma = sigma
        self.jump_prob = jump_prob
        self.jump_size = jump_size
        self.rng = rng or random.Random()
        self.history: list[float] = [self.value]

    def step(self) -> float:
        self.value += self.rng.gauss(0.0, self.sigma)
        if self.rng.random() < self.jump_prob:
            self.value += self.rng.gauss(0.0, self.jump_size)
        self.history.append(self.value)
        return self.value

    @property
    def tick(self) -> int:
        return int(round(self.value))


@dataclass
class Agent:
    name: str
    rng: random.Random

    def act(self, book: Book, fair: EfficientPrice, ts: int, ids) -> None:
        raise NotImplementedError


class NoiseTrader(Agent):
    """Uninformed marketable flow. Trades for reasons unrelated to value, which
    is the flow a market maker actually wants."""

    def __init__(self, rng, rate: float = 0.55, size: tuple[int, int] = (1, 12)):
        super().__init__("noise", rng)
        self.rate = rate
        self.size = size

    def act(self, book, fair, ts, ids):
        if self.rng.random() > self.rate:
            return
        side = Side.BUY if self.rng.random() < 0.5 else Side.SELL
        qty = self.rng.randint(*self.size)
        book.market(Order(next(ids), side, 0, qty, ts, self.name))


class InformedTrader(Agent):
    """Sees the efficient price and takes any quote on the wrong side of it.

    This is adverse selection in its purest form: the market maker is filled
    precisely when its quote is stale. `edge` is how far in ticks the quote must
    be mispriced before it is worth taking, standing in for fees and latency.
    """

    def __init__(self, rng, rate: float = 0.18, edge: float = 1.0,
                 size: tuple[int, int] = (1, 15)):
        super().__init__("informed", rng)
        self.rate = rate
        self.edge = edge
        self.size = size

    def act(self, book, fair, ts, ids):
        if self.rng.random() > self.rate:
            return
        v = fair.value
        ask, bid = book.best_ask(), book.best_bid()
        qty = self.rng.randint(*self.size)
        if ask is not None and ask < v - self.edge:
            book.market(Order(next(ids), Side.BUY, 0, qty, ts, self.name))
        elif bid is not None and bid > v + self.edge:
            book.market(Order(next(ids), Side.SELL, 0, qty, ts, self.name))


class BackgroundLP(Agent):
    """Other liquidity providers. Keeps a book to trade against so the market
    maker is not the only quote in the market."""

    def __init__(self, rng, rate: float = 0.9, depth: int = 4,
                 offset: tuple[int, int] = (1, 6), size: tuple[int, int] = (5, 40),
                 cancel_rate: float = 0.25):
        super().__init__("lp", rng)
        self.rate = rate
        self.depth = depth
        self.offset = offset
        self.size = size
        self.cancel_rate = cancel_rate
        self._mine: list[int] = []

    def act(self, book, fair, ts, ids):
        # LPs are lazily anchored to fair value plus noise: they are not
        # informed, just approximately right and slow to update.
        self._mine = [i for i in self._mine if i in book._orders]
        for oid in list(self._mine):
            if self.rng.random() < self.cancel_rate:
                book.cancel(oid)
                self._mine.remove(oid)

        if self.rng.random() > self.rate:
            return
        anchor = fair.value + self.rng.gauss(0, 2.0)
        for _ in range(self.rng.randint(1, self.depth)):
            side = Side.BUY if self.rng.random() < 0.5 else Side.SELL
            off = self.rng.randint(*self.offset)
            price = int(round(anchor - off if side is Side.BUY else anchor + off))
            oid = next(ids)
            book.limit(Order(oid, side, price, self.rng.randint(*self.size), ts, self.name))
            if oid in book._orders:
                self._mine.append(oid)
