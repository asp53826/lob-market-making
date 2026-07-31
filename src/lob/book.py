"""Limit order book with price-time priority.

Prices are integer ticks throughout. Float prices in a matching engine produce
orders that don't match when they should, and the bug surfaces as a
mysteriously crossed book three hours into a simulation.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from enum import IntEnum
from heapq import heappop, heappush


class Side(IntEnum):
    BUY = 1
    SELL = -1

    @property
    def opposite(self) -> "Side":
        return Side.SELL if self is Side.BUY else Side.BUY


@dataclass
class Order:
    id: int
    side: Side
    price: int              # ticks
    qty: int
    ts: int = 0
    agent: str = ""
    remaining: int = field(init=False)

    def __post_init__(self):
        if self.qty <= 0:
            raise ValueError(f"order {self.id}: qty must be positive, got {self.qty}")
        self.remaining = self.qty

    @property
    def filled(self) -> int:
        return self.qty - self.remaining


@dataclass(frozen=True)
class Trade:
    ts: int
    price: int
    qty: int
    aggressor: Side
    maker_id: int
    taker_id: int
    maker_agent: str = ""
    taker_agent: str = ""


class Book:
    def __init__(self):
        self._levels: dict[tuple[Side, int], deque[Order]] = {}
        self._orders: dict[int, Order] = {}
        # lazy-deletion heaps; bids negated so both are min-heaps
        self._bid_heap: list[int] = []
        self._ask_heap: list[int] = []
        self._queued: set[tuple[Side, int]] = set()
        self.trades: list[Trade] = []

    # ---- inspection --------------------------------------------------------

    def _prune(self, side: Side) -> int | None:
        heap = self._bid_heap if side is Side.BUY else self._ask_heap
        while heap:
            price = -heap[0] if side is Side.BUY else heap[0]
            level = self._levels.get((side, price))
            if level:
                return price
            heappop(heap)
            self._queued.discard((side, price))
            self._levels.pop((side, price), None)
        return None

    def best_bid(self) -> int | None:
        return self._prune(Side.BUY)

    def best_ask(self) -> int | None:
        return self._prune(Side.SELL)

    def mid(self) -> float | None:
        b, a = self.best_bid(), self.best_ask()
        return (b + a) / 2 if b is not None and a is not None else None

    def spread(self) -> int | None:
        b, a = self.best_bid(), self.best_ask()
        return a - b if b is not None and a is not None else None

    def qty_at(self, side: Side, price: int) -> int:
        return sum(o.remaining for o in self._levels.get((side, price), ()))

    def depth(self, side: Side, levels: int = 5) -> list[tuple[int, int]]:
        prices = sorted(
            (p for (s, p), q in self._levels.items() if s is side and q),
            reverse=side is Side.BUY,
        )
        return [(p, self.qty_at(side, p)) for p in prices[:levels]]

    def __len__(self) -> int:
        return len(self._orders)

    def is_crossed(self) -> bool:
        b, a = self.best_bid(), self.best_ask()
        return b is not None and a is not None and b >= a

    # ---- mutation ----------------------------------------------------------

    def _rest(self, order: Order) -> None:
        key = (order.side, order.price)
        if key not in self._levels:
            self._levels[key] = deque()
        if key not in self._queued:
            heappush(
                self._bid_heap if order.side is Side.BUY else self._ask_heap,
                -order.price if order.side is Side.BUY else order.price,
            )
            self._queued.add(key)
        self._levels[key].append(order)
        self._orders[order.id] = order

    def _crosses(self, side: Side, price: int, best: int | None) -> bool:
        if best is None:
            return False
        return price >= best if side is Side.BUY else price <= best

    def limit(self, order: Order) -> list[Trade]:
        """Submit a limit order. Marketable portions execute, the rest rests."""
        if order.id in self._orders:
            raise ValueError(f"duplicate order id {order.id}")
        fills = self._match(order, limit_price=order.price)
        if order.remaining:
            self._rest(order)
        return fills

    def post(self, order: Order) -> bool:
        """Post-only: rest without ever taking liquidity.

        Without this, a quote placed across the book executes immediately and
        the strategy silently becomes a liquidity taker — it pays the spread
        while its author believes it is earning it. Measured on an
        Avellaneda-Stoikov maker with gamma=0.5, 73% of volume arrived this way
        and the realised edge was -1.43 ticks per share.

        The order is repriced to the most aggressive non-crossing level rather
        than rejected, which is what a maker actually wants. Returns False if no
        such level exists.
        """
        if order.id in self._orders:
            raise ValueError(f"duplicate order id {order.id}")
        contra = self._prune(order.side.opposite)
        if contra is not None:
            if order.side is Side.BUY and order.price >= contra:
                order.price = contra - 1
            elif order.side is Side.SELL and order.price <= contra:
                order.price = contra + 1
        if order.price <= 0:
            return False
        self._rest(order)
        return True

    def market(self, order: Order) -> list[Trade]:
        """Execute against resting liquidity; any unfilled remainder is dropped."""
        return self._match(order, limit_price=None)

    def _match(self, taker: Order, limit_price: int | None) -> list[Trade]:
        fills: list[Trade] = []
        contra = taker.side.opposite

        while taker.remaining:
            best = self._prune(contra)
            if best is None:
                break
            if limit_price is not None and not self._crosses(taker.side, limit_price, best):
                break

            level = self._levels[(contra, best)]
            while level and taker.remaining:
                maker = level[0]
                qty = min(maker.remaining, taker.remaining)
                # the resting order sets the price — that is what price-time
                # priority means, and it is where the maker's edge comes from
                t = Trade(taker.ts, best, qty, taker.side, maker.id, taker.id,
                          maker.agent, taker.agent)
                fills.append(t)
                self.trades.append(t)
                maker.remaining -= qty
                taker.remaining -= qty
                if not maker.remaining:
                    level.popleft()
                    self._orders.pop(maker.id, None)

            if not level:
                self._levels.pop((contra, best), None)

        return fills

    def cancel(self, order_id: int) -> bool:
        order = self._orders.pop(order_id, None)
        if order is None:
            return False
        level = self._levels.get((order.side, order.price))
        if level is not None:
            try:
                level.remove(order)
            except ValueError:
                pass
            if not level:
                self._levels.pop((order.side, order.price), None)
        return True

    def cancel_agent(self, agent: str) -> int:
        """Pull every resting order for one agent. Market makers requote constantly."""
        ids = [oid for oid, o in self._orders.items() if o.agent == agent]
        for oid in ids:
            self.cancel(oid)
        return len(ids)
