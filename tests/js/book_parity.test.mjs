// docs/royale/book.js against src/lob/book.py, op by op.
//
//   node --test tests/js/

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { Book, Order } from "../../docs/royale/book.js";

const golden = JSON.parse(readFileSync(new URL("./golden.json", import.meta.url)));

test("4,000 random operations: identical trades, top of book and depth", () => {
  const book = new Book();
  golden.forEach((g, i) => {
    const [kind, ...a] = g.op;
    const before = book.trades.length;
    if (kind === "limit" || kind === "post" || kind === "market") {
      const o = new Order(a[0], a[1], a[2], a[3], i, a[4]);
      if (kind === "limit") book.limit(o);
      else if (kind === "market") book.market(o);
      else {
        assert.equal(book.post(o), a[5], `op ${i}: post result`);
        assert.equal(o.price, a[6], `op ${i}: post repricing`);
      }
    } else if (kind === "cancel") {
      assert.equal(book.cancel(a[0]), a[1], `op ${i}: cancel`);
    } else {
      assert.equal(book.cancelAgent(a[0]), a[1], `op ${i}: cancel_agent`);
    }
    const trades = book.trades.slice(before).map((t) => [t.price, t.qty, t.aggressor, t.makerId, t.takerId]);
    assert.deepEqual(trades, g.trades, `op ${i}: trades`);
    assert.equal(book.bestBid(), g.bid, `op ${i}: best bid`);
    assert.equal(book.bestAsk(), g.ask, `op ${i}: best ask`);
    assert.equal(book.size, g.n, `op ${i}: resting count`);
    assert.deepEqual([book.depth(1, 3), book.depth(-1, 3)], g.depth, `op ${i}: depth`);
    assert.ok(!book.isCrossed(), `op ${i}: book crossed`);
  });
  assert.ok(book.trades.length > 1000, "the workload should actually trade");
});

test("duplicate ids are refused, as in Python", () => {
  const b = new Book();
  b.limit(new Order(1, 1, 99, 5));
  assert.throws(() => b.limit(new Order(1, 1, 98, 5)));
  assert.throws(() => b.post(new Order(1, -1, 101, 5)));
});

test("non-positive quantity is refused", () => {
  assert.throws(() => new Order(1, 1, 100, 0));
});
