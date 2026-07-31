"""Market-making strategies.

Every strategy sees the book and its own inventory. None of them sees the
efficient price — that is what makes the comparison meaningful.
"""

from __future__ import annotations

import math
from collections import deque

from .book import Book, Order, Side


class MarketMaker:
    name = "mm"

    def __init__(self, size: int = 10, max_inventory: int = 200):
        self.size = size
        self.max_inventory = max_inventory
        self.inventory = 0
        self.cash = 0.0
        self.fills: list[tuple[int, Side, int, int]] = []   # ts, side, price, qty
        self.quotes: list[tuple[int, int | None, int | None]] = []  # ts, bid, ask
        self.repriced = 0
        self._mid_hist: deque[float] = deque(maxlen=250)

    # ---- accounting --------------------------------------------------------

    def on_fill(self, ts: int, side: Side, price: int, qty: int) -> None:
        """`side` is the side *we* traded. Buying costs cash and adds inventory."""
        if side is Side.BUY:
            self.inventory += qty
            self.cash -= price * qty
        else:
            self.inventory -= qty
            self.cash += price * qty
        self.fills.append((ts, side, price, qty))

    def mark_to(self, price: float) -> float:
        return self.cash + self.inventory * price

    # ---- quoting -----------------------------------------------------------

    def observe(self, book: Book) -> float | None:
        m = book.mid()
        if m is not None:
            self._mid_hist.append(m)
        return m

    def volatility(self) -> float:
        """Per-step vol estimated from observed mids. The strategy has to infer
        this; handing it the generator's sigma would be cheating."""
        if len(self._mid_hist) < 20:
            return 1.0
        d = [b - a for a, b in zip(self._mid_hist, list(self._mid_hist)[1:])]
        mu = sum(d) / len(d)
        var = sum((x - mu) ** 2 for x in d) / max(len(d) - 1, 1)
        return max(math.sqrt(var), 1e-6)

    def desired_quotes(self, book: Book, ts: int) -> tuple[int | None, int | None]:
        raise NotImplementedError

    def act(self, book: Book, ts: int, ids) -> None:
        book.cancel_agent(self.name)
        self.observe(book)
        bid, ask = self.desired_quotes(book, ts)

        # never quote a crossed or inverted pair
        if bid is not None and ask is not None and bid >= ask:
            ask = bid + 1

        # post-only: a maker that crosses the book is a taker paying the spread,
        # not a maker earning it. Repricing is counted so the strategy cannot
        # quietly rely on being slid back to a passive level.
        if bid is not None and self.inventory < self.max_inventory:
            o = Order(next(ids), Side.BUY, bid, self.size, ts, self.name)
            if book.post(o) and o.price != bid:
                self.repriced += 1
            bid = o.price
        if ask is not None and self.inventory > -self.max_inventory:
            o = Order(next(ids), Side.SELL, ask, self.size, ts, self.name)
            if book.post(o) and o.price != ask:
                self.repriced += 1
            ask = o.price
        self.quotes.append((ts, bid, ask))


class NaiveMM(MarketMaker):
    """Symmetric fixed spread around the book mid, ignoring inventory.

    The baseline that looks profitable until you measure what it is holding.
    """

    name = "naive"

    def __init__(self, half_spread: int = 2, **kw):
        super().__init__(**kw)
        self.half_spread = half_spread

    def desired_quotes(self, book, ts):
        m = book.mid()
        if m is None:
            return None, None
        return int(m - self.half_spread), int(math.ceil(m + self.half_spread))


class InventorySkew(MarketMaker):
    """Fixed spread, but the whole quote shifts against the position — long
    inventory pushes both quotes down to encourage selling."""

    name = "skew"

    def __init__(self, half_spread: int = 2, skew: float = 0.03, **kw):
        super().__init__(**kw)
        self.half_spread = half_spread
        self.skew = skew

    def desired_quotes(self, book, ts):
        m = book.mid()
        if m is None:
            return None, None
        r = m - self.skew * self.inventory
        return int(math.floor(r - self.half_spread)), int(math.ceil(r + self.half_spread))


class AvellanedaStoikov(MarketMaker):
    """Avellaneda-Stoikov (2008).

        reservation price  r = s - q * gamma * sigma^2 * (T - t)
        optimal spread     d = gamma * sigma^2 * (T - t) + (2/gamma) ln(1 + gamma/k)

    The inventory term and the spread term are separate: the first decides where
    to centre the quotes, the second how wide. Sigma is estimated from observed
    mids, not taken from the generator.
    """

    name = "as"

    def __init__(self, gamma: float = 0.02, k: float = 1.5, horizon: int = 2000,
                 min_half_spread: int = 1, **kw):
        super().__init__(**kw)
        self.gamma = gamma
        self.k = k
        self.horizon = horizon
        self.min_half_spread = min_half_spread

    def desired_quotes(self, book, ts):
        s = book.mid()
        if s is None:
            return None, None
        sigma = self.volatility()
        t_left = max(1.0 - (ts % self.horizon) / self.horizon, 1e-3)

        r = s - self.inventory * self.gamma * sigma**2 * t_left
        spread = self.gamma * sigma**2 * t_left + (2 / self.gamma) * math.log1p(self.gamma / self.k)
        half = max(spread / 2, self.min_half_spread)
        return int(math.floor(r - half)), int(math.ceil(r + half))
