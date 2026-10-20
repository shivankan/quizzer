// Shared helpers: DOM, REST API, WebSocket wrapper, timer sync.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    n.append(c.nodeType ? c : document.createTextNode(c));
  }
  return n;
}

const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---- auth token storage ----
const Auth = {
  get token() { return localStorage.getItem("qz_token"); },
  get email() { return localStorage.getItem("qz_email"); },
  set(token, email) { localStorage.setItem("qz_token", token); if (email) localStorage.setItem("qz_email", email); },
  clear() { localStorage.removeItem("qz_token"); localStorage.removeItem("qz_email"); },
};

// ---- REST ----
async function api(path, method = "GET", body = null) {
  const headers = { "Content-Type": "application/json" };
  if (Auth.token) headers["Authorization"] = "Bearer " + Auth.token;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : null });
  } catch (e) {
    // A dead/restarting server reads as a generic TypeError; say what it is so
    // it isn't mistaken for a rejected password.
    throw new Error("Can't reach the Quizzer server — it may have restarted. "
      + "Wait a moment and try again (your account is safe).");
  }
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) {
    if (res.status >= 500) {
      throw new Error("The server hit an error (" + res.status + "). Try again in a moment.");
    }
    throw new Error(data.error || ("Request failed (" + res.status + ")"));
  }
  return data;
}

// ---- WebSocket wrapper with auto-reconnect ----
class GameSocket {
  constructor() {
    this.handlers = {};
    this.ws = null;
    this.joinMsg = null;
    this.connected = false;
    this.onstatus = null;
  }
  on(type, fn) { this.handlers[type] = fn; return this; }
  connect(joinMsg) {
    this.joinMsg = joinMsg;
    this._open();
  }
  _open() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws.onopen = () => {
      this.connected = true;
      if (this.onstatus) this.onstatus(true);
      if (this.joinMsg) this.send(this.joinMsg);
    };
    this.ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      const h = this.handlers[msg.type];
      if (h) h(msg);
      if (this.handlers["*"]) this.handlers["*"](msg);
    };
    this.ws.onclose = () => {
      this.connected = false;
      if (this.onstatus) this.onstatus(false);
      setTimeout(() => this._open(), 1200); // auto-reconnect & re-send join
    };
    this.ws.onerror = () => { try { this.ws.close(); } catch (e) {} };
  }
  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }
}

// ---- server-authoritative timer ----
// Clients compute remaining = deadline - (now + clockOffset). Offset derived from
// server_now in each timer message so devices stay within ~1s of the host.
class SyncTimer {
  constructor(onTick) {
    this.onTick = onTick;
    this.deadline = null;
    this.offset = 0;        // serverNow - clientNow
    this.running = false;
    this._raf = null;
    this._loop = this._loop.bind(this);
  }
  update({ deadline, server_now, running }) {
    if (server_now) this.offset = server_now * 1000 - Date.now();
    this.deadline = deadline ? deadline * 1000 : null;
    this.running = !!running && !!deadline;
    if (this.running) this._start(); else { this._stop(); this.onTick(this.deadline ? this.remaining() : null, false); }
  }
  remaining() {
    if (!this.deadline) return null;
    return Math.max(0, (this.deadline - (Date.now() + this.offset)) / 1000);
  }
  _start() { if (!this._raf) this._raf = requestAnimationFrame(this._loop); }
  _stop() { if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; } }
  _loop() {
    const r = this.remaining();
    this.onTick(r, this.running);
    if (r <= 0) { this.running = false; this._stop(); return; }
    this._raf = requestAnimationFrame(this._loop);
  }
}

function initials(name) {
  return String(name || "?").trim().split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase() || "?";
}

// per-team avatar gradient palette (from the design handoff)
const TEAM_GRADIENTS = [
  "linear-gradient(135deg,#FFB84D,#FF7A3D)",
  "linear-gradient(135deg,#FF5468,#9B5CFF)",
  "linear-gradient(135deg,#4D7CFF,#9B5CFF)",
  "linear-gradient(135deg,#2EE58C,#4D7CFF)",
  "linear-gradient(135deg,#9B5CFF,#FF5468)",
];
function teamGradient(key) {
  const s = String(key || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return TEAM_GRADIENTS[h % TEAM_GRADIENTS.length];
}

function avatar(team, size) {
  const key = team.id || team.name;
  if (team.photo) {
    const img = el("img", { class: "avatar", src: team.photo });
    if (size) { img.style.width = size + "px"; img.style.height = size + "px"; }
    return img;
  }
  const d = el("div", { class: "avatar" }, initials(team.name));
  d.style.background = teamGradient(key);
  if (size) { d.style.width = size + "px"; d.style.height = size + "px"; d.style.fontSize = Math.round(size * 0.34) + "px"; }
  return d;
}

const QTYPE_LABEL = { buzzer: "Buzzer", freetext: "Free text", select: "Select" };

// ---- media ----
// One renderer for every surface so authoring preview and live play can't drift.
// `cap` is the surface's natural max height; media_scale shrinks within that.
function mediaEl(q, cap) {
  const url = q.media_url || q.image_url;
  if (!url) return null;
  const type = q.media_type || (q.image_url ? "image" : "");
  const scale = Math.max(20, Math.min(100, Number(q.media_scale) || 100));
  const box = el("div", { class: "qmedia" });
  box.style.width = scale + "%";
  box.style.margin = "0 auto 14px";

  if (type === "audio") {
    box.style.width = "100%";
    box.append(el("div", { class: "audio-wrap" },
      el("div", { class: "audio-icon" }, "♪"),
      el("audio", { src: url, controls: "controls", preload: "metadata", style: "width:100%;" })));
  } else if (type === "video") {
    const v = el("video", { src: url, controls: "controls", playsinline: "playsinline", preload: "metadata" });
    if (cap) v.style.maxHeight = cap;
    box.append(v);
  } else {
    const img = el("img", { src: url, alt: "" });
    if (cap) img.style.maxHeight = cap;
    box.append(img);
  }
  return box;
}

// Append question text and media in the author's chosen order. Every surface
// goes through this so "media first" means the same thing everywhere.
function appendQuestionBody(container, q, cap, textNode) {
  const m = mediaEl(q, cap);
  const parts = q && q.media_first ? [m, textNode] : [textNode, m];
  parts.forEach((p) => { if (p) container.append(p); });
}

function mediaLabel(q) {
  const t = q.media_type || (q.image_url || q.media_url ? "image" : "");
  return { image: "🖼 Image", audio: "🎵 Audio", video: "🎬 Video" }[t] || "";
}
const SVGNS = "http://www.w3.org/2000/svg";

// SVG countdown ring. Returns {node, set(fraction)} — fraction 1→0 drains + colors.
function makeRing(size, numFontPx) {
  const R = 88, DASH = 553;
  const wrap = el("div", { class: "ring" });
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("width", size); svg.setAttribute("height", size); svg.setAttribute("viewBox", "0 0 200 200");
  const bg = document.createElementNS(SVGNS, "circle");
  bg.setAttribute("cx", 100); bg.setAttribute("cy", 100); bg.setAttribute("r", R);
  bg.setAttribute("fill", "none"); bg.setAttribute("stroke", "rgba(255,255,255,.09)"); bg.setAttribute("stroke-width", 14);
  const fg = document.createElementNS(SVGNS, "circle");
  fg.setAttribute("cx", 100); fg.setAttribute("cy", 100); fg.setAttribute("r", R);
  fg.setAttribute("fill", "none"); fg.setAttribute("stroke-width", 14); fg.setAttribute("stroke-linecap", "round");
  fg.setAttribute("stroke-dasharray", DASH);
  svg.append(bg, fg);
  const num = el("div", { class: "ring-num" });
  num.style.setProperty("--ring-fs", (numFontPx || Math.round(size * 0.32)) + "px");
  wrap.append(svg, num);
  function set(frac, label) {
    frac = Math.max(0, Math.min(1, frac));
    fg.setAttribute("stroke-dashoffset", DASH * (1 - frac));
    const color = frac > 0.4 ? "#2EE58C" : (frac >= 0.2 ? "#FFB84D" : "#FF5468");
    fg.setAttribute("stroke", color);
    num.textContent = label;
    num.style.color = color;
    wrap.classList.toggle("beat", frac < 0.34 && frac > 0);
  }
  return { node: wrap, set };
}

function confettiBurst(root) {
  const box = el("div", { class: "confetti" });
  const colors = ["#4D7CFF", "#9B5CFF", "#2EE58C", "#FFB84D", "#FF5468", "#7D9EFF"];
  for (let i = 0; i < 46; i++) {
    const p = el("i", {});
    p.style.left = Math.random() * 100 + "%";
    p.style.background = colors[i % colors.length];
    p.style.animationDuration = (2.8 + Math.random() * 2.4) + "s";
    p.style.animationDelay = (Math.random() * 1.2) + "s";
    box.append(p);
  }
  root.append(box);
  return box;
}

// Fun, loud callout when a team backgrounds the app or drops mid-question.
// Shown on the host console, present mode, and the shared display.
const AWAY_QUIPS = [
  "just left the app 👀",
  "switched apps — no Googling! 🔍",
  "wandered off mid-question 🚶",
  "is suspiciously elsewhere 🤔",
];
const OFFLINE_QUIPS = [
  "dropped off the grid 📡",
  "lost connection 🔌",
  "vanished 💨",
];

// Alerts are coalesced: when several teams drop at once (a flaky room, everyone
// checking their phone), one combined banner is far more readable than a stack
// of near-identical ones. Keyed by team id so a flapping team counts once.
const GROUP_QUIPS = ["are suspiciously busy elsewhere 👀", "all wandered off at once 🤨",
                     "left the app together — coincidence? 🕵️"];
let _pending = new Map();
let _flushTimer = null;

function presenceAlert(name, state, id) {
  _pending.set(id || name, { name, state });
  clearTimeout(_flushTimer);
  _flushTimer = setTimeout(flushPresenceAlerts, 900);
}

function flushPresenceAlerts() {
  const items = Array.from(_pending.values());
  _pending = new Map();
  if (!items.length) return;

  let stack = document.querySelector(".alert-stack");
  if (!stack) { stack = el("div", { class: "alert-stack" }); document.body.append(stack); }
  // never let banners pile past 3 — drop the oldest
  while (stack.children.length >= 3) stack.firstChild.remove();

  const anyOffline = items.some((i) => i.state === "offline");
  let text, icon;
  if (items.length === 1) {
    const pool = items[0].state === "offline" ? OFFLINE_QUIPS : AWAY_QUIPS;
    text = items[0].name + " " + pool[Math.floor(Math.random() * pool.length)];
    icon = items[0].state === "offline" ? "📡" : "👀";
  } else {
    const names = items.map((i) => i.name);
    const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3} more` : "");
    text = `${names.length} teams ${GROUP_QUIPS[Math.floor(Math.random() * GROUP_QUIPS.length)]} — ${shown}`;
    icon = anyOffline ? "📡" : "👀";
  }

  const node = el("div", { class: "alert-flash" + (anyOffline ? " offline" : "") },
    el("span", { class: "eyes" }, icon), el("span", { class: "grow" }, text));
  stack.append(node);
  setTimeout(() => {
    node.classList.add("out");
    setTimeout(() => { node.remove(); if (stack && !stack.children.length) stack.remove(); }, 400);
  }, items.length > 1 ? 7000 : 5000);
}

function orbs() {
  return el("div", { class: "orbs" }, el("div", { class: "orb b" }), el("div", { class: "orb v" }), el("div", { class: "orb g" }));
}
document.addEventListener("DOMContentLoaded", () => { if (!document.querySelector(".orbs")) document.body.prepend(orbs()); });
