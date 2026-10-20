// Participant: join, buzz, answer, timer sync, reconnect.

let P = { code: "", teamId: null, name: "", photo: "", phase: "lobby", q: null, index: -1, total: 0, selection: [], buzzPos: null, ws: null };

const params = new URLSearchParams(location.search);
const last = JSON.parse(localStorage.getItem("qz_last") || "null");
if (params.get("code")) $("#code").value = params.get("code").toUpperCase();
else if (last && last.code) $("#code").value = last.code;
if (last && last.name) $("#teamName").value = last.name;

// ---- keep the screen awake during a game (Wake Lock API) ----
let wakeLock = null;
async function keepAwake() {
  try {
    if (navigator.wakeLock && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    }
  } catch (e) { /* not supported / not allowed — presence + reattach still cover us */ }
}

// ---- presence: tell the host when this device is backgrounded ----
document.addEventListener("visibilitychange", () => {
  const away = document.visibilityState !== "visible";
  if (P.ws && P.teamId) P.ws.send({ type: "presence", away });
  if (!away) keepAwake(); // wake locks are auto-released on background; re-acquire
});

function showView(name) {
  for (const v of ["join", "wait", "play", "scores"]) $("#view-" + v).classList.toggle("hide", v !== name);
}

// ---- photo capture -> small data URL ----
let photoData = "";
$("#photo").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const max = 256, scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = img.width * scale; c.height = img.height * scale;
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      photoData = c.toDataURL("image/jpeg", 0.7);
      const pv = $("#photoPreview"); pv.src = photoData; pv.style.display = "block";
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});

// ---- join ----
function teamKey(code) { return "qz_team_" + code; }

$("#joinBtn").onclick = doJoin;
$("#teamName").addEventListener("keydown", (e) => { if (e.key === "Enter") doJoin(); });

async function doJoin() {
  const code = $("#code").value.trim().toUpperCase();
  const name = $("#teamName").value.trim();
  $("#joinErr").textContent = "";
  if (!code) return ($("#joinErr").textContent = "Enter the room code.");
  if (!name) return ($("#joinErr").textContent = "Enter a team name.");
  // verify room exists for a friendlier error
  try {
    const r = await (await fetch("/api/rooms/" + encodeURIComponent(code))).json();
    if (!r.exists) return ($("#joinErr").textContent = "No game found with that code.");
  } catch (e) {}
  // Reuse this device's saved team for the room (prevents duplicate teams on
  // reload / screen-off); the server also reattaches by name as a fallback.
  const saved = JSON.parse(localStorage.getItem(teamKey(code)) || "null");
  P.code = code; P.name = name;
  P.photo = photoData || (saved && saved.photo) || "";
  P.teamId = saved ? saved.teamId : null;
  connect();
}

// auto-rejoin if we have a stored team for this code
(function tryAutoRejoin() {
  const code = $("#code").value.trim().toUpperCase();
  if (!code) return;
  const saved = localStorage.getItem(teamKey(code));
  if (saved) {
    const t = JSON.parse(saved);
    P.code = code; P.name = t.name; P.photo = t.photo || ""; P.teamId = t.teamId;
    connect();
  }
})();

function connect() {
  const ws = new GameSocket();
  P.ws = ws;
  P.timer = new SyncTimer((rem) => updateTimer(rem));
  ws.onstatus = (up) => { $("#connState").textContent = up ? "" : "reconnecting…"; };
  ws
    .on("joined", (m) => {
      P.teamId = m.teamId; P.name = m.name;
      localStorage.setItem(teamKey(P.code), JSON.stringify({ teamId: m.teamId, name: m.name, photo: P.photo }));
      localStorage.setItem("qz_last", JSON.stringify({ code: P.code, name: m.name }));
      history.replaceState(null, "", "/play.html?code=" + encodeURIComponent(P.code));
      keepAwake();
      $("#waitName").textContent = m.name;
      $("#waitCode").textContent = P.code;
      $("#waitAvatar").textContent = initials(m.name);
      $("#waitAvatar").style.background = teamGradient(m.teamId);
      if (P.photo) { const a = $("#waitAvatar"); a.style.background = "url(" + P.photo + ") center/cover"; a.textContent = ""; }
    })
    .on("state", (m) => {
      P.phase = m.phase; P.q = m.q; P.index = m.index; P.total = m.total;
      if (m.has_buzzer !== undefined) P.hasBuzzer = m.has_buzzer;
      routeView(); renderBuzzCheck();
    })
    .on("buzz_test_ok", () => { P.tested = true; renderBuzzCheck(); })
    .on("lock_state", (m) => { P.locked = m.locked; renderLockBar(); })
    .on("locks", (m) => { P.lockInfo = m; P.locked = (m.locked || []).includes(P.teamId); renderLockBar(); })
    .on("question", (m) => {
      P.phase = "active"; P.q = m.q; P.index = m.index; P.total = m.total;
      P.selection = []; P.buzzPos = null; P.locked = false; P.lockInfo = null;
      routeView(); renderPlayStage();
    })
    .on("phase", (m) => { P.phase = m.phase; if (m.q) P.q = m.q; routeView(); renderPlayStage(); })
    .on("timer", (m) => P.timer.update(m))
    .on("your_buzz", (m) => { P.buzzPos = m.position; updateBuzzFeedback(m); })
    .on("buzz", (m) => { P.buzz = m; updateBuzzState(); })
    .on("ack_text", () => { const s = $("#saveDot"); if (s) { s.textContent = "saved ✓"; } })
    .on("ack_select", (m) => { P.selection = m.selection; markSelections(); })
    .on("reveal", (m) => { P.reveal = m; })
    .on("scoreboard", (m) => { P.scores = m.rows; if (!$("#view-scores").classList.contains("hide")) renderScores(); })
    .on("ended", (m) => { P.phase = "ended"; P.scores = m.rows; routeView(); })
    .on("error", (m) => {
      if ($("#view-join").classList.contains("hide")) alert(m.message);
      else $("#joinErr").textContent = m.message;
    });
  ws.connect({ type: "team_join", code: P.code, name: P.name, photo: P.photo, teamId: P.teamId });
}

// ---- pre-quiz buzzer check (lobby only, buzzer quizzes only) ----
function renderBuzzCheck() {
  const box = $("#buzzCheck");
  if (!box) return;
  const show = P.phase === "lobby" && P.hasBuzzer;
  box.classList.toggle("hide", !show);
  if (!show) return;
  const mount = $("#buzzCheckMount");
  if (!mount.firstChild) {
    const disc = el("div", { class: "buzzdisc", id: "testDisc", style: "width:min(48vw,150px);" },
      el("div", { class: "halo" }), el("div", { class: "gloss" }),
      el("div", { class: "face" }, el("span", {}, "TEST")));
    disc.addEventListener("pointerdown", () => disc.classList.add("pressed"));
    disc.addEventListener("pointerup", () => disc.classList.remove("pressed"));
    disc.addEventListener("pointerleave", () => disc.classList.remove("pressed"));
    disc.addEventListener("click", () => {
      const rip = el("div", { class: "ripple" });
      disc.append(rip); setTimeout(() => rip.remove(), 600);
      if (navigator.vibrate) navigator.vibrate(30);
      P.ws.send({ type: "buzz_test" });
      keepAwake();
    });
    mount.append(disc);
  }
  const disc = $("#testDisc");
  const face = disc.querySelector(".face span");
  if (P.tested) {
    disc.classList.add("up"); face.textContent = "✓";
    $("#buzzCheckMsg").innerHTML = "";
    $("#buzzCheckMsg").append(el("span", { class: "armed-note" }, "Buzzer works — you're ready"));
  } else {
    disc.classList.remove("up"); face.textContent = "TEST";
    $("#buzzCheckMsg").textContent = "Give it a tap to make sure your buzzer works.";
  }
}

function routeView() {
  if (P.phase === "lobby") { showView("wait"); renderBuzzCheck(); return; }
  if (P.phase === "ended") {
    showView("scores"); $("#closeScores").classList.add("hide");
    $("#view-scores h2").textContent = "🏆 Final results"; renderScores();
    if (!document.querySelector(".confetti")) confettiBurst(document.body);
    return;
  }
  showView("play");
  renderPlayStage();
}

// ---- scoreboard overlay ----
$("#showScores").onclick = () => { showView("scores"); $("#closeScores").classList.remove("hide"); renderScores(); };
$("#closeScores").onclick = () => routeView();

function renderScores() {
  const root = $("#scoreList");
  root.innerHTML = "";
  const rows = P.scores || [];
  if (!rows.length) { root.append(el("p", { class: "muted" }, "No scores yet.")); return; }
  rows.forEach((row) => {
    root.append(scoreboardRow(row, row.id === P.teamId));
  });
}

function scoreboardRow(row, isYou) {
  const leader = row.rank === 1;
  const name = el("div", { class: "sb-name" });
  if (leader) name.append(el("span", { class: "crown" }, "♔"));
  name.append(document.createTextNode(row.name + (isYou ? " (you)" : "")));
  const delta = el("div", {});
  if (row.delta > 0) delta.className = "sb-delta up", delta.textContent = "+" + row.delta;
  const score = el("div", { class: "sb-score" }, String(row.score));
  return el("div", { class: "sb-row" + (leader ? " leader" : "") + (isYou ? " you" : "") },
    el("div", { class: "sb-rank" }, String(row.rank)), avatar(row), name, delta, score);
}

// ---- play stage ----
function renderPlayStage() {
  if (P.phase !== "active" && P.phase !== "review" && P.phase !== "scoreboard") return;
  const stage = $("#playStage");
  P.ringApi = null; P.barEl = null;
  const badge = $("#pType");
  badge.textContent = P.q ? (P.q.type === "buzzer" ? "BUZZER" : P.q.type === "freetext" ? "FREE TEXT" : (P.q.multi_select ? "SELECT MANY" : "SELECT ONE")) : "";
  badge.className = "pill " + (P.q ? P.q.type : "");
  $("#pProgress").textContent = P.q ? `Q${P.index + 1} · ${P.total}` : "";
  stage.innerHTML = "";

  if (P.phase === "scoreboard") {
    stage.append(el("div", { class: "center pop", style: "padding:20px 0;" },
      el("div", { class: "overline" }, "Round complete"),
      el("h1", { style: "margin:6px 0 14px;" }, "Nice round!"),
      revealEl(),
      el("button", { class: "btn primary lg", style: "margin-top:18px;", onclick: () => { showView("scores"); $("#closeScores").classList.remove("hide"); renderScores(); } }, "See scoreboard →")));
    return;
  }
  if (!P.q) return;

  // points pill in header area
  stage.append(el("div", { class: "row spread", style: "margin-bottom:12px;" },
    el("span", { class: "pill" }, P.q.points + " PTS"),
    (P.q.timer_seconds > 0 && P.q.type !== "freetext") ? timerRing() : el("span", {})));

  appendQuestionBody(stage, P.q, "34vh", P.q.text
    ? el("div", { style: "font:600 20px/1.35 'Outfit'; margin-bottom:14px; text-wrap:pretty;" }, P.q.text)
    : null);

  if (P.phase === "review") {
    stage.append(el("div", { class: "banner violet", style: "margin-top:8px;" }, "⏳ Time's up — the host is judging answers…"));
    return;
  }

  if (P.q.type === "buzzer") renderBuzzer(stage);
  else if (P.q.type === "freetext") renderFreetext(stage);
  else if (P.q.type === "select") renderSelect(stage);

  // lock-in control for every non-buzzer question
  if (P.q.type !== "buzzer") {
    stage.append(el("div", { id: "lockBar", style: "margin-top:16px;" }));
    renderLockBar();
  }

  if (P.timer) updateTimer(P.timer.remaining());
}

// ---- lock in / unlock to edit ----
function renderLockBar() {
  const bar = $("#lockBar");
  if (!bar) return;
  bar.innerHTML = "";
  const info = P.lockInfo || {};
  if (P.locked) {
    bar.append(el("div", { class: "banner good", style: "display:flex; align-items:center; gap:10px;" },
      el("span", { class: "grow" }, "✓ Locked in — your answer is final"),
      el("button", { class: "btn sm", onclick: () => P.ws.send({ type: "lock_in", locked: false }) }, "Edit")));
  } else {
    bar.append(el("button", { class: "btn primary block lg", onclick: () => P.ws.send({ type: "lock_in", locked: true }) }, "🔒 Lock in"));
  }
  if (info.total) {
    bar.append(el("p", { class: "muted tiny center", style: "margin-top:8px;" },
      `${info.count} of ${info.total} teams locked in` + (P.locked ? " · you can still edit until time runs out" : "")));
  }
  setInputsDisabled(P.locked);
}

function setInputsDisabled(locked) {
  const ta = $("#ftInput");
  if (ta) { ta.disabled = !!locked; ta.style.opacity = locked ? ".55" : "1"; }
  $$("#playStage .opt-card").forEach((c) => {
    c.style.pointerEvents = locked ? "none" : "";
    c.style.opacity = locked ? ".6" : "1";
  });
}

function timerRing() {
  const r = makeRing(52, 17);
  P.ringApi = r;
  return r.node;
}

function renderBuzzer(stage) {
  const wrap = el("div", { class: "buzzdisc", id: "buzzBtn" },
    el("div", { class: "halo" }), el("div", { class: "gloss" }),
    el("div", { class: "face" }, el("span", {}, "BUZZ")));
  const doBuzz = (e) => {
    e && e.preventDefault();
    if (P.buzz && P.buzz.closed) return;
    // ripple
    const rip = el("div", { class: "ripple" });
    wrap.append(rip); setTimeout(() => rip.remove(), 600);
    P.ws.send({ type: "buzz" });
    if (navigator.vibrate) navigator.vibrate(30);
  };
  wrap.addEventListener("pointerdown", () => wrap.classList.add("pressed"));
  wrap.addEventListener("pointerup", () => wrap.classList.remove("pressed"));
  wrap.addEventListener("pointerleave", () => wrap.classList.remove("pressed"));
  wrap.addEventListener("click", doBuzz);
  stage.append(el("div", { class: "center", style: "margin:22px 0 6px;" }, wrap));
  stage.append(el("div", { class: "center", id: "buzzMsg", style: "min-height:26px; font:700 14px 'Outfit';" },
    el("span", { class: "armed-note" }, el("span", { class: "armed-dot" }), "Armed — tap when you know it")));
  updateBuzzState();
}

function updateBuzzState() {
  const wrap = $("#buzzBtn"); if (!wrap) return;
  const face = wrap.querySelector(".face span");
  wrap.classList.remove("up", "inline", "locked");
  const closed = P.buzz && P.buzz.closed;
  if (closed && P.buzzPos !== 1) { wrap.classList.add("locked"); face.textContent = "CLOSED"; }
  else if (P.buzzPos === 1) { wrap.classList.add("up"); face.textContent = "YOU'RE UP!"; }
  else if (P.buzzPos) { wrap.classList.add("inline"); face.textContent = "#" + P.buzzPos; }
  else { face.textContent = "BUZZ"; }
}

function updateBuzzFeedback(m) {
  const msg = $("#buzzMsg");
  if (!msg) return;
  if (m.closed && m.position == null) { msg.innerHTML = ""; msg.append(el("span", { class: "muted" }, "Buzzing is closed.")); updateBuzzState(); return; }
  msg.innerHTML = "";
  if (m.position === 1) msg.append(el("span", { class: "armed-note", style: "color:var(--green)" }, "✅ You buzzed first — answer out loud!"));
  else if (m.position) msg.append(el("span", { class: "muted" }, "Buzz registered — you're #" + m.position + " in line."));
  msg.classList.add("flash"); setTimeout(() => msg.classList.remove("flash"), 600);
  updateBuzzState();
}

function renderFreetext(stage) {
  // draining bar above the field
  const bar = el("div", { class: "timerbar", style: "margin-bottom:14px;" }, el("div", { style: "width:100%;" }));
  P.barEl = bar.firstChild;
  if (P.q.timer_seconds > 0) stage.append(bar);

  const ta = el("textarea", { id: "ftInput", placeholder: "Type your answer…", style: "min-height:96px; font-size:18px;" });
  let timer = null;
  const sendNow = () => { P.ws.send({ type: "submit_text", text: ta.value }); };
  ta.addEventListener("input", () => {
    const s = $("#saveDot"); if (s) s.textContent = "saving…";
    clearTimeout(timer); timer = setTimeout(sendNow, 350);
  });
  stage.append(ta);
  stage.append(el("div", { class: "row", style: "margin-top:10px; gap:6px;" },
    el("span", { class: "tiny ok", id: "saveDot" }, "✓ Saved"),
    el("span", { class: "muted tiny" }, "— edit as often as you like; your last answer counts at 0:00.")));
  setTimeout(() => ta.focus(), 50);
}

function renderSelect(stage) {
  const box = el("div", { class: "stack" });
  P.q.options.forEach((opt, i) => {
    box.append(el("div", { class: "opt-card", "data-i": i, onclick: () => toggleSelect(i) },
      el("span", { class: "chip-letter" }, String.fromCharCode(65 + i)),
      el("span", { class: "grow" }, opt),
      el("span", { class: "tick" }, "✓")));
  });
  stage.append(box);
  stage.append(el("p", { class: "muted tiny", style: "margin-top:10px;" },
    P.q.multi_select ? "Pick all that apply — change until time runs out." : "Pick one — change until time runs out."));
  markSelections();
}

function toggleSelect(i) {
  if (P.q.multi_select) {
    P.selection = P.selection.includes(i) ? P.selection.filter(x => x !== i) : [...P.selection, i];
  } else {
    P.selection = [i];
  }
  markSelections();
  P.ws.send({ type: "submit_select", selection: P.selection });
}

function markSelections() {
  $$("#playStage [data-i]").forEach((b) => {
    const i = Number(b.getAttribute("data-i"));
    b.classList.toggle("on", P.selection.includes(i));
  });
}

function revealEl() {
  const r = P.reveal;
  if (r && r.qtype === "select" && r.correct_options) return el("div", { class: "banner good", style: "margin-top:10px;" }, "Correct: " + r.correct_options.join(", "));
  return el("span", {});
}

// ---- timer (ring for select/buzzer, bar for freetext) ----
function updateTimer(rem) {
  if (rem === null || !P.q || !P.q.timer_seconds) return;
  const frac = rem / P.q.timer_seconds;
  if (P.ringApi) P.ringApi.set(frac, String(Math.ceil(rem)));
  if (P.barEl) {
    P.barEl.style.width = Math.max(0, frac * 100) + "%";
    P.barEl.style.background = frac > 0.4 ? "var(--green)" : (frac >= 0.2 ? "var(--amber)" : "var(--red)");
  }
}

showView("join");
