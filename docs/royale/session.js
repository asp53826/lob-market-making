// Host and client sessions. No DOM in here: the UI subscribes to views.

import { BUST_FINAL, DPT, ENGINE_VERSION, ROUND_STEPS, Royale, STEPS_PER_SEC, START_CASH, bustLine, fillRoster, replay } from "./engine.js";
import { APP, PROTO, fit, keyPair, randomHex, seal, sealing, sha256hex, sharedKey, unseal } from "./net.js";

const STEP_MS = 1000 / STEPS_PER_SEC;
const COUNTDOWN = 3 * STEPS_PER_SEC;
const MAX_HUMANS = 8;

/** A steady clock that background tabs throttle less than setInterval. */
function ticker(ms, fn) {
  try {
    const src = `let t=setInterval(()=>postMessage(0),${ms});onmessage=()=>clearInterval(t)`;
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    w.onmessage = fn;
    return () => { w.postMessage(0); w.terminate(); };
  } catch {
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
  }
}

const cleanIntent = (x) => {
  if (!Array.isArray(x) || x.length > 4) return null;
  if (!["L", "M", "C", "X"].includes(x[0])) return null;
  return x.every((v, i) => (i === 0 ? typeof v === "string" : Number.isFinite(v))) ? x.slice() : null;
};

// ---------------------------------------------------------------------------
// host: runs the exchange
// ---------------------------------------------------------------------------

export class HostSession {
  constructor(transport, { name, steps = ROUND_STEPS, onView, onVerify }) {
    this.tx = transport;
    this.name = name;
    this.steps = steps;
    this.onView = onView;
    this.onVerify = onVerify;
    this.tbl = "t" + randomHex(3);
    this.phase = "lobby";
    this.seats = new Map();       // peer -> {peer, name, pk, since, by}
    this.since = Date.now();
    this.lastSeq = [];
    this.hx = [];
    this.trCursor = 0;
    this.evCursor = 0;
    this.hostPid = 0;
  }

  async open() {
    if (sealing) this.keys = await keyPair();
    if (this.tx) {
      this.tx.onPeers((peers) => this.ingest(peers));
      await this.announce();
      this.lobbyBeat = setInterval(() => this.phase === "lobby" && this.broadcast(), 1000);
    }
    this.broadcast();
  }

  announce() {
    if (!this.tx) return;
    return this.tx.setPresence({
      app: APP, v: PROTO, role: "host", tbl: this.tbl, name: this.name, st: this.phase,
      n: this.phase === "lobby" ? 1 + this.seats.size : this.roster.filter((r) => r.kind === "human").length,
      ek: this.keys ? this.keys.pub : null, since: this.since,
    });
  }

  /** Read every player's presence: seat them in the lobby, take their orders live. */
  ingest(peers) {
    const here = new Set();
    for (const p of peers) {
      const pr = p.presence || {};
      if (p.me || pr.app !== APP || pr.tbl !== this.tbl || pr.role !== "player") continue;
      here.add(p.peer);
      if (this.phase === "lobby") {
        if (!this.seats.has(p.peer) && this.seats.size < MAX_HUMANS - 1)
          this.seats.set(p.peer, { peer: p.peer, name: String(pr.name || "Trader").slice(0, 18), pk: pr.pk || null, since: Number(pr.since) || Date.now(), by: p.by });
        else if (this.seats.has(p.peer)) Object.assign(this.seats.get(p.peer), { name: String(pr.name || "Trader").slice(0, 18), pk: pr.pk || null });
        continue;
      }
      const pid = this.peerPid && this.peerPid.get(p.peer);
      if (pid === undefined || !Array.isArray(pr.in)) continue;
      let taken = 0;
      for (const item of pr.in) {
        if (!Array.isArray(item) || !Number.isInteger(item[0]) || item[0] <= (this.lastSeq[pid] || 0)) continue;
        const intent = cleanIntent(item[1]);
        this.lastSeq[pid] = item[0];
        if (intent && taken++ < 20) this.engine.submit(pid, intent);
      }
    }
    if (this.phase === "lobby") {
      for (const k of [...this.seats.keys()]) if (!here.has(k)) this.seats.delete(k);
      // only react to a real change in who is seated: our own presence update
      // comes back through here too, and answering it would loop forever
      const sig = [...this.seats.values()].map((x) => `${x.peer}:${x.name}:${x.pk}`).join("|");
      if (sig !== this.seatSig) { this.seatSig = sig; this.announce(); this.broadcast(); }
    }
  }

  async start() {
    if (this.phase !== "lobby") return;
    const humans = [{ name: this.name, peer: this.tx ? this.tx.me : null, pk: null }];
    for (const s of [...this.seats.values()].sort((a, b) => a.since - b.since)) humans.push(s);
    this.roster = fillRoster(humans.map((h) => ({ name: h.name })));
    this.roster.forEach((r, i) => { if (humans[i]) { r.peer = humans[i].peer; r.pk = humans[i].pk; } });
    this.peerPid = new Map(this.roster.filter((r) => r.peer).map((r) => [r.peer, r.pid]));
    this.seed = randomHex(16);
    this.commit = sealing ? await sha256hex(this.seed) : null;
    this.engine = new Royale(this.seed, this.roster, { steps: this.steps });
    this.phase = "count";
    this.count = COUNTDOWN;
    clearInterval(this.lobbyBeat);
    this.announce();
    this.stop = ticker(STEP_MS, () => this.tick());
    this.broadcast();
  }

  /** The host trades from its own page: straight into the engine. */
  submit(intent) {
    if (this.phase === "live" && cleanIntent(intent)) this.engine.submit(this.hostPid, intent);
  }

  tick() {
    if (this.phase === "count") {
      if (--this.count <= 0) { this.phase = "live"; this.announce(); }
      return this.broadcast();
    }
    if (this.phase !== "live") return;
    const g = this.engine;
    g.step();
    this.sealHints();
    this.broadcast();
    if (g.over) this.finish();
  }

  async sealHints() {
    const g = this.engine;
    for (const n of g.news) {
      if (n.announce !== g.k - 1) continue;
      for (const pid of n.hinted) {
        const r = this.roster[pid];
        if (r.kind !== "human" || pid === this.hostPid) continue;
        const body = { i: n.i, name: n.name, dir: n.dir, lo: n.lo, hi: n.hi, hit: n.hit };
        if (this.keys && r.pk) {
          try {
            const [iv, ct] = await seal(await sharedKey(this.keys.priv, r.pk), body);
            this.hx.push({ pid, until: n.hit, iv, ct });
          } catch { /* a bad key from a peer: that peer just gets no hint */ }
        }
      }
    }
  }

  /** The state every page renders from, including this one. */
  view() {
    const g = this.engine;
    const v = { t: this.tbl, ph: this.phase, T: this.steps, host: this.name };
    if (!g) {
      v.ro = [[0, 0, this.name, this.tx ? this.tx.me : null], ...[...this.seats.values()].map((s, i) => [i + 1, 0, s.name, s.peer])];
      return v;
    }
    const mark = g.mark();
    Object.assign(v, {
      k: g.k, cd: this.phase === "count" ? Math.ceil(this.count / STEPS_PER_SEC) : 0, cm: this.commit,
      bl: Math.round(bustLine(g.k, g.T)), mid: mark, lp: g.lastPrice,
      ro: this.roster.map((r) => [r.pid, r.kind === "bot" ? 1 : 0, r.name, r.peer || null, r.bot || null]),
      pl: g.players.map((p) => [p.pid, Math.round(g.over ? p.final : p.alive ? g.equity(p, mark) : p.final), p.pos, p.alive ? 1 : 0, p.bustK ?? -1]),
      bk: (({ bids, asks }) => ({ b: bids, a: asks }))(g.ladder(12)),
      tr: this.tradesSince(g),
      oo: this.roster.filter((r) => r.kind === "human").flatMap((r) => g.openOrders(r.pid).map((o) => [r.pid, ...o])),
      ack: this.roster.filter((r) => r.kind === "human").map((r) => [r.pid, this.lastSeq[r.pid] || 0]),
      nw: g.news.filter((n) => g.k >= n.announce).map((n) => [n.i, n.name, n.announce, n.hit, g.k > n.hit ? n.jump : null]),
      hx: this.hx.filter((h) => g.k <= h.until).map((h) => [h.pid, h.iv, h.ct]),
      ev: g.events.slice(this.evCursor).filter((e) => e.kind !== "reject").map((e) => [e.k, e.kind, e.pid ?? e.news ?? -1]).slice(-10),
      rj: g.events.slice(this.evCursor).filter((e) => e.kind === "reject").map((e) => [e.pid, e.why]).slice(-6),
    });
    if (g.over) v.fin = g.players.map((p) => [p.pid, p.final]);
    return v;
  }

  tradesSince(g) {
    const all = g.book.trades, out = [];
    for (let i = Math.max(this.trCursor, all.length - 14); i < all.length; i++) {
      const t = all[i], m = g.byAgent.get(t.makerAgent), tk = g.byAgent.get(t.takerAgent);
      out.push([i, t.price, t.qty, t.aggressor, m ? m.pid : -1, tk ? tk.pid : -1]);
    }
    return out;
  }

  broadcast() {
    const v = this.view();
    const g = this.engine;
    // the host sees its own hint in the clear
    const local = { ...v };
    if (g) {
      const n = g.activeHint(`p${this.hostPid}`);
      local.myHint = n && g.k <= n.hit ? { i: n.i, name: n.name, dir: n.dir, lo: n.lo, hi: n.hi, hit: n.hit } : null;
      this.trCursor = g.book.trades.length;
      this.evCursor = g.events.length;
    }
    this.onView(local, this);
    if (this.tx) {
      fit(v);
      this.tx.emit("s", v).catch((e) => { if (e && e.code === "not_permitted") this.onView({ ...local, error: "view-only" }, this); });
    }
  }

  async finish() {
    this.phase = "over";
    if (this.stop) this.stop();
    this.announce();
    this.broadcast();
    const g = this.engine;
    const payload = JSON.stringify({ v: ENGINE_VERSION, seed: this.seed, T: this.steps, ro: this.roster.map(({ pid, kind, name, bot }) => ({ pid, kind, name, bot })), log: g.log, fin: g.players.map((p) => p.final) });
    this.payload = payload;
    this.onVerify(await verifyPayload(payload, this.commit), this);
    if (!this.tx) return;
    const parts = [];
    for (let i = 0; i < payload.length; i += 3000) parts.push(payload.slice(i, i + 3000));
    for (let round = 0; round < 2; round++)
      for (let i = 0; i < parts.length; i++) {
        await this.tx.emit("v", { t: this.tbl, n: i, of: parts.length, d: parts[i] }).catch(() => {});
        await new Promise((r) => setTimeout(r, 70));
      }
  }

  close() {
    if (this.stop) this.stop();
    clearInterval(this.lobbyBeat);
    if (this.tx) this.tx.setPresence({ app: APP, v: PROTO, role: "idle", name: this.name });
  }
}

// ---------------------------------------------------------------------------
// client: trades through someone else's exchange, or watches
// ---------------------------------------------------------------------------

export class ClientSession {
  constructor(transport, { name, onView, onVerify, onHint, onGone }) {
    Object.assign(this, { tx: transport, name, onView, onVerify, onHint, onGone });
    this.seq = 0;
    this.pending = [];
    this.parts = new Map();
    this.hints = new Map();
    this.since = Date.now();
    this.lastSeen = Date.now();
  }

  async join(tbl, hostPeer, hostKey, watchOnly = false) {
    this.tbl = tbl;
    this.hostPeer = hostPeer;
    this.hostKey = hostKey;
    this.role = watchOnly ? "watch" : "player";
    if (sealing && !watchOnly) this.keys = await keyPair();
    this.offS = this.tx.on("s", (m) => this.recv(m));
    this.offV = this.tx.on("v", (m) => this.recvVerify(m));
    this.tx.onPeers((peers) => {
      const h = peers.find((p) => p.peer === this.hostPeer);
      if (h) { this.lastSeen = Date.now(); if (h.presence && h.presence.ek) this.hostKey = h.presence.ek; }
    });
    this.watchdog = setInterval(() => { if (Date.now() - this.lastSeen > 6000 && !this.done) { this.done = true; this.onGone(); } }, 1000);
    return this.push();
  }

  push() {
    return this.tx.setPresence({
      app: APP, v: PROTO, role: this.role, tbl: this.tbl, name: this.name,
      pk: this.keys ? this.keys.pub : null, since: this.since, in: this.pending.slice(-16),
    });
  }

  submit(intent) {
    if (this.role !== "player" || this.pending.length >= 16) return false;
    this.pending.push([++this.seq, intent]);
    this.push();
    return true;
  }

  recv(m) {
    if (m.peer !== this.hostPeer || !m.data || m.data.t !== this.tbl) return;
    this.lastSeen = Date.now();
    const v = m.data;
    const me = (v.ro || []).find((r) => r[3] === this.tx.me);
    this.pid = me ? me[0] : null;
    if (this.pid !== null && v.ack) {
      const a = v.ack.find((x) => x[0] === this.pid);
      if (a && this.pending.length && this.pending[0][0] <= a[1]) {
        this.pending = this.pending.filter(([s]) => s > a[1]);
        this.push();
      }
    }
    if (v.cm) this.commit = v.cm;
    if (v.ph === "over") this.final = v;
    for (const h of v.hx || []) if (h[0] === this.pid && !this.hints.has(h[1])) this.open(h);
    v.myHint = [...this.hints.values()].find((h) => h && v.k <= h.hit) || null;
    this.onView(v, this);
  }

  async open([, iv, ct]) {
    this.hints.set(iv, null);
    if (!this.keys || !this.hostKey) return;
    try {
      const h = await unseal(await sharedKey(this.keys.priv, this.hostKey), iv, ct);
      this.hints.set(iv, h);
      this.onHint(h);
    } catch { /* not for us after all */ }
  }

  async recvVerify(m) {
    if (m.peer !== this.hostPeer || !m.data || m.data.t !== this.tbl || this.verified) return;
    const { n, of, d } = m.data;
    if (!Number.isInteger(n) || !Number.isInteger(of) || of > 400) return;
    this.parts.set(n, d);
    if (this.parts.size < of) return;
    this.verified = true;
    const payload = Array.from({ length: of }, (_, i) => this.parts.get(i)).join("");
    this.onVerify(await verifyPayload(payload, this.commit, this.final), this);
  }

  leave() {
    clearInterval(this.watchdog);
    this.done = true;
    this.tx.setPresence({ app: APP, v: PROTO, role: "idle", name: this.name });
  }
}

/** Check the commitment, replay the round, compare every player's result. */
export async function verifyPayload(payload, commit, finalView = null) {
  try {
    const p = JSON.parse(payload);
    if (p.v !== ENGINE_VERSION) return { ok: false, why: "a different engine version" };
    const hashOk = commit ? (await sha256hex(p.seed)) === commit : null;
    const g = replay(p.seed, p.ro, p.log, { steps: p.T });
    const replayed = g.players.map((x) => x.final);
    const claimed = finalView && finalView.fin ? finalView.fin.map((x) => x[1]) : p.fin;
    const ok = replayed.every((x, i) => Math.abs(x - claimed[i]) < 0.005) && hashOk !== false;
    return { ok, hashOk, steps: p.T, intents: p.log.length, seed: p.seed, game: g, why: hashOk === false ? "the seed doesn't match the commitment" : ok ? "" : "the replay disagrees with the host" };
  } catch (e) {
    return { ok: false, why: "the verification payload didn't parse" };
  }
}

export { BUST_FINAL, DPT, START_CASH };
