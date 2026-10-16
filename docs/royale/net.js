// Networking: one page runs the exchange, everyone else trades through it.
//
// Transport is the artifact's live room when the page runs on claude.ai, a
// BroadcastChannel between tabs of one browser otherwise. The protocol is the
// same either way:
//
//   players -> host   presence: {role:"player", tbl, in:[[seq, intent], ...]}
//                     Absolute state, re-sent until acknowledged, so a
//                     dropped packet delays an order instead of losing it.
//   host -> everyone  "s" state, 5 per second, under the room's 4 KB limit.
//                     Hints ride inside it, encrypted to their recipient.
//   host -> everyone  "v" at the bell: the seed and every intent, in chunks,
//                     so each page can replay the round and check the result
//                     against the hash the host committed to at the start.
//
// The host's page holds the seed, so whoever hosts could peek at the hidden
// price. Nothing in a browser-only game can stop that; the commitment only
// stops the host from changing the market or the fills after the fact.

export const APP = "obr";
export const PROTO = 1;

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function randomHex(bytes = 16) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// sealed hints: ECDH P-256 -> AES-GCM
// ---------------------------------------------------------------------------

export const sealing = typeof crypto !== "undefined" && !!crypto.subtle;

export async function keyPair() {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey"]);
  const pub = b64(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { priv: kp.privateKey, pub };
}

const keyCache = new Map();
export async function sharedKey(priv, peerPubB64) {
  const id = peerPubB64;
  if (keyCache.has(id)) return keyCache.get(id);
  const pub = await crypto.subtle.importKey("raw", unb64(peerPubB64), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const key = await crypto.subtle.deriveKey({ name: "ECDH", public: pub }, priv, { name: "AES-GCM", length: 128 }, false, ["encrypt", "decrypt"]);
  keyCache.set(id, key);
  return key;
}

export async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return [b64(iv), b64(ct)];
}

export async function unseal(key, iv, ct) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key, unb64(ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

// ---------------------------------------------------------------------------
// transports
// ---------------------------------------------------------------------------

/** The artifact's live room. */
export class RoomTransport {
  constructor(room) {
    this.room = room;
    this.kind = "room";
    this.me = null;
    this.sent = {};
    this.peerFns = [];
  }
  async ready() {
    const find = () => { const s = this.room.peers().find((p) => p.sameTab); if (s) this.me = s.peer; };
    find();
    this.room.onPeers((ch) => {
      if (!this.me) find();
      const list = ch.peers.map((p) => ({ peer: p.peer, by: p.by, me: !!p.sameTab, guest: !!p.guest, presence: p.presence || {} }));
      for (const f of this.peerFns) f(list);
    }, () => { this.dead = true; for (const f of this.peerFns) f([]); });
    for (let i = 0; i < 40 && !this.me; i++) { await new Promise((r) => setTimeout(r, 100)); find(); }
    return !!this.me;
  }
  connected() { return !this.dead && this.room.connected(); }
  onPeers(fn) { this.peerFns.push(fn); }
  peers() { return this.room.peers().map((p) => ({ peer: p.peer, by: p.by, me: !!p.sameTab, guest: !!p.guest, presence: p.presence || {} })); }
  /** Replace our whole presence object (the room merges by field). */
  setPresence(obj) {
    const patch = { ...obj };
    for (const k of Object.keys(this.sent)) if (!(k in obj)) patch[k] = null;
    this.sent = { ...obj };
    return this.room.presence(patch);
  }
  emit(topic, data) { return this.room.emit(topic, data); }
  on(topic, fn) {
    return this.room.on(topic, (m) => { if (!m.sameTab) fn({ peer: m.peer, by: m.by, data: m.data }); });
  }
}

/** Tabs of one browser: for playing locally and for testing the protocol. */
export class ChannelTransport {
  constructor(name = "order-book-royale") {
    this.kind = "tabs";
    this.ch = new BroadcastChannel(name);
    this.me = "t" + randomHex(6);
    this.mine = {};
    this.others = new Map();
    this.peerFns = [];
    this.topicFns = new Map();
    this.ch.onmessage = (e) => this._recv(e.data);
    this.beat = setInterval(() => { this._send({ t: "p", peer: this.me, p: this.mine }); this._expire(); }, 1000);
    addEventListener("pagehide", () => this._send({ t: "bye", peer: this.me }));
  }
  async ready() { this._send({ t: "p", peer: this.me, p: this.mine }); this._send({ t: "hello", peer: this.me }); return true; }
  connected() { return true; }
  _send(m) { try { this.ch.postMessage(m); } catch { /* closed */ } }
  _recv(m) {
    if (!m || m.peer === this.me) return;
    if (m.t === "p") { this.others.set(m.peer, { presence: m.p || {}, at: Date.now() }); this._changed(); }
    else if (m.t === "hello") this._send({ t: "p", peer: this.me, p: this.mine });
    else if (m.t === "bye") { this.others.delete(m.peer); this._changed(); }
    else if (m.t === "e") for (const f of this.topicFns.get(m.topic) || []) f({ peer: m.peer, by: null, data: m.data });
  }
  _expire() {
    const now = Date.now();
    let changed = false;
    for (const [k, v] of this.others) if (now - v.at > 3500) { this.others.delete(k); changed = true; }
    if (changed) this._changed();
  }
  _changed() { const l = this.peers(); for (const f of this.peerFns) f(l); }
  onPeers(fn) { this.peerFns.push(fn); }
  peers() {
    return [{ peer: this.me, by: null, me: true, presence: this.mine },
      ...[...this.others].map(([peer, v]) => ({ peer, by: null, me: false, presence: v.presence }))];
  }
  setPresence(obj) {
    this.mine = { ...obj };
    this._send({ t: "p", peer: this.me, p: this.mine });
    this._changed();
    return Promise.resolve();
  }
  emit(topic, data) { this._send({ t: "e", peer: this.me, topic, data }); return Promise.resolve(); }
  on(topic, fn) {
    if (!this.topicFns.has(topic)) this.topicFns.set(topic, []);
    this.topicFns.get(topic).push(fn);
    return () => {};
  }
}

/** Fit a state message under the room's 4 KB limit by shedding detail. */
export function fit(msg, limit = 3800) {
  const size = () => new TextEncoder().encode(JSON.stringify(msg)).length;
  let n = size();
  while (n > limit && msg.tr && msg.tr.length > 2) { msg.tr = msg.tr.slice(-Math.floor(msg.tr.length / 2)); n = size(); }
  for (const depth of [10, 7, 5]) {
    if (n <= limit) break;
    msg.bk = { b: msg.bk.b.slice(0, depth), a: msg.bk.a.slice(0, depth) };
    n = size();
  }
  while (n > limit && msg.oo && msg.oo.length) { msg.oo = msg.oo.slice(0, -1); n = size(); }
  return n;
}
