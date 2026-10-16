"""Write golden.json: a random workload through src/lob/book.py, recorded op by op.

    uv run python tests/js/make_golden.py

The JS port in docs/royale/book.js must reproduce every trade and every top of
book. CI regenerates this file and fails if it differs from the committed copy.
"""

import json
import random
from pathlib import Path

from lob.book import Book, Order, Side


def main():
    rng = random.Random(20261016)
    book = Book()
    ops, next_id, live = [], 1, []
    agents = ["a", "b", "c", "lp"]
    for _ in range(4000):
        r = rng.random()
        mid = book.mid() or 2000
        if r < 0.40:
            op = ["limit", next_id, rng.choice([1, -1]), int(mid + rng.randint(-8, 8)), rng.randint(1, 30), rng.choice(agents)]
        elif r < 0.60:
            op = ["post", next_id, rng.choice([1, -1]), int(mid + rng.randint(-6, 6)), rng.randint(1, 30), rng.choice(agents)]
        elif r < 0.78:
            op = ["market", next_id, rng.choice([1, -1]), 0, rng.randint(1, 60), rng.choice(agents)]
        elif r < 0.95 and live:
            op = ["cancel", rng.choice(live)]
        else:
            op = ["cancel_agent", rng.choice(agents)]

        before = len(book.trades)
        if op[0] in ("limit", "post", "market"):
            o = Order(op[1], Side(op[2]), op[3], op[4], len(ops), op[5])
            next_id += 1
            if op[0] == "limit":
                book.limit(o)
            elif op[0] == "post":
                ok = book.post(o)
                op.append(ok)
                op.append(o.price)
            else:
                book.market(o)
            if o.id in book._orders:
                live.append(o.id)
        elif op[0] == "cancel":
            op.append(book.cancel(op[1]))
        else:
            op.append(book.cancel_agent(op[1]))
        live = [i for i in live if i in book._orders]

        trades = [[t.price, t.qty, int(t.aggressor), t.maker_id, t.taker_id] for t in book.trades[before:]]
        ops.append({"op": op, "trades": trades, "bid": book.best_bid(), "ask": book.best_ask(), "n": len(book),
                    "depth": [book.depth(Side.BUY, 3), book.depth(Side.SELL, 3)]})

    path = Path(__file__).with_name("golden.json")
    path.write_text(json.dumps(ops, separators=(",", ":")) + "\n")
    print(f"wrote {path} ({len(ops)} ops, {len(book.trades)} trades)")


if __name__ == "__main__":
    main()
