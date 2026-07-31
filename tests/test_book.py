import pytest

from lob.book import Book, Order, Side


def o(oid, side, price, qty, ts=0, agent=""):
    return Order(oid, side, price, qty, ts, agent)


def test_resting_orders_do_not_trade():
    b = Book()
    assert b.limit(o(1, Side.BUY, 99, 10)) == []
    assert b.limit(o(2, Side.SELL, 101, 10)) == []
    assert (b.best_bid(), b.best_ask()) == (99, 101)
    assert b.spread() == 2 and b.mid() == 100.0


def test_marketable_limit_executes_at_the_resting_price():
    """The maker sets the price. This is where the maker's edge lives; if the
    taker's price is used the market maker earns nothing."""
    b = Book()
    b.limit(o(1, Side.SELL, 100, 10))
    fills = b.limit(o(2, Side.BUY, 105, 10))
    assert len(fills) == 1
    assert fills[0].price == 100
    assert fills[0].aggressor is Side.BUY


def test_price_time_priority_within_a_level():
    b = Book()
    b.limit(o(1, Side.SELL, 100, 5, ts=1))
    b.limit(o(2, Side.SELL, 100, 5, ts=2))
    fills = b.limit(o(3, Side.BUY, 100, 5))
    assert [f.maker_id for f in fills] == [1]  # earliest first


def test_better_price_fills_before_worse():
    b = Book()
    b.limit(o(1, Side.SELL, 102, 5))
    b.limit(o(2, Side.SELL, 100, 5))
    b.limit(o(3, Side.SELL, 101, 5))
    fills = b.limit(o(4, Side.BUY, 102, 15))
    assert [f.price for f in fills] == [100, 101, 102]


def test_partial_fill_leaves_remainder_resting():
    b = Book()
    b.limit(o(1, Side.SELL, 100, 4))
    b.limit(o(2, Side.BUY, 100, 10))
    assert b.best_bid() == 100
    assert b.qty_at(Side.BUY, 100) == 6


def test_market_order_drops_unfilled_remainder():
    b = Book()
    b.limit(o(1, Side.SELL, 100, 3))
    fills = b.market(o(2, Side.BUY, 0, 10))
    assert sum(f.qty for f in fills) == 3
    assert b.best_bid() is None  # nothing rested
    assert len(b) == 0


def test_book_never_ends_crossed():
    b = Book()
    b.limit(o(1, Side.SELL, 100, 5))
    b.limit(o(2, Side.SELL, 101, 5))
    b.limit(o(3, Side.BUY, 103, 20))
    assert not b.is_crossed()
    assert b.best_bid() == 103 and b.best_ask() is None


def test_cancel_removes_from_queue_without_disturbing_others():
    b = Book()
    b.limit(o(1, Side.SELL, 100, 5, ts=1))
    b.limit(o(2, Side.SELL, 100, 5, ts=2))
    assert b.cancel(1) is True
    assert b.cancel(1) is False
    fills = b.limit(o(3, Side.BUY, 100, 5))
    assert [f.maker_id for f in fills] == [2]


def test_cancelling_last_order_clears_the_level():
    b = Book()
    b.limit(o(1, Side.BUY, 99, 5))
    b.cancel(1)
    assert b.best_bid() is None
    assert b.qty_at(Side.BUY, 99) == 0


def test_level_can_be_recreated_after_being_emptied():
    """Lazy heap deletion must not lose a price that comes back."""
    b = Book()
    b.limit(o(1, Side.BUY, 99, 5))
    b.cancel(1)
    b.limit(o(2, Side.BUY, 99, 7))
    assert b.best_bid() == 99
    assert b.qty_at(Side.BUY, 99) == 7


def test_cancel_agent_pulls_only_that_agents_orders():
    b = Book()
    b.limit(o(1, Side.BUY, 99, 5, agent="mm"))
    b.limit(o(2, Side.SELL, 101, 5, agent="mm"))
    b.limit(o(3, Side.BUY, 98, 5, agent="noise"))
    assert b.cancel_agent("mm") == 2
    assert b.best_bid() == 98 and b.best_ask() is None


def test_duplicate_order_id_rejected():
    b = Book()
    b.limit(o(1, Side.BUY, 99, 5))
    with pytest.raises(ValueError, match="duplicate"):
        b.limit(o(1, Side.BUY, 98, 5))


def test_nonpositive_quantity_rejected():
    with pytest.raises(ValueError, match="positive"):
        Order(1, Side.BUY, 100, 0)


def test_depth_is_ordered_best_first():
    b = Book()
    for i, p in enumerate((97, 99, 98)):
        b.limit(o(i, Side.BUY, p, 10))
    for i, p in enumerate((103, 101, 102), start=10):
        b.limit(o(i, Side.SELL, p, 10))
    assert b.depth(Side.BUY, 3) == [(99, 10), (98, 10), (97, 10)]
    assert b.depth(Side.SELL, 3) == [(101, 10), (102, 10), (103, 10)]


def test_conservation_under_random_flow():
    """Whatever the flow, every share bought is a share sold and the book is
    never left crossed."""
    import random

    rng = random.Random(7)
    b = Book()
    oid = 0
    for _ in range(4000):
        oid += 1
        side = rng.choice([Side.BUY, Side.SELL])
        price = rng.randint(95, 105)
        qty = rng.randint(1, 20)
        if rng.random() < 0.15 and b._orders:
            b.cancel(rng.choice(list(b._orders)))
            continue
        b.limit(Order(oid, side, price, qty, ts=oid))
        assert not b.is_crossed()

    bought = sum(t.qty for t in b.trades)
    resting = sum(o.remaining for o in b._orders.values())
    submitted = sum(o.qty for o in b._orders.values())
    assert bought > 0
    assert resting <= submitted
    # every trade has a distinct maker and taker
    assert all(t.maker_id != t.taker_id for t in b.trades)


def test_post_only_never_takes_liquidity():
    b = Book()
    b.limit(o(1, Side.SELL, 100, 10))
    posted = o(2, Side.BUY, 105, 10)          # would cross
    assert b.post(posted) is True
    assert b.trades == []                      # nothing executed
    assert posted.price == 99                  # slid to just inside the ask
    assert b.best_bid() == 99 and b.best_ask() == 100


def test_post_only_leaves_a_non_crossing_price_alone():
    b = Book()
    b.limit(o(1, Side.SELL, 100, 10))
    order = o(2, Side.BUY, 97, 10)
    assert b.post(order) is True
    assert order.price == 97


def test_post_only_on_an_empty_side_rests_as_given():
    b = Book()
    order = o(1, Side.BUY, 99, 10)
    assert b.post(order) is True
    assert order.price == 99


def test_post_only_refuses_a_nonpositive_price():
    b = Book()
    b.limit(o(1, Side.SELL, 1, 10))
    assert b.post(o(2, Side.BUY, 5, 10)) is False   # would reprice to 0
    assert len(b) == 1
