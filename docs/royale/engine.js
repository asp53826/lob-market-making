// Order Book Royale: the exchange, the crowd, the bots and the rules.
//
// Deterministic by construction. A round is fully described by
// (seed, roster, intent log): replay() re-runs it and must land on the same
// equity for every player, to the cent, in any browser. That is why nothing
// here calls Math.sin, Math.cos, Math.log or Math.exp: those are not
// correctly rounded and differ between JavaScript engines in the last bit,
// which is enough for a replay on Safari to disagree with a game played on
// Chrome. Randomness uses only integer ops, + and *, and Math.sqrt, which
// IEEE 754 does pin down.

import { BUY, Book, Order, SELL, opposite } from "./book.js";

// ---------------------------------------------------------------------------
// units and rules
// ---------------------------------------------------------------------------

export const TICK = 0.05;           // dollars per price tick
export const LOT = 100;             // shares per lot; quantities are in lots
export const DPT = TICK * LOT;      // dollars per tick per lot = 5
export const START_TICK = 2000;     // $100.00
export const STEPS_PER_SEC = 5;
export const ROUND_STEPS = 240 * STEPS_PER_SEC;
export const WARMUP = 60;
export const START_CASH = 1_000_000;
export const MAX_POS = 400;         // lots: 40,000 shares, $4M at $100, four times equity
export const MAX_ORDER = 50;        // lots per order
export const MAX_OPEN = 10;         // resting orders per player
export const SEATS = 8;
export const BUST_FLOOR = 800_000;
export const BUST_FINAL = 950_000;
export const ENGINE_VERSION = 1;

/** The margin line rises after the first quarter: the circle closing. */
export function bustLine(k, T = ROUND_STEPS) {
  const q = T * 0.25;
  if (k <= q) return BUST_FLOOR;
  return BUST_FLOOR + (BUST_FINAL - BUST_FLOOR) * Math.min(1, (k - q) / (T - q));
}

// ---------------------------------------------------------------------------
// randomness that replays identically everywhere
// ---------------------------------------------------------------------------

export function hash32(s) {
  let h = 0x811c9dc5;
  for (const c of String(s)) h = Math.imul(h ^ c.codePointAt(0), 0x01000193) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0; h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0; h ^= h >>> 16;
  return h >>> 0;
}

export class Rng {
  constructor(seed) { this.s = hash32(seed) || 1; }
  random() {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Approximately N(mu, sd): Irwin-Hall with 12 uniforms. Only + and *. */
  gauss(mu = 0, sd = 1) {
    let s = 0;
    for (let i = 0; i < 12; i++) s += this.random();
    return mu + (s - 6) * sd;
  }
  randint(a, b) { return a + Math.floor(this.random() * (b - a + 1)); }
  choice(arr) { return arr[Math.floor(this.random() * arr.length)]; }
}

// ---------------------------------------------------------------------------
// the crowd (src/lob/flow.py)
// ---------------------------------------------------------------------------

export class EfficientPrice {
  constructor(rng, { start = START_TICK, sigma = 1.2, jumpProb = 0.001, jumpSize = 20 } = {}) {
    Object.assign(this, { rng, value: start, sigma, jumpProb, jumpSize });
  }
  step() {
    this.value += this.rng.gauss(0, this.sigma);
    if (this.rng.random() < this.jumpProb) this.value += this.rng.gauss(0, this.jumpSize);
    return this.value;
  }
}

class NoiseTrader {
  constructor(rng, rate = 0.55, size = [1, 12]) { Object.assign(this, { rng, rate, size, name: "noise" }); }
  act(book, fair, ts, ids) {
    if (this.rng.random() > this.rate) return;
    const side = this.rng.random() < 0.5 ? BUY : SELL;
    book.market(new Order(ids(), side, 0, this.rng.randint(...this.size), ts, this.name));
  }
}

/** Sees the efficient price and takes any quote on the wrong side of it,
 *  players' quotes included. This is what makes a stale bid expensive. */
class InformedTrader {
  constructor(rng, rate = 0.18, edge = 1.0, size = [1, 15]) { Object.assign(this, { rng, rate, edge, size, name: "informed" }); }
  act(book, fair, ts, ids) {
    if (this.rng.random() > this.rate) return;
    const v = fair.value, ask = book.bestAsk(), bid = book.bestBid();
    const qty = this.rng.randint(...this.size);
    if (ask !== null && ask < v - this.edge) book.market(new Order(ids(), BUY, 0, qty, ts, this.name));
    else if (bid !== null && bid > v + this.edge) book.market(new Order(ids(), SELL, 0, qty, ts, this.name));
  }
}

class BackgroundLP {
  constructor(rng, { rate = 0.9, depth = 4, offset = [1, 6], size = [5, 40], cancelRate = 0.25 } = {}) {
    Object.assign(this, { rng, rate, depth, offset, size, cancelRate, name: "lp", mine: [] });
  }
  act(book, fair, ts, ids) {
    this.mine = this.mine.filter((i) => book.orders.has(i));
    for (const oid of [...this.mine]) {
      if (this.rng.random() < this.cancelRate) {
        book.cancel(oid);
        this.mine.splice(this.mine.indexOf(oid), 1);
      }
    }
    if (this.rng.random() > this.rate) return;
    const anchor = fair.value + this.rng.gauss(0, 2.0);
    const n = this.rng.randint(1, this.depth);
    for (let i = 0; i < n; i++) {
      const side = this.rng.random() < 0.5 ? BUY : SELL;
      const off = this.rng.randint(...this.offset);
      const price = Math.round(side === BUY ? anchor - off : anchor + off);
      const oid = ids();
      book.limit(new Order(oid, side, price, this.rng.randint(...this.size), ts, this.name));
      if (book.orders.has(oid)) this.mine.push(oid);
    }
  }
}

// ---------------------------------------------------------------------------
// bot players (src/lob/strategies.py, plus two takers)
// ---------------------------------------------------------------------------

class MarketMakerBot {
  constructor(agent, rng, { size = 10, maxInventory = 200 } = {}) {
    Object.assign(this, { agent, rng, size, maxInventory, inventory: 0, mids: [] });
  }
  observe(book) {
    const m = book.mid();
    if (m !== null) { this.mids.push(m); if (this.mids.length > 250) this.mids.shift(); }
    return m;
  }
  volatility() {
    if (this.mids.length < 20) return 1.0;
    const d = [];
    for (let i = 1; i < this.mids.length; i++) d.push(this.mids[i] - this.mids[i - 1]);
    const mu = d.reduce((a, b) => a + b, 0) / d.length;
    const v = d.reduce((a, x) => a + (x - mu) ** 2, 0) / Math.max(d.length - 1, 1);
    return Math.max(Math.sqrt(v), 1e-6);
  }
  act(book, ts, ids, ctx) {
    book.cancelAgent(this.agent);
    this.observe(book);
    let [bid, ask] = this.desired(book, ts, ctx);
    if (bid !== null && ask !== null && bid >= ask) ask = bid + 1;
    if (bid !== null && this.inventory < this.maxInventory) book.post(new Order(ids(), BUY, bid, this.size, ts, this.agent));
    if (ask !== null && this.inventory > -this.maxInventory) book.post(new Order(ids(), SELL, ask, this.size, ts, this.agent));
  }
}

/** Symmetric fixed spread around mid, ignoring inventory. */
class NaiveBot extends MarketMakerBot {
  constructor(agent, rng, half = 2) { super(agent, rng); this.half = half; }
  desired(book) {
    const m = book.mid();
    if (m === null) return [null, null];
    return [Math.trunc(m - this.half), Math.ceil(m + this.half)];
  }
}

/** Fixed spread, shifted against the position. */
class SkewBot extends MarketMakerBot {
  constructor(agent, rng, half = 2, skew = 0.03) { super(agent, rng); Object.assign(this, { half, skew }); }
  desired(book) {
    const m = book.mid();
    if (m === null) return [null, null];
    const r = m - this.skew * this.inventory;
    return [Math.floor(r - this.half), Math.ceil(r + this.half)];
  }
}

/** Avellaneda-Stoikov with the calibration the README found profitable
 *  (gamma 0.1, k 0.3). (2/gamma) ln(1 + gamma/k) is a constant, written out
 *  so no engine-dependent log is evaluated at run time. */
const AS_GAMMA = 0.1, AS_SPREAD_TERM = 5.753641449035619;   // (2/0.1) * ln(1 + 0.1/0.3)
class ASBot extends MarketMakerBot {
  desired(book, ts, ctx) {
    const s = book.mid();
    if (s === null) return [null, null];
    const sigma = this.volatility();
    const tLeft = Math.max(1 - ts / ctx.T, 1e-3);
    const r = s - this.inventory * AS_GAMMA * sigma * sigma * tLeft;
    const half = Math.max((AS_GAMMA * sigma * sigma * tLeft + AS_SPREAD_TERM) / 2, 1);
    return [Math.floor(r - half), Math.ceil(r + half)];
  }
}

/** Chases moves. Buys strength, sells weakness, gets caught by reversals. */
class MomentumBot {
  constructor(agent, rng) { Object.assign(this, { agent, rng, mids: [], inventory: 0, peak: null, held: 0 }); }
  act(book, ts, ids) {
    const m = book.mid();
    if (m === null) return;
    this.mids.push(m);
    if (this.mids.length > 12) this.mids.shift();
    if (this.inventory === 0) {
      if (this.mids.length < 12) return;
      const move = m - this.mids[0];
      if (Math.abs(move) >= 6 && this.rng.random() < 0.5) {
        book.market(new Order(ids(), move > 0 ? BUY : SELL, 0, 30, ts, this.agent));
        this.peak = m; this.held = 0;
      }
      return;
    }
    this.held++;
    const dir = Math.sign(this.inventory);
    this.peak = dir > 0 ? Math.max(this.peak, m) : Math.min(this.peak, m);
    if ((this.peak - m) * dir >= 4 || this.held > 80)
      book.market(new Order(ids(), dir > 0 ? SELL : BUY, 0, Math.abs(this.inventory), ts, this.agent));
  }
}

/** Trades its hints hard, quotes a wide market otherwise. */
class SharkBot extends SkewBot {
  constructor(agent, rng) { super(agent, rng, 4, 0.05); }
  act(book, ts, ids, ctx) {
    const h = ctx.hintFor(this.agent);
    if (h && ts < h.hit) {
      book.cancelAgent(this.agent);
      const target = 70 * h.dir;
      const need = target - this.inventory;
      if (Math.sign(need) === h.dir) book.market(new Order(ids(), h.dir > 0 ? BUY : SELL, 0, Math.min(25, Math.abs(need)), ts, this.agent));
      return;
    }
    if (h && ts >= h.hit && ts < h.hit + 25 && this.inventory !== 0) {
      book.cancelAgent(this.agent);
      if (ts >= h.hit + 6) book.market(new Order(ids(), this.inventory > 0 ? SELL : BUY, 0, Math.min(30, Math.abs(this.inventory)), ts, this.agent));
      return;
    }
    super.act(book, ts, ids, ctx);
  }
}

export const BOT_TYPES = {
  skew: { name: "SKEW", blurb: "inventory-skewed maker, half-spread 2", make: (a, r) => new SkewBot(a, r) },
  as: { name: "A-S", blurb: "Avellaneda-Stoikov, gamma 0.1, k 0.3", make: (a, r) => new ASBot(a, r) },
  momo: { name: "MOMO", blurb: "chases moves, cuts on reversals", make: (a, r) => new MomentumBot(a, r) },
  shark: { name: "SHARK", blurb: "trades its hints, quotes wide otherwise", make: (a, r) => new SharkBot(a, r) },
  naive: { name: "NAIVE", blurb: "fixed spread, ignores inventory", make: (a, r) => new NaiveBot(a, r) },
};
export const BOT_FILL = ["skew", "as", "momo", "shark", "naive", "skew", "momo", "as"];

/** Seat bots in the empty chairs. */
export function fillRoster(humans, seats = SEATS) {
  const roster = humans.map((h, i) => ({ pid: i, kind: "human", name: String(h.name || `Player ${i + 1}`).slice(0, 18), key: h.key ?? null }));
  const used = {};
  for (let i = 0; roster.length < seats; i++) {
    const t = BOT_FILL[i % BOT_FILL.length];
    used[t] = (used[t] || 0) + 1;
    roster.push({ pid: roster.length, kind: "bot", bot: t, name: BOT_TYPES[t].name + (used[t] > 1 ? " II" : "") });
  }
  return roster;
}

// ---------------------------------------------------------------------------
// news
// ---------------------------------------------------------------------------

const HEADLINES = ["Earnings", "FDA ruling", "Activist stake", "Guidance update", "Merger vote", "CEO interview", "Index rebalance", "Short report"];

function makeNews(rng, T) {
  const lead = Math.round(T * 0.0625);          // 15 s of warning in a 4-minute round
  const names = [...HEADLINES];
  return [0.2, 0.42, 0.64, 0.86].map((f, i) => {
    const hit = Math.round(T * f + rng.randint(-Math.round(T * 0.03), Math.round(T * 0.03)));
    const dir = rng.random() < 0.5 ? -1 : 1;
    const size = rng.randint(30, 90);
    const name = names.splice(Math.floor(rng.random() * names.length), 1)[0];
    return { i, name, hit, announce: hit - lead, jump: dir * size, dir, lo: Math.floor(size * 0.7), hi: Math.ceil(size * 1.3), hinted: [] };
  });
}

// ---------------------------------------------------------------------------
// the round
// ---------------------------------------------------------------------------

export class Royale {
  /**
   * @param seed   any string; the whole market follows from it
   * @param roster [{pid, kind, name, bot?}] in seat order
   */
  constructor(seed, roster, { steps = ROUND_STEPS } = {}) {
    this.seed = String(seed);
    this.T = steps;
    this.roster = roster.map((r) => ({ ...r }));
    const R = (tag) => new Rng(`${this.seed}/${tag}`);
    this.book = new Book();
    let next = 1;
    this.ids = () => next++;
    this.fair = new EfficientPrice(R("fair"));
    this.lp = new BackgroundLP(R("lp"));
    this.noise = new NoiseTrader(R("noise"));
    this.informed = new InformedTrader(R("informed"));
    this.newsRng = R("news");
    this.news = makeNews(this.newsRng, this.T);
    this.players = this.roster.map((r) => ({
      pid: r.pid, name: r.name, kind: r.kind, bot: r.bot || null,
      agent: `p${r.pid}`, cash: START_CASH, pos: 0, alive: true, bustK: null, final: null,
      fills: 0, volume: 0, edge: 0, hints: [], rejects: 0,
    }));
    this.byAgent = new Map(this.players.map((p) => [p.agent, p]));
    this.bots = new Map();
    for (const r of this.roster) if (r.kind === "bot") this.bots.set(r.pid, BOT_TYPES[r.bot].make(`p${r.pid}`, R(`bot${r.pid}`)));
    this.k = 0;
    this.queue = [];
    this.log = [];
    this.tradeCursor = 0;
    this.lastPrice = START_TICK;
    this.mids = [];
    this.fairs = [];
    this.events = [];
    this.over = false;
    this.ctx = { T: this.T, hintFor: (agent) => this.activeHint(agent) };

    // let a book form before anyone can trade
    for (let w = 0; w < WARMUP; w++) {
      this.fair.step();
      this.lp.act(this.book, this.fair, -1, this.ids);
      this.noise.act(this.book, this.fair, -1, this.ids);
      this.informed.act(this.book, this.fair, -1, this.ids);
    }
    this.tradeCursor = this.book.trades.length;
    this.mids.push(this.mark());
    this.fairs.push(this.fair.value);
  }

  mark() {
    const m = this.book.mid();
    return m !== null ? m : this.lastPrice;
  }

  equity(p, mark = this.mark()) {
    return p.cash + p.pos * mark * DPT;
  }

  activeHint(agent) {
    const p = this.byAgent.get(agent);
    if (!p) return null;
    return this.news.find((n) => n.hinted.includes(p.pid) && this.k >= n.announce && this.k < n.hit + 25) || null;
  }

  // ---- intents ------------------------------------------------------------

  /** Queue a player's intent for the next step. Applied in arrival order. */
  submit(pid, intent) {
    if (this.over) return;
    this.queue.push([pid, intent]);
  }

  _apply(pid, intent) {
    const p = this.players[pid];
    this.log.push([this.k, pid, intent]);
    if (!p || !p.alive || !Array.isArray(intent)) return this._reject(p, "out");
    const [type, a, b, c] = intent;
    const mine = () => this.book.ordersOf(p.agent);
    if (type === "C") {
      const o = this.book.orders.get(a);
      if (!o || o.agent !== p.agent) return this._reject(p, "not yours");
      this.book.cancel(a);
      return;
    }
    if (type === "X") { this.book.cancelAgent(p.agent); return; }
    const side = type === "M" ? a : a;
    const qty = type === "M" ? b : c;
    if (side !== BUY && side !== SELL) return this._reject(p, "side");
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_ORDER) return this._reject(p, "size");
    const open = mine();
    const sameSide = open.filter((o) => o.side === side).reduce((s, o) => s + o.remaining, 0);
    if (side === BUY ? p.pos + sameSide + qty > MAX_POS : p.pos - sameSide - qty < -MAX_POS) return this._reject(p, "position limit");
    if (type === "L") {
      const price = b;
      const ref = this.mark();
      if (!Number.isInteger(price) || price <= 0 || Math.abs(price - ref) > 200) return this._reject(p, "price");
      if (open.length >= MAX_OPEN) return this._reject(p, "too many orders");
      // self-trade prevention: pull our own orders this one would cross
      for (const o of open) if (o.side === opposite(side) && (side === BUY ? o.price <= price : o.price >= price)) this.book.cancel(o.id);
      this.book.limit(new Order(this.ids(), side, price, qty, this.k, p.agent));
    } else if (type === "M") {
      for (const o of open) if (o.side === opposite(side)) this.book.cancel(o.id);
      this.book.market(new Order(this.ids(), side, 0, qty, this.k, p.agent));
    } else {
      return this._reject(p, "type");
    }
  }

  _reject(p, why) {
    if (p) p.rejects++;
    this.events.push({ k: this.k, kind: "reject", pid: p ? p.pid : -1, why });
  }

  // ---- the clock ----------------------------------------------------------

  step() {
    if (this.over) return;
    const k = this.k;
    for (const [pid, intent] of this.queue.splice(0)) this._apply(pid, intent);
    this._settleTrades();

    this.fair.step();
    for (const n of this.news) {
      if (n.announce === k) {
        const alive = this.players.filter((p) => p.alive);
        const count = alive.length > 4 ? 2 : 1;
        const pool = [...alive];
        for (let i = 0; i < count && pool.length; i++) {
          const pick = pool.splice(Math.floor(this.newsRng.random() * pool.length), 1)[0];
          n.hinted.push(pick.pid);
          pick.hints.push(n.i);
        }
        this.events.push({ k, kind: "announce", news: n.i });
      }
      if (n.hit === k) {
        this.fair.value += n.jump;
        this.events.push({ k, kind: "hit", news: n.i });
      }
    }
    this.lp.act(this.book, this.fair, k, this.ids);
    for (const [pid, bot] of this.bots) {
      const p = this.players[pid];
      if (!p.alive) continue;
      bot.inventory = p.pos;
      bot.act(this.book, k, this.ids, this.ctx);
      this._settleTrades();
    }
    this.noise.act(this.book, this.fair, k, this.ids);
    this.informed.act(this.book, this.fair, k, this.ids);
    this._settleTrades();
    this._margin();

    this.k = k + 1;
    this.mids.push(this.mark());
    this.fairs.push(this.fair.value);
    if (this.k >= this.T) this._close();
  }

  _settleTrades() {
    const trades = this.book.trades;
    for (; this.tradeCursor < trades.length; this.tradeCursor++) {
      const t = trades[this.tradeCursor];
      this.lastPrice = t.price;
      const maker = this.byAgent.get(t.makerAgent), taker = this.byAgent.get(t.takerAgent);
      if (maker) this._fill(maker, opposite(t.aggressor), t.price, t.qty);
      if (taker) this._fill(taker, t.aggressor, t.price, t.qty);
    }
  }

  _fill(p, side, price, qty) {
    p.pos += side * qty;
    p.cash -= side * price * qty * DPT;
    p.fills++;
    p.volume += qty;
    // realised edge against the efficient price at the moment of the fill:
    // something a player can only learn after the round, as in the README
    p.edge += side * (this.fair.value - price) * qty;
  }

  _margin() {
    const mark = this.mark();
    const line = bustLine(this.k, this.T);
    for (const p of this.players) {
      if (!p.alive || this.equity(p, mark) >= line) continue;
      // margin call: pull everything, close at market, out
      this.book.cancelAgent(p.agent);
      if (p.pos !== 0) this.book.market(new Order(this.ids(), p.pos > 0 ? SELL : BUY, 0, Math.abs(p.pos), this.k, p.agent));
      this._settleTrades();
      p.alive = false;
      p.bustK = this.k;
      p.final = this.equity(p, this.mark());
      this.events.push({ k: this.k, kind: "bust", pid: p.pid });
    }
  }

  _close() {
    this.over = true;
    for (const p of this.players) {
      if (!p.alive) continue;
      this.book.cancelAgent(p.agent);
      // the bell settles everyone at the efficient price, not the last print
      p.final = p.cash + p.pos * this.fair.value * DPT;
    }
    this.events.push({ k: this.k, kind: "close" });
  }

  /** Final ranking: survivors by equity, then the busted, latest bust first. */
  standings() {
    const live = (p) => (this.over ? p.final : this.equity(p));
    return [...this.players].sort((a, b) => {
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      if (!a.alive && a.bustK !== b.bustK) return b.bustK - a.bustK;
      return live(b) - live(a);
    });
  }

  // ---- views --------------------------------------------------------------

  /** Book levels with who is in them: [[price, total, [[pid|-1, qty], ...]], ...] */
  ladder(n = 14) {
    const side = (s) => this.book.depth(s, n).map(([price]) => {
      const owners = new Map();
      for (const o of this.book.level(s, price)) {
        const p = this.byAgent.get(o.agent);
        const id = p ? p.pid : -1;
        owners.set(id, (owners.get(id) || 0) + o.remaining);
      }
      const total = [...owners.values()].reduce((a, b) => a + b, 0);
      return [price, total, [...owners.entries()]];
    });
    return { bids: side(BUY), asks: side(SELL) };
  }

  openOrders(pid) {
    const p = this.players[pid];
    return p ? this.book.ordersOf(p.agent).map((o) => [o.id, o.side, o.price, o.remaining]) : [];
  }
}

/** Re-run a round from its seed, roster and intent log. */
export function replay(seed, roster, log, { steps = ROUND_STEPS } = {}) {
  const g = new Royale(seed, roster, { steps });
  const byStep = new Map();
  for (const e of Array.isArray(log) ? log : []) {
    if (!Array.isArray(e) || !Number.isInteger(e[0]) || !Number.isInteger(e[1])) continue;
    if (!byStep.has(e[0])) byStep.set(e[0], []);
    byStep.get(e[0]).push(e);
  }
  while (!g.over) {
    for (const [, pid, intent] of byStep.get(g.k) || []) g.submit(pid, intent);
    g.step();
  }
  return g;
}
