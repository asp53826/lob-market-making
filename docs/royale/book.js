// A port of src/lob/book.py: price-time priority on integer ticks.
//
// The game's exchange runs on this, so it has to behave exactly like the
// Python book, not approximately: tests/js/book_parity.test.mjs replays a
// few thousand random operations through both and compares every trade and
// every top of book. Internals differ (sorted price lists instead of lazy
// heaps); behaviour does not.

export const BUY = 1;
export const SELL = -1;
export const opposite = (side) => -side;

export class Order {
  constructor(id, side, price, qty, ts = 0, agent = "") {
    if (!(qty > 0)) throw new RangeError(`order ${id}: qty must be positive, got ${qty}`);
    this.id = id;
    this.side = side;
    this.price = price;
    this.qty = qty;
    this.ts = ts;
    this.agent = agent;
    this.remaining = qty;
  }
  get filled() { return this.qty - this.remaining; }
}

// insert into an ascending array, no duplicates
function insertSorted(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; }
  if (arr[lo] !== x) arr.splice(lo, 0, x);
}
function removeSorted(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; }
  if (arr[lo] === x) arr.splice(lo, 1);
}

export class Book {
  constructor() {
    this.levels = new Map();      // `${side}:${price}` -> Order[] (FIFO)
    this.orders = new Map();      // id -> Order, insertion ordered
    this.bidPrices = [];          // ascending; best bid is the last
    this.askPrices = [];          // ascending; best ask is the first
    this.trades = [];
  }

  // ---- inspection ---------------------------------------------------------

  bestBid() { return this.bidPrices.length ? this.bidPrices[this.bidPrices.length - 1] : null; }
  bestAsk() { return this.askPrices.length ? this.askPrices[0] : null; }
  best(side) { return side === BUY ? this.bestBid() : this.bestAsk(); }

  mid() {
    const b = this.bestBid(), a = this.bestAsk();
    return b !== null && a !== null ? (b + a) / 2 : null;
  }

  spread() {
    const b = this.bestBid(), a = this.bestAsk();
    return b !== null && a !== null ? a - b : null;
  }

  level(side, price) { return this.levels.get(`${side}:${price}`) || null; }

  qtyAt(side, price) {
    const l = this.level(side, price);
    return l ? l.reduce((s, o) => s + o.remaining, 0) : 0;
  }

  depth(side, n = 5) {
    const ps = side === BUY ? [...this.bidPrices].reverse() : this.askPrices;
    return ps.slice(0, n).map((p) => [p, this.qtyAt(side, p)]);
  }

  get size() { return this.orders.size; }

  isCrossed() {
    const b = this.bestBid(), a = this.bestAsk();
    return b !== null && a !== null && b >= a;
  }

  // ---- mutation -----------------------------------------------------------

  _rest(order) {
    const key = `${order.side}:${order.price}`;
    let l = this.levels.get(key);
    if (!l) {
      l = [];
      this.levels.set(key, l);
      insertSorted(order.side === BUY ? this.bidPrices : this.askPrices, order.price);
    }
    l.push(order);
    this.orders.set(order.id, order);
  }

  _dropLevel(side, price) {
    this.levels.delete(`${side}:${price}`);
    removeSorted(side === BUY ? this.bidPrices : this.askPrices, price);
  }

  /** Submit a limit order. Marketable portions execute, the rest rests. */
  limit(order) {
    if (this.orders.has(order.id)) throw new Error(`duplicate order id ${order.id}`);
    const fills = this._match(order, order.price);
    if (order.remaining) this._rest(order);
    return fills;
  }

  /** Post-only: never takes liquidity. Repriced to the most aggressive
   *  non-crossing level rather than rejected; false if none exists. */
  post(order) {
    if (this.orders.has(order.id)) throw new Error(`duplicate order id ${order.id}`);
    const contra = this.best(opposite(order.side));
    if (contra !== null) {
      if (order.side === BUY && order.price >= contra) order.price = contra - 1;
      else if (order.side === SELL && order.price <= contra) order.price = contra + 1;
    }
    if (order.price <= 0) return false;
    this._rest(order);
    return true;
  }

  /** Execute against resting liquidity; any unfilled remainder is dropped. */
  market(order) {
    return this._match(order, null);
  }

  _match(taker, limitPrice) {
    const fills = [];
    const contra = opposite(taker.side);
    while (taker.remaining) {
      const best = this.best(contra);
      if (best === null) break;
      if (limitPrice !== null && !(taker.side === BUY ? limitPrice >= best : limitPrice <= best)) break;
      const level = this.levels.get(`${contra}:${best}`);
      while (level.length && taker.remaining) {
        const maker = level[0];
        const qty = Math.min(maker.remaining, taker.remaining);
        // the resting order sets the price: that is where a maker's edge lives
        const t = { ts: taker.ts, price: best, qty, aggressor: taker.side, makerId: maker.id, takerId: taker.id,
                    makerAgent: maker.agent, takerAgent: taker.agent };
        fills.push(t);
        this.trades.push(t);
        maker.remaining -= qty;
        taker.remaining -= qty;
        if (!maker.remaining) {
          level.shift();
          this.orders.delete(maker.id);
        }
      }
      if (!level.length) this._dropLevel(contra, best);
    }
    return fills;
  }

  cancel(id) {
    const o = this.orders.get(id);
    if (!o) return false;
    this.orders.delete(id);
    const l = this.level(o.side, o.price);
    if (l) {
      const i = l.indexOf(o);
      if (i >= 0) l.splice(i, 1);
      if (!l.length) this._dropLevel(o.side, o.price);
    }
    return true;
  }

  /** Pull every resting order for one agent. */
  cancelAgent(agent) {
    const ids = [];
    for (const [id, o] of this.orders) if (o.agent === agent) ids.push(id);
    for (const id of ids) this.cancel(id);
    return ids.length;
  }

  ordersOf(agent) {
    const out = [];
    for (const o of this.orders.values()) if (o.agent === agent) out.push(o);
    return out;
  }
}
