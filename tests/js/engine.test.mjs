// The rules of Order Book Royale, and the replay guarantee the board relies on.

import assert from "node:assert/strict";
import test from "node:test";

import { BUY, SELL } from "../../docs/royale/book.js";
import {
  BUST_FLOOR, DPT, MAX_OPEN, MAX_ORDER, MAX_POS, ROUND_STEPS, Royale, START_CASH, bustLine, fillRoster, replay,
} from "../../docs/royale/engine.js";

const SHORT = { steps: 300 };
const run = (g, f = () => {}) => { while (!g.over) { f(g); g.step(); } return g; };

test("bots fill the empty seats, humans keep theirs", () => {
  const r = fillRoster([{ name: "Ada" }, { name: "Grace" }]);
  assert.equal(r.length, 8);
  assert.deepEqual(r.slice(0, 2).map((x) => [x.pid, x.kind, x.name]), [[0, "human", "Ada"], [1, "human", "Grace"]]);
  assert.ok(r.slice(2).every((x) => x.kind === "bot"));
  assert.equal(new Set(r.map((x) => x.name)).size, 8, "seat names are unique");
});

test("the same seed is the same market", () => {
  const a = run(new Royale("s", fillRoster([]), SHORT)), b = run(new Royale("s", fillRoster([]), SHORT));
  assert.deepEqual(a.mids, b.mids);
  assert.deepEqual(a.players.map((p) => p.final), b.players.map((p) => p.final));
  const c = run(new Royale("t", fillRoster([]), SHORT));
  assert.notDeepEqual(a.mids, c.mids);
});

test("replay from the intent log reproduces every player to the cent", () => {
  const roster = fillRoster([{ name: "A" }, { name: "B" }]);
  const live = run(new Royale("replay", roster, SHORT), (g) => {
    if (g.k % 5 === 0) g.submit(0, ["M", g.k % 10 ? BUY : SELL, 7]);
    if (g.k % 9 === 0) g.submit(1, ["L", SELL, Math.round(g.mark()) + 1, 4]);
    if (g.k % 23 === 0) g.submit(1, ["X"]);
  });
  const again = replay("replay", roster, live.log, SHORT);
  assert.deepEqual(again.players.map((p) => [p.final, p.pos, p.cash, p.alive]), live.players.map((p) => [p.final, p.pos, p.cash, p.alive]));
  assert.deepEqual(again.mids, live.mids);
});

test("a forged log cannot trade for someone who is out, or break the limits", () => {
  const roster = fillRoster([{ name: "A" }], 2);
  const g = new Royale("limits", roster, SHORT);
  g.submit(0, ["M", BUY, MAX_ORDER + 1]);              // too big
  g.submit(0, ["L", BUY, 1, 5]);                       // absurd price
  g.submit(0, ["M", 3, 5]);                            // no such side
  g.submit(0, ["C", 999999]);                          // not my order
  g.submit(5, ["M", BUY, 5]);                          // no such player
  g.step();
  assert.equal(g.players[0].pos, 0);
  assert.equal(g.players[0].rejects, 4);
  for (let i = 0; i < MAX_OPEN + 3; i++) g.submit(0, ["L", BUY, Math.round(g.mark()) - 30 - i, 1]);
  g.step();
  assert.equal(g.openOrders(0).length, MAX_OPEN);
});

test("position limit counts resting orders, so it cannot be dodged", () => {
  const g = new Royale("pos", fillRoster([{ name: "A" }], 2), SHORT);
  const far = Math.round(g.mark()) - 60;
  for (let i = 0; i < 9; i++) g.submit(0, ["L", BUY, far - i, MAX_ORDER]);   // 450 lots resting
  g.step();
  const resting = g.openOrders(0).reduce((s, o) => s + o[3], 0);
  assert.ok(resting <= MAX_POS, `${resting} lots resting against a ${MAX_POS} limit`);
});

test("self-trade prevention: your market order pulls your own resting quote", () => {
  const g = new Royale("stp", fillRoster([{ name: "A" }], 1), SHORT);
  const ask = g.book.bestAsk();
  g.submit(0, ["L", SELL, ask - 1, 5]);
  g.step();
  g.submit(0, ["M", BUY, 5]);
  g.step();
  const self = g.book.trades.filter((t) => t.makerAgent === "p0" && t.takerAgent === "p0");
  assert.equal(self.length, 0);
});

test("accounting: cash and position move together, priced in ticks", () => {
  const g = new Royale("acct", fillRoster([{ name: "A" }], 1), SHORT);
  g.step();
  const before = g.book.trades.length;
  g.submit(0, ["M", BUY, 3]);
  g.step();
  const mine = g.book.trades.slice(before).filter((t) => t.takerAgent === "p0");
  const paid = mine.reduce((s, t) => s + t.price * t.qty * DPT, 0);
  assert.equal(g.players[0].pos, mine.reduce((s, t) => s + t.qty, 0));
  assert.equal(g.players[0].cash, START_CASH - paid);
});

test("the margin line rises, and a player under it is closed out and stays out", () => {
  assert.equal(bustLine(0), BUST_FLOOR);
  assert.ok(bustLine(ROUND_STEPS) > bustLine(ROUND_STEPS / 2));
  const g = new Royale("bust", fillRoster([{ name: "A" }], 1), SHORT);
  g.step();
  g.players[0].cash -= 300_000;          // force a margin call
  g.submit(0, ["M", BUY, 10]);
  g.step();
  assert.equal(g.players[0].alive, false);
  assert.equal(g.players[0].pos, 0, "closed out at market");
  g.submit(0, ["M", BUY, 10]);
  g.step();
  assert.equal(g.players[0].pos, 0, "no trading after the bust");
});

test("the bell settles survivors at the efficient price, not the last print", () => {
  const g = run(new Royale("bell", fillRoster([{ name: "A" }], 2), SHORT), (x) => { if (x.k === 3) x.submit(0, ["M", BUY, 20]); });
  const p = g.players[0];
  if (p.alive) assert.equal(p.final, p.cash + p.pos * g.fair.value * DPT);
});

test("news: announced ahead, hinted to someone alive, applied to the efficient price", () => {
  const g = new Royale("news", fillRoster([]), {});
  const n = g.news[0];
  assert.ok(n.announce < n.hit);
  while (g.k <= n.hit) g.step();
  assert.ok(n.hinted.length >= 1);
  assert.ok(n.hinted.every((pid) => g.players[pid].hints.includes(n.i)));
  assert.ok(g.events.some((e) => e.kind === "hit" && e.news === 0));
});

test("standings: survivors first by equity, then the busted, latest out first", () => {
  const g = run(new Royale("rank", fillRoster([]), SHORT));
  const s = g.standings();
  const firstOut = s.findIndex((p) => !p.alive);
  if (firstOut >= 0) assert.ok(s.slice(firstOut).every((p) => !p.alive));
  for (let i = 1; i < (firstOut < 0 ? s.length : firstOut); i++) assert.ok(s[i - 1].final >= s[i].final);
});
