// Order Book Royale: lobby, table, game screen, results.

import { BUY, SELL } from "./book.js";
import { BOT_FILL, BOT_TYPES, LOT, MAX_ORDER, ROUND_STEPS, START_CASH, STEPS_PER_SEC, TICK } from "./engine.js";
import { APP, ChannelTransport, PROTO, RoomTransport } from "./net.js";
import { ClientSession, HostSession } from "./session.js";

const $ = (s) => document.querySelector(s);
const STEPS = /[?&]fast\b/.test(location.search) ? 300 : ROUND_STEPS;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const COLORS = ["#7c3aed", "#0f9d74", "#f97316", "#db2777", "#0891b2", "#a16207", "#475569", "#be123c"];
const CROWD_B = "#b9c8f2", CROWD_A = "#f5c2bb";
const SIZES = [1, 5, 10, 25, 50];

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

const nf = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const MINUS = "−";
const usd = (x) => "$" + nf.format(Math.round(x));
const sgn = (x) => (Math.round(x) < 0 ? MINUS : Math.round(x) > 0 ? "+" : "") + "$" + nf.format(Math.abs(Math.round(x)));
const px = (t) => (t * TICK).toFixed(2);
const sh = (lots) => nf.format(lots * LOT);
const shShort = (lots) => { const s = lots * LOT; return s >= 1000 ? (s / 1000).toFixed(s % 1000 ? 1 : 0) + "k" : String(s); };
const cls = (x) => (x > 0.5 ? "up" : x < -0.5 ? "down" : "");
const mmss = (steps) => { const s = Math.max(0, Math.ceil(steps / STEPS_PER_SEC)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

const S = {
  tx: null, db: null, user: null, uid: null, name: "",
  session: null, host: false, view: null, pid: null, size: 5, center: null,
  mids: [], fills: [], tapeSeen: -1, seenEv: new Set(), tables: [], resultsShown: false, verify: null, hintSeen: null,
};

function loadName() {
  try { return localStorage.getItem("obr:name") || ""; } catch { return ""; }
}
function saveName(n) {
  try { localStorage.setItem("obr:name", n); } catch { /* fine */ }
}
const myName = () => ($("#nameIn").value.trim() || S.name || "Trader").slice(0, 18);

// ---------------------------------------------------------------------------
// toasts
// ---------------------------------------------------------------------------

function toast(html, kind = "") {
  const d = document.createElement("div");
  d.className = kind;
  d.innerHTML = html;
  $("#toasts").prepend(d);
  setTimeout(() => d.remove(), 3300);
  while ($("#toasts").children.length > 3) $("#toasts").lastChild.remove();
}

// ---------------------------------------------------------------------------
// lobby
// ---------------------------------------------------------------------------

function renderTables() {
  const box = $("#tables");
  const list = S.tables;
  if (!S.tx) { box.innerHTML = `<p class="note">Multiplayer needs the shared version of this page. Solo works everywhere.</p>`; return; }
  if (!list.length) { box.innerHTML = `<p class="note">No tables open. Host one and anyone with this page open can join it.</p>`; return; }
  box.innerHTML = list.map((t) => `<div class="table"><div><b>${esc(t.name)}'s table</b><div class="dim" style="font-size:11.5px">${t.n} trader${t.n === 1 ? "" : "s"} seated</div></div>`
    + `<span class="badge ${t.st === "lobby" ? "" : "live"}">${t.st === "lobby" ? "open" : t.st === "over" ? "finished" : "live"}</span>`
    + (t.st === "lobby" ? `<button class="big" style="font-size:16px;padding:8px 14px" data-join="${esc(t.peer)}">Take a seat</button>`
      : t.st === "over" ? "<span></span>" : `<button class="big ghost" style="font-size:16px;padding:8px 14px" data-watch="${esc(t.peer)}">Watch</button>`) + `</div>`).join("");
}

function lobbyPeers(peers) {
  S.tables = peers.filter((p) => !p.me && p.presence && p.presence.app === APP && p.presence.v === PROTO && p.presence.role === "host" && p.presence.tbl)
    .map((p) => ({ peer: p.peer, tbl: String(p.presence.tbl), name: String(p.presence.name || "Someone").slice(0, 18), st: p.presence.st, n: Number(p.presence.n) || 1, ek: p.presence.ek || null }));
  // re-render only on a real change: heartbeats arrive every second, and
  // replacing the buttons mid-click swallows the click
  const sig = JSON.stringify(S.tables.map((t) => [t.peer, t.name, t.st, t.n]));
  if (sig !== S.tableSig && !$("#lobby").hidden) { S.tableSig = sig; renderTables(); }
}

function setIdle() {
  if (S.tx) S.tx.setPresence({ app: APP, v: PROTO, role: "idle", name: myName() }).catch(() => {});
}

function toLobby() {
  if (S.session) { S.session.leave ? S.session.leave() : S.session.close(); S.session = null; }
  Object.assign(S, { view: null, pid: null, center: null, mids: [], fills: [], tapeSeen: -1, resultsShown: false, verify: null, hintSeen: null });
  S.seenEv.clear();
  $("#results").hidden = $("#room").hidden = $("#countdown").hidden = true;
  $("#lobby").hidden = false;
  $("#tape").innerHTML = "";
  S.tableSig = null;
  setIdle();
  renderTables();
}

function sessionHooks() {
  return {
    name: myName(),
    steps: STEPS,
    onView: (v) => onView(v),
    onVerify: (r) => onVerify(r),
    onHint: () => {},
    onGone: () => { toast("<b>Exchange dark</b>The host left, so this round is over.", "bust"); setTimeout(toLobby, 1200); },
  };
}

async function playSolo() {
  saveName(myName());
  S.host = true;
  S.session = new HostSession(null, sessionHooks());
  await S.session.open();
  $("#lobby").hidden = true;
  await S.session.start();
}

async function hostTable() {
  if (!S.tx) return;
  saveName(myName());
  S.host = true;
  S.session = new HostSession(S.tx, sessionHooks());
  await S.session.open();
  $("#lobby").hidden = true;
  $("#room").hidden = false;
}

async function joinTable(peer, watch = false) {
  const t = S.tables.find((x) => x.peer === peer);
  if (!t || !S.tx) return;
  saveName(myName());
  S.host = false;
  S.session = new ClientSession(S.tx, sessionHooks());
  await S.session.join(t.tbl, t.peer, t.ek, watch);
  $("#lobby").hidden = true;
  $("#room").hidden = watch;
  if (!watch) renderRoom({ ro: [], host: t.name, ph: "lobby" });
}

function renderRoom(v) {
  const humans = (v.ro || []).filter((r) => !r[1]);
  $("#roomKick").textContent = S.host ? "Your table" : `${v.host || "The host"}'s table`;
  $("#roomTitle").textContent = humans.length > 1 ? `${humans.length} traders seated` : "Waiting for traders";
  $("#roomLede").textContent = S.host
    ? "Anyone who opens this page can take a seat. Ring the bell when you're ready; empty seats go to the bots."
    : "You're seated. The host rings the bell; empty seats go to the bots.";
  const seats = [];
  for (let i = 0; i < 8; i++) {
    const h = humans[i];
    if (h) seats.push(`<div class="seat human join"><b>${esc(h[2])}</b><small>${i === 0 ? "host" : h[3] === (S.tx && S.tx.me) ? "you" : "seated"}</small></div>`);
    else { const t = BOT_FILL[i - humans.length]; seats.push(`<div class="seat"><b>${BOT_TYPES[t].name}</b><small>bot · ${BOT_TYPES[t].blurb}</small></div>`); }
  }
  $("#seats").innerHTML = seats.join("");
  $("#startBtn").hidden = !S.host;
  $("#roomNote").textContent = S.tx && S.tx.kind === "tabs"
    ? "This copy of the page connects tabs in one browser. Open the shared claude.ai version to play with other people."
    : "";
}

// ---------------------------------------------------------------------------
// the game screen
// ---------------------------------------------------------------------------

function onView(v) {
  if (v.error === "view-only") {
    toast("<b>Can't host here</b>Your access to this page is view-only. Take a seat at someone else's table.", "bust");
    return toLobby();
  }
  S.view = v;
  if (v.ph === "lobby") return renderRoom(v);
  $("#room").hidden = true;
  S.pid = S.host ? 0 : S.session.pid ?? null;
  $("#countdown").hidden = v.ph !== "count";
  if (v.ph === "count") $("#cdNum").textContent = v.cd;
  if (v.k !== undefined) S.mids[v.k] = v.mid;

  // prints
  const newTr = (v.tr || []).filter((t) => t[0] > S.tapeSeen);
  if (newTr.length) S.tapeSeen = newTr[newTr.length - 1][0];
  for (const t of newTr) if (S.pid !== null && (t[4] === S.pid || t[5] === S.pid)) S.fills.push([v.k, t[1], t[5] === S.pid ? t[3] : -t[3]]);

  // events
  for (const e of v.ev || []) {
    const key = e.join(":");
    if (S.seenEv.has(key)) continue;
    S.seenEv.add(key);
    const name = (pid) => (v.ro.find((r) => r[0] === pid) || [0, 0, "?"])[2];
    if (e[1] === "bust") {
      toast(`<b>Margin call</b>${esc(name(e[2]))} is out.`, "bust");
      const row = towerRows.get(e[2]);
      if (row && !reduceMotion) { row.classList.remove("flash"); void row.offsetWidth; row.classList.add("flash"); }
    } else if (e[1] === "announce") {
      const n = (v.nw || []).find((x) => x[0] === e[2]);
      if (n) toast(`<b>${esc(n[1])}</b>in ${mmss(n[3] - v.k)}. Someone may already know.`, "news");
    } else if (e[1] === "hit") {
      const n = (v.nw || []).find((x) => x[0] === e[2]);
      if (n) toast(`<b>${esc(n[1])}</b>out now.`, "news");
    }
  }
  for (const r of v.rj || []) if (r[0] === S.pid) toast(`<b>Rejected</b>${esc(r[1])}`);

  renderHeader(v);
  renderTower(v);
  renderLadder(v, newTr);
  renderPanel(v);
  renderTape(v, newTr);
  renderNews(v);
  drawChart(v);
  if (v.ph === "over" && !S.resultsShown) showResults(v);
}

function renderHeader(v) {
  const left = v.T - (v.k || 0);
  $("#clock").textContent = v.ph === "count" ? mmss(v.T) : mmss(left);
  $("#clock").classList.toggle("late", left < 30 * STEPS_PER_SEC);
  $("#hLast").textContent = px(v.lp);
  $("#hLine").textContent = usd(v.bl);
  $("#towerLine").textContent = usd(v.bl);
  const alive = v.pl.filter((p) => p[3]).length;
  $("#hAlive").textContent = `${alive} / ${v.pl.length}`;
  const pending = (v.nw || []).find((n) => n[4] === null && n[3] >= v.k);
  const bug = $("#newsbug");
  if (pending) {
    $("#nbName").textContent = pending[1];
    $("#nbWhen").textContent = `in ${mmss(pending[3] - v.k)}`;
    bug.classList.toggle("hot", pending[3] - v.k < 5 * STEPS_PER_SEC);
  } else {
    const last = (v.nw || []).filter((n) => n[4] !== null).pop();
    $("#nbName").textContent = last ? last[1] : "No news yet";
    $("#nbWhen").textContent = last ? `${last[4] > 0 ? "+" : MINUS}$${px(Math.abs(last[4]))}` : "";
    bug.classList.remove("hot");
  }
  $("#where").textContent = S.host && !S.session.tx ? "solo · you against seven bots" : S.host ? "you're running the exchange" : S.pid === null ? "watching" : `trading on ${v.host}'s exchange`;
}

// timing tower with FLIP reordering
const towerRows = new Map();
function renderTower(v) {
  const box = $("#towerRows");
  const ro = new Map(v.ro.map((r) => [r[0], r]));
  const order = [...v.pl].sort((a, b) => (a[3] !== b[3] ? b[3] - a[3] : !a[3] && a[4] !== b[4] ? b[4] - a[4] : b[1] - a[1]));
  const leader = order[0][1];
  // offsetTop is the layout position, unaffected by an animation still in flight
  const before = new Map([...towerRows].map(([pid, el]) => [pid, el.offsetTop]));
  order.forEach((p, i) => {
    const [pid, eq, pos, alive, bustK] = p;
    const r = ro.get(pid);
    let el = towerRows.get(pid);
    if (!el) {
      el = document.createElement("div");
      el.className = "trow";
      el.innerHTML = `<span class="pos"></span><span class="chip"></span><span class="who"><b></b><small></small></span><span class="eq"></span><span class="hp"><i></i></span>`;
      towerRows.set(pid, el);
    }
    el.classList.toggle("me", pid === S.pid);
    el.classList.toggle("out", !alive);
    el.querySelector(".pos").textContent = i + 1;
    el.querySelector(".chip").style.background = COLORS[pid];
    el.querySelector(".who b").innerHTML = esc(r[2]) + (r[1] ? '<span class="tag">BOT</span>' : "");
    el.querySelector(".who small").textContent = alive ? `${pos > 0 ? "long" : pos < 0 ? "short" : "flat"} ${pos ? sh(Math.abs(pos)) : ""}` : `margin call at ${mmss(v.T - bustK)} left`;
    el.querySelector(".eq").innerHTML = `${usd(eq)}<small>${i === 0 ? (alive ? "leader" : "") : sgn(eq - leader)}</small>`;
    const room = clamp((eq - v.bl) / 200000, 0, 1);
    const bar = el.querySelector(".hp i");
    bar.style.width = `${alive ? room * 100 : 0}%`;
    bar.style.background = room > 0.5 ? "var(--up)" : room > 0.2 ? "var(--gold)" : "var(--ask)";
    box.appendChild(el);
  });
  for (const [pid, el] of towerRows) if (!v.pl.some((p) => p[0] === pid)) { el.remove(); towerRows.delete(pid); }
  if (reduceMotion) return;
  for (const [pid, el] of towerRows) {
    const was = before.get(pid);
    if (was === undefined) continue;
    const dy = was - el.offsetTop;
    if (!dy) continue;
    for (const a of el.getAnimations()) a.cancel();
    el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 450, easing: "cubic-bezier(.2,.9,.3,1)" });
  }
}

const ROWS = 23;
function renderLadder(v, newTr) {
  const bids = new Map(v.bk.b.map((l) => [l[0], l]));
  const asks = new Map(v.bk.a.map((l) => [l[0], l]));
  const bb = v.bk.b.length ? v.bk.b[0][0] : null, ba = v.bk.a.length ? v.bk.a[0][0] : null;
  const ref = bb !== null && ba !== null ? (bb + ba) / 2 : v.mid;
  if (S.center === null || Math.abs(ref - S.center) > 4) S.center = Math.round(ref);
  const top = S.center + Math.floor(ROWS / 2);
  const maxQ = Math.max(1, ...v.bk.b.map((l) => l[1]), ...v.bk.a.map((l) => l[1]));
  const mine = { b: new Map(), a: new Map() };
  for (const [pid, oid, side, p, q] of v.oo || []) {
    if (pid !== S.pid) continue;
    const m = side === BUY ? mine.b : mine.a;
    const cur = m.get(p) || { q: 0, ids: [] };
    cur.q += q; cur.ids.push(oid);
    m.set(p, cur);
  }
  const hit = new Map();
  for (const t of newTr) hit.set(t[1], t[3]);
  const bar = (level, crowd) => {
    if (!level) return "";
    const w = (level[1] / maxQ) * 100;
    const segs = level[2].map(([pid, q]) => `<i style="width:${(q / level[1]) * 100}%;background:${pid < 0 ? crowd : pid === S.pid ? "var(--gold)" : COLORS[pid]}"></i>`).join("");
    return `<div class="bar" style="width:${w}%">${segs}</div><span>${shShort(level[1])}</span>`;
  };
  const rows = [];
  for (let i = 0; i < ROWS; i++) {
    const p = top - i;
    const mb = mine.b.get(p), ma = mine.a.get(p);
    const h = hit.get(p);
    rows.push(`<div class="lr${p === v.lp ? " last" : ""}${p === ba ? " mid" : ""}${h ? (h === BUY ? " hitb" : " hita") : ""}" data-p="${p}">`
      + `<button class="my b" data-side="1" aria-label="Bid at ${px(p)}">${mb ? `<em data-cancel="${mb.ids.join(",")}">${shShort(mb.q)}</em>` : ""}</button>`
      + `<div class="dp b" data-side="1">${bar(bids.get(p), CROWD_B)}</div>`
      + `<div class="px">${px(p)}</div>`
      + `<div class="dp a" data-side="-1">${bar(asks.get(p), CROWD_A)}</div>`
      + `<button class="my a" data-side="-1" aria-label="Offer at ${px(p)}">${ma ? `<em data-cancel="${ma.ids.join(",")}">${shShort(ma.q)}</em>` : ""}</button></div>`);
  }
  $("#ladder").innerHTML = rows.join("");
  $("#spreadNote").textContent = bb !== null && ba !== null ? `spread ${px(ba - bb)} · bid ${px(bb)} / offer ${px(ba)}` : "one-sided book";
  $("#ladderLegend").innerHTML = `<span style="color:var(--gold)">■</span> you &nbsp; <span style="color:${CROWD_B}">■</span> the crowd &nbsp; colours: other traders`;
}

function me(v) { return S.pid === null ? null : v.pl.find((p) => p[0] === S.pid); }

function renderPanel(v) {
  const p = me(v);
  const live = v.ph === "live" && p && p[3];
  $("#watching").hidden = S.pid !== null;
  $("#meName").textContent = S.pid === null ? "watching" : p && !p[3] ? "margin-called" : (v.ro.find((r) => r[0] === S.pid) || [])[2] || "";
  for (const b of document.querySelectorAll("#panel button")) if (!b.closest("#sizes")) b.disabled = !live;
  const bb = v.bk.b.length ? v.bk.b[0][0] : null, ba = v.bk.a.length ? v.bk.a[0][0] : null;
  $("#buyTxt").textContent = `${sh(S.size)} sh${ba !== null ? ` near ${px(ba)}` : ""}`;
  $("#sellTxt").textContent = `${sh(S.size)} sh${bb !== null ? ` near ${px(bb)}` : ""}`;
  if (!p) return;
  const [, eq, pos] = p;
  $("#sPos").textContent = pos ? `${pos > 0 ? "+" : MINUS}${sh(Math.abs(pos))}` : "flat";
  $("#sEq").textContent = usd(eq);
  $("#sPnl").textContent = sgn(eq - START_CASH);
  $("#sPnl").className = cls(eq - START_CASH);
  const open = (v.oo || []).filter((o) => o[0] === S.pid).length;
  $("#sOpen").textContent = `${open} order${open === 1 ? "" : "s"}`;
  const room = eq - v.bl;
  $("#hRoom").textContent = p[3] ? usd(room) : "out";
  const f = clamp(room / 200000, 0, 1);
  $("#hBar").style.width = `${p[3] ? f * 100 : 0}%`;
  $("#hBar").style.background = f > 0.5 ? "var(--up)" : f > 0.2 ? "var(--gold)" : "var(--ask)";
  renderHint(v);
}

function renderHint(v) {
  const h = v.myHint;
  const box = $("#hint");
  if (!h) {
    if (box.classList.contains("on")) {
      box.classList.remove("on");
      box.innerHTML = `<span class="k">Inside information</span><div>None right now. Before each headline, one or two traders get a sealed hint about which way it breaks. If it's you, it decrypts here.</div>`;
      S.hintSeen = null;
    }
    return;
  }
  box.classList.add("on");
  const text = `${h.name} breaks ${h.dir > 0 ? "up" : "down"}`;
  const detail = `$${px(h.lo)} to $${px(h.hi)} · lands in ${mmss(h.hit - v.k)}`;
  if (S.hintSeen !== h.i) {
    S.hintSeen = h.i;
    scramble(box, text, detail);
  } else {
    const d = box.querySelector(".detail");
    if (d) d.textContent = detail;
  }
}

function scramble(box, text, detail) {
  box.innerHTML = `<span class="k">Sealed hint · decrypted for you</span><b></b><span class="detail"></span>`;
  const b = box.querySelector("b");
  box.querySelector(".detail").textContent = detail;
  if (reduceMotion) { b.textContent = text; return; }
  const glyphs = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#$%&";
  let f = 0;
  const run = () => {
    f++;
    b.textContent = [...text].map((c, i) => (c === " " || i < f / 2 ? c : glyphs[(Math.random() * glyphs.length) | 0])).join("");
    if (f / 2 < text.length) requestAnimationFrame(run);
    else b.textContent = text;
  };
  run();
}

function renderTape(v, newTr) {
  const ro = new Map(v.ro.map((r) => [r[0], r[2]]));
  const ul = $("#tape");
  for (const t of newTr) {
    const li = document.createElement("li");
    if (!reduceMotion && (t[4] === S.pid || t[5] === S.pid)) li.className = "in";
    const who = t[5] >= 0 || t[4] >= 0 ? `${t[5] >= 0 ? esc(ro.get(t[5])) : "crowd"} ${t[3] === BUY ? "lifts" : "hits"} ${t[4] >= 0 ? esc(ro.get(t[4])) : "crowd"}` : "";
    li.innerHTML = `<span class="${t[3] === BUY ? "b" : "a"}">${px(t[1])}</span><span>${shShort(t[2])}</span><span class="w">${who}</span>`;
    ul.prepend(li);
  }
  while (ul.children.length > 60) ul.lastChild.remove();
}

function renderNews(v) {
  $("#newsList").innerHTML = (v.nw || []).map((n) => `<li><span><b>${esc(n[1])}</b></span><span class="num">${n[4] === null ? (n[3] >= v.k ? `in ${mmss(n[3] - v.k)}` : "now") : `${n[4] > 0 ? "+" : MINUS}$${px(Math.abs(n[4]))}`}</span></li>`).join("");
}

function canvas2d(cv) {
  const dpr = Math.min(2, devicePixelRatio || 1), w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function drawChart(v, cv = $("#chart"), extra = null) {
  const { ctx, w, h } = canvas2d(cv);
  const mids = extra ? extra.mids : S.mids;
  const pts = [];
  mids.forEach((m, k) => { if (m !== undefined && m !== null) pts.push([k, m]); });
  if (pts.length < 2) return;
  const series = extra ? [...pts.map((p) => p[1]), ...extra.fairs] : pts.map((p) => p[1]);
  let lo = Math.min(...series), hi = Math.max(...series);
  const pad = Math.max(4, (hi - lo) * 0.1); lo -= pad; hi += pad;
  const L = 4, R = 54, T = 10, B = 16;
  const X = (k) => L + (k / v.T) * (w - L - R), Y = (p) => T + (1 - (p - lo) / (hi - lo)) * (h - T - B);
  ctx.font = `10px "Martian Mono", monospace`; ctx.textBaseline = "middle"; ctx.fillStyle = "#8a94a3";
  for (let i = 0; i <= 4; i++) {
    const p = lo + ((hi - lo) * i) / 4;
    ctx.strokeStyle = "#eef1f4"; ctx.beginPath(); ctx.moveTo(L, Y(p)); ctx.lineTo(w - R, Y(p)); ctx.stroke();
    ctx.fillText(px(p), w - R + 6, Y(p));
  }
  for (const n of v.nw || []) {
    ctx.strokeStyle = "rgba(245,179,1,.8)"; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(X(n[3]), T); ctx.lineTo(X(n[3]), h - B); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = "#a16207"; ctx.fillText(n[1].toUpperCase(), Math.min(X(n[3]) + 3, w - R - 60), h - 6);
  }
  if (extra) {
    ctx.strokeStyle = "#f5b301"; ctx.lineWidth = 2; ctx.setLineDash([4, 3]);
    ctx.beginPath(); extra.fairs.forEach((f, k) => (k ? ctx.lineTo(X(k), Y(f)) : ctx.moveTo(X(k), Y(f)))); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.strokeStyle = "#0b1220"; ctx.lineWidth = 1.6; ctx.lineJoin = "round";
  ctx.beginPath(); pts.forEach(([k, m], i) => (i ? ctx.lineTo(X(k), Y(m)) : ctx.moveTo(X(k), Y(m)))); ctx.stroke();
  if (!extra) for (const [k, p, side] of S.fills) {
    ctx.fillStyle = side > 0 ? "#1d4ed8" : "#dc2626";
    ctx.beginPath(); ctx.arc(X(k), Y(p), 3.5, 0, Math.PI * 2); ctx.fill();
  }
  const [lk, lm] = pts[pts.length - 1];
  if (!extra) { ctx.fillStyle = "#0b1220"; ctx.beginPath(); ctx.arc(X(lk), Y(lm), 4, 0, Math.PI * 2); ctx.fill(); }
}

// ---------------------------------------------------------------------------
// acting
// ---------------------------------------------------------------------------

function act(intent) {
  const v = S.view;
  if (!S.session || !v || v.ph !== "live" || S.pid === null) return;
  const p = me(v);
  if (!p || !p[3]) return;
  const ok = S.session.submit(intent);
  if (ok === false) toast("<b>Slow down</b>16 orders are already on their way to the exchange.");
}

function flatten() {
  const p = S.view && me(S.view);
  if (!p || !p[2]) return;
  act(["X"]);
  let left = Math.abs(p[2]);
  while (left > 0) { const q = Math.min(MAX_ORDER, left); act(["M", p[2] > 0 ? SELL : BUY, q]); left -= q; }
}

function wire() {
  $("#sizes").innerHTML = SIZES.map((s, i) => `<button data-size="${s}" aria-pressed="${s === S.size}">${shShort(s)} <kbd>${i + 1}</kbd></button>`).join("");
  $("#sizes").onclick = (e) => { const b = e.target.closest("[data-size]"); if (b) setSize(Number(b.dataset.size)); };
  $("#buyBtn").onclick = () => act(["M", BUY, S.size]);
  $("#sellBtn").onclick = () => act(["M", SELL, S.size]);
  $("#cancelBtn").onclick = () => act(["X"]);
  $("#flatBtn").onclick = flatten;
  $("#ladder").onclick = (e) => {
    const em = e.target.closest("[data-cancel]");
    if (em) { for (const id of em.dataset.cancel.split(",")) act(["C", Number(id)]); return; }
    const cell = e.target.closest("[data-side]");
    const row = e.target.closest("[data-p]");
    if (cell && row) act(["L", Number(cell.dataset.side), Number(row.dataset.p), S.size]);
  };
  $("#soloBtn").onclick = playSolo;
  $("#hostBtn").onclick = hostTable;
  $("#tables").onclick = (e) => {
    const j = e.target.closest("[data-join]"), w = e.target.closest("[data-watch]");
    if (j) joinTable(j.dataset.join);
    if (w) joinTable(w.dataset.watch, true);
  };
  $("#startBtn").onclick = () => S.session && S.session.start();
  $("#leaveBtn").onclick = toLobby;
  $("#nameIn").addEventListener("change", () => { saveName(myName()); setIdle(); });
  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input,select,textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "b") act(["M", BUY, S.size]);
    else if (k === "s") act(["M", SELL, S.size]);
    else if (k === "c") act(["X"]);
    else if (k === "f") flatten();
    else if (/^[1-5]$/.test(k)) setSize(SIZES[Number(k) - 1]);
  });
  addEventListener("resize", () => S.view && S.view.k !== undefined && drawChart(S.view));
}

function setSize(s) {
  S.size = s;
  for (const b of document.querySelectorAll("#sizes button")) b.setAttribute("aria-pressed", String(Number(b.dataset.size) === s));
  if (S.view && S.view.ph !== "lobby") renderPanel(S.view);
}

// ---------------------------------------------------------------------------
// the bell
// ---------------------------------------------------------------------------

function ranking(v) {
  const fin = new Map((v.fin || []).map((f) => [f[0], f[1]]));
  return [...v.pl].map((p) => ({ pid: p[0], name: v.ro.find((r) => r[0] === p[0])[2], bot: !!v.ro.find((r) => r[0] === p[0])[1], final: fin.has(p[0]) ? fin.get(p[0]) : p[1], alive: !!p[3], bustK: p[4] }))
    .sort((a, b) => (a.alive !== b.alive ? (a.alive ? -1 : 1) : !a.alive && a.bustK !== b.bustK ? b.bustK - a.bustK : b.final - a.final));
}

function showResults(v) {
  S.resultsShown = true;
  const r = ranking(v);
  const podium = [r[1], r[0], r[2]].map((p, i) => p ? `<div class="pod p${[2, 1, 3][i]}"><div class="n">${[2, 1, 3][i]}</div><b>${esc(p.name)}</b><small>${usd(p.final)}${p.alive ? "" : " · out"}</small></div>` : "<div></div>").join("");
  const won = r[0] && r[0].pid === S.pid;
  $("#resultsSheet").innerHTML = `
    <div class="hero">
      <div class="kick">The bell · ${esc(v.host)}'s exchange</div>
      <h1 class="title" style="font-size:clamp(48px,10vw,104px)">${won ? "You won" : S.pid !== null && !me(v)[3] ? "Margin-called" : esc(r[0].name) + " wins"}</h1>
      <p class="lede">${r.filter((p) => p.alive).length} of ${r.length} traders made the bell. Survivors settle at the efficient price, the number nobody could see until now.</p>
      <div class="podium">${podium}</div>
    </div>
    <div class="body">
      <div class="verify wait" id="verifyBox"><div><b>Checking the round</b>Replaying every order from the seed in your browser…</div></div>
      <div class="tbl res"><table><thead><tr><th>#</th><th>Trader</th><th>Final</th><th>P&amp;L</th><th>Edge / share vs fair</th><th>Volume</th><th>Hints</th><th>Status</th></tr></thead><tbody id="resRows">${resultRows(r, null, v)}</tbody></table></div>
      <h3 style="font-family:var(--disp);font-stretch:75%;font-weight:800;font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink3);margin:20px 0 0">What the market was really worth</h3>
      <canvas id="reveal" aria-label="Mid price against the hidden efficient price"></canvas>
      <p class="note">Black is the book's mid. Dashed gold is the efficient price the informed crowd could see. Every gap between them was somebody's stale quote.</p>
      <div class="namebar" style="margin-top:16px">${S.host ? '<button class="big gold" id="againBtn">Run it back</button>' : ""}<button class="big ghost" id="lobbyBtn">Back to the lobby</button></div>
    </div>`;
  $("#results").hidden = false;
  $("#results").scrollTop = 0;
  $("#lobbyBtn").onclick = toLobby;
  if ($("#againBtn")) $("#againBtn").onclick = () => { const tx = S.session.tx; toLobby(); tx ? hostTable() : playSolo(); };
  if (won) parade();
  if (S.verify) onVerify(S.verify);
}

function resultRows(r, game, v) {
  return r.map((p, i) => {
    const gp = game ? game.players[p.pid] : null;
    // engine edge is ticks x lots; per lot it is ticks per share, times $ per tick
    const edge = gp && gp.volume ? (gp.edge / gp.volume) * TICK : null;
    return `<tr${p.pid === S.pid ? ' style="background:#fff7dc"' : ""}><td>${i + 1}</td><td><span style="color:${COLORS[p.pid]}">■</span> ${esc(p.name)}${p.bot ? ' <span class="dim">bot</span>' : ""}</td>`
      + `<td>${usd(p.final)}</td><td class="${cls(p.final - START_CASH)}">${sgn(p.final - START_CASH)}</td>`
      + `<td class="${edge === null ? "" : cls(edge * 1000)}">${edge === null ? "—" : (edge >= 0 ? "+" : MINUS) + "$" + Math.abs(edge).toFixed(3)}</td>`
      + `<td>${gp ? sh(gp.volume) : "—"}</td><td>${gp ? gp.hints.length : "—"}</td>`
      + `<td>${p.alive ? "made the bell" : `out with ${mmss(v.T - p.bustK)} left`}</td></tr>`;
  }).join("");
}

function onVerify(res) {
  S.verify = res;
  const box = $("#verifyBox");
  if (!box) return;
  if (res.ok) {
    box.className = "verify ok";
    box.innerHTML = `<div><b>✓ Verified in your browser</b>Replayed ${nf.format(res.steps)} steps and ${nf.format(res.intents)} orders from the seed; every trader's result matches the exchange to the cent.${res.hashOk ? ` The seed hashes to the commitment published before the first trade.` : ""}<br><code>seed ${esc(res.seed)}</code></div>`;
    $("#resRows").innerHTML = resultRows(ranking(S.view), res.game, S.view);
    drawChart(S.view, $("#reveal"), { mids: res.game.mids, fairs: res.game.fairs });
    recordStats(res);
  } else {
    box.className = "verify bad";
    box.innerHTML = `<div><b>✗ Didn't verify</b>${esc(res.why || "The replay disagrees with the exchange.")} Treat this round's standings as unconfirmed.</div>`;
  }
}

function parade() {
  if (reduceMotion) return;
  const cv = $("#parade");
  cv.hidden = false;
  const dpr = Math.min(2, devicePixelRatio || 1);
  cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
  cv.style.width = innerWidth + "px"; cv.style.height = innerHeight + "px";
  const ctx = cv.getContext("2d");
  ctx.scale(dpr, dpr);
  const strips = Array.from({ length: 140 }, () => ({
    x: Math.random() * innerWidth, y: -Math.random() * innerHeight, vy: 1.2 + Math.random() * 2.2, vx: (Math.random() - 0.5) * 0.8,
    a: Math.random() * 6.28, va: (Math.random() - 0.5) * 0.12, w: 34 + Math.random() * 30,
    text: (95 + Math.random() * 10).toFixed(2), c: Math.random() < 0.5 ? "#ffffff" : "#fff3c4",
  }));
  const t0 = performance.now();
  const frame = (t) => {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const s of strips) {
      s.y += s.vy; s.x += s.vx + Math.sin((t + s.a * 300) / 500) * 0.6; s.a += s.va;
      ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(s.a);
      ctx.fillStyle = s.c; ctx.fillRect(-s.w / 2, -5, s.w, 10);
      ctx.fillStyle = "#0b1220"; ctx.font = "7px monospace"; ctx.fillText(s.text, -s.w / 2 + 3, 2.5);
      ctx.restore();
    }
    if (t - t0 < 6000) requestAnimationFrame(frame);
    else cv.hidden = true;
  };
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// records (db) and names (user)
// ---------------------------------------------------------------------------

async function recordStats(res) {
  if (!S.db || !S.uid || S.pid === null || S.recorded === res.seed) return;
  S.recorded = res.seed;
  const g = res.game;
  const r = g.standings();
  const p = g.players[S.pid];
  try {
    const ref = S.db.doc("stats/" + S.uid);
    const snap = await ref.get();
    const old = snap.exists ? snap.data() : { games: 0, wins: 0, busts: 0, best: 0, net: 0 };
    await ref.set({
      games: (old.games || 0) + 1, wins: (old.wins || 0) + (r[0].pid === S.pid ? 1 : 0), busts: (old.busts || 0) + (p.alive ? 0 : 1),
      best: Math.max(old.best || 0, Math.round(p.final - START_CASH)), net: Math.round((old.net || 0) + p.final - START_CASH),
      at: new Date().toISOString(),
    });
  } catch { /* view-only viewers keep no record */ }
}

function watchHallOfFame() {
  if (!S.db) { $("#hofTitle").hidden = $("#hof").hidden = true; return; }
  S.db.collection("stats").orderBy("wins", "desc").limit(8).onSnapshot(async (snap) => {
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (!rows.length) { $("#hof").textContent = "Win a verified round to get on it."; return; }
    let names = {};
    try { names = S.user ? await S.user.profiles(rows.map((r) => r.id)) : {}; } catch { /* unnamed */ }
    $("#hof").innerHTML = `<div class="tbl"><table><thead><tr><th>#</th><th>Trader</th><th>Wins</th><th>Rounds</th><th>Best</th></tr></thead><tbody>`
      + rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc((names[r.id] && names[r.id].name) || (r.id === S.uid ? "you" : "Someone"))}</td><td>${r.wins || 0}</td><td>${r.games || 0}</td><td>${sgn(r.best || 0)}</td></tr>`).join("")
      + `</tbody></table></div>`;
  }, () => { $("#hof").textContent = "The hall of fame isn't available in this view."; });
}

// ---------------------------------------------------------------------------
// the lobby's moving ladder
// ---------------------------------------------------------------------------

function heroLadder() {
  const cv = $("#heroCv");
  if (!cv || reduceMotion) return;
  let off = 0;
  const frame = () => {
    if ($("#lobby").hidden) return requestAnimationFrame(frame);
    const { ctx, w, h } = canvas2d(cv);
    off += 0.35;
    const rowH = 16;
    for (let y = -rowH + (off % rowH); y < h; y += rowH) {
      const i = Math.floor((y - off) / rowH);
      const n = Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
      const mid = h / 2;
      const isAsk = y < mid;
      const len = (0.15 + n * 0.75) * w * (1 - Math.min(1, Math.abs(y - mid) / (h * 0.6)) * 0.5);
      ctx.fillStyle = isAsk ? "rgba(255,138,125,.55)" : "rgba(127,162,255,.55)";
      ctx.fillRect(w - len, y + 3, len, rowH - 6);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

async function connect() {
  let tx = null;
  if (window.claude && typeof window.claude.use === "function") {
    const [room, db, user] = await Promise.all(["room", "db", "user"].map((n) => window.claude.use(n).catch(() => null)));
    S.db = db; S.user = user;
    if (user) { S.uid = await user.id(); try { const m = await user.me(); if (m.name && !$("#nameIn").value) $("#nameIn").value = m.name.split(" ")[0].slice(0, 18); } catch { /* no name */ } }
    if (room) { const t = new RoomTransport(room); if (await t.ready()) tx = t; }
  }
  if (!tx && "BroadcastChannel" in window) { tx = new ChannelTransport(); await tx.ready(); }
  S.tx = tx;
  if (tx) tx.onPeers(lobbyPeers);
  $("#hostBtn").disabled = !tx;
  $("#netNote").textContent = !tx ? "This browser can't open a shared table; solo works."
    : tx.kind === "room" ? "Tables are live: everyone who has this page open sees them and can take a seat."
    : "This copy of the page links tabs in one browser. Open the shared claude.ai version to play with other people.";
  setIdle();
  renderTables();
  watchHallOfFame();
}

// test hook: only with ?fast, which only a local test server passes
if (STEPS !== ROUND_STEPS) window.__obr = S;

$("#nameIn").value = (S.name = loadName());
wire();
heroLadder();
connect();
