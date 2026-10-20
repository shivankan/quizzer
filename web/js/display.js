// Shared display (TV/projector): question, timer, buzz state, scoreboard.

let D = { code: "", phase: "lobby", q: null, index: -1, total: 0, teams: [], buzz: null, scores: null };

const params = new URLSearchParams(location.search);
if (params.get("code")) { $("#code").value = params.get("code").toUpperCase(); setTimeout(connect, 0); }

function showStage(on) { $("#view-connect").classList.toggle("hide", on); $("#view-stage").classList.toggle("hide", !on); }

$("#connectBtn").onclick = connect;
$("#code").addEventListener("keydown", (e) => { if (e.key === "Enter") connect(); });

async function connect() {
  const code = $("#code").value.trim().toUpperCase();
  if (!code) return;
  try {
    const r = await (await fetch("/api/rooms/" + encodeURIComponent(code))).json();
    if (!r.exists) return ($("#err").textContent = "No game found with that code.");
  } catch (e) {}
  D.code = code;
  const ws = new GameSocket();
  D.ws = ws;
  D.timer = new SyncTimer((rem) => updateTimer(rem));
  ws
    .on("joined", (m) => { $("#title").textContent = m.title; showStage(true); })
    .on("state", (m) => { D.phase = m.phase; D.q = m.q; D.index = m.index; D.total = m.total; render(); })
    .on("roster", (m) => { D.teams = m.teams; if (D.phase === "lobby") render(); })
    .on("question", (m) => { D.phase = "active"; D.q = m.q; D.index = m.index; D.total = m.total; render(); })
    .on("phase", (m) => { D.phase = m.phase; if (m.q) D.q = m.q; render(); })
    .on("timer", (m) => D.timer.update(m))
    .on("buzz", (m) => { D.buzz = m; if (D.phase === "active") render(); })
    .on("locks", (m) => { D.locks = m; if (D.phase === "active") render(); })
    .on("presence_alert", (m) => presenceAlert(m.name, m.state))
    .on("reveal", (m) => { D.reveal = m; })
    .on("scoreboard", (m) => { D.phase = "scoreboard"; D.scores = m.rows; render(); })
    .on("ended", (m) => { D.phase = "ended"; D.scores = m.rows; render(); })
    .on("error", (m) => { $("#err").textContent = m.message; });
  ws.connect({ type: "display_join", code });
}

function render() {
  D.ringApi = null; D.barEl = null;
  const label = { lobby: "Lobby", active: "Live", review: "Reviewing", scoreboard: "Scoreboard", ended: "Finished" };
  $("#phasePill").textContent = label[D.phase] || D.phase;
  $("#progress").textContent = (D.index >= 0 && D.q) ? `Question ${D.index + 1} of ${D.total}` : "";
  const s = $("#stage");
  s.innerHTML = "";
  document.querySelectorAll(".confetti").forEach(c => c.remove());

  if (D.phase === "lobby") return renderLobby(s);
  if (D.phase === "ended") return renderWinner(s);
  if (D.phase === "scoreboard") {
    s.append(el("div", { class: "overline center", style: "margin-bottom:10px;" }, "Scoreboard" + (D.index >= 0 ? " · after question " + (D.index + 1) : "")));
    s.append(scoreboardEl(D.scores || [], true));
    s.append(el("p", { class: "muted center", style: "margin-top:14px;" }, "Next question in a moment — the host has the wheel."));
    return;
  }
  if (!D.q) return;

  const badgeText = D.q.type === "buzzer" ? "BUZZER" : D.q.type === "freetext" ? "FREE TEXT" : (D.q.multi_select ? "SELECT MANY" : "SELECT ONE");
  s.append(el("div", { class: "row spread", style: "margin-bottom:10px;" },
    el("div", { class: "row", style: "gap:10px;" },
      el("span", { class: "pill " + D.q.type }, badgeText),
      el("span", { class: "pill" }, D.q.points + " PTS")),
    (D.q.timer_seconds > 0) ? bigRing() : el("span", {})));

  s.append(el("div", { class: "qbig" }, D.q.text || ""));
  if (D.q.image_url) s.append(el("div", { class: "qmedia center", style: "margin-bottom:18px;" }, el("img", { src: D.q.image_url })));

  if (D.q.type === "select") {
    const grid = el("div", { class: "grid cols2" });
    D.q.options.forEach((o, i) => grid.append(el("div", { class: "opt-card", style: "font-size:22px;" },
      el("span", { class: "chip-letter", style: "width:46px;height:46px;border-radius:14px;font-size:20px;" }, String.fromCharCode(65 + i)),
      el("span", { class: "grow" }, o))));
    s.append(grid);
  }

  if (D.phase === "review") {
    s.append(el("div", { class: "banner violet center", style: "margin-top:22px; font-size:22px;" },
      D.q.type === "freetext" ? "⏳ Time's up — the host is judging…" : "⏳ Time's up — reviewing answers…"));
    return;
  }

  if (D.q.type === "buzzer") renderBuzz(s);
  else if (D.locks && D.locks.total) {
    s.append(el("div", { class: "center", style: "margin-top:22px;" },
      el("div", { class: D.locks.all_in ? "banner good" : "banner", style: "font-size:24px; display:inline-block;" },
        D.locks.all_in ? `✓ All ${D.locks.total} teams locked in` : `🔒 ${D.locks.count} of ${D.locks.total} teams locked in`)));
  }
  if (D.timer) updateTimer(D.timer.remaining());
}

function bigRing() { const r = makeRing(120, 40); D.ringApi = r; return r.node; }

function renderLobby(s) {
  s.append(el("div", { class: "center", style: "padding:20px 0 10px;" },
    el("div", { class: "overline" }, "Join at " + location.host + "/play.html — enter code"),
    el("div", { class: "code-hero", style: "margin:14px 0 30px;" }, D.code)));
  s.append(el("h3", { class: "center" }, D.teams.length ? D.teams.length + " team" + (D.teams.length === 1 ? "" : "s") + " in — waiting for more…" : "Waiting for teams…"));
  const chips = el("div", { class: "chips", style: "justify-content:center;" });
  D.teams.forEach((t, i) => {
    const c = el("div", { class: "chip pop" }, avatar(t, 30), t.name,
      t.tested ? el("span", { class: "pill green" }, "✓") : null);
    c.style.animationDelay = (i * 0.08) + "s";
    chips.append(c);
  });
  s.append(chips);
  const tested = D.teams.filter((t) => t.tested).length;
  if (D.teams.length && tested < D.teams.length) {
    s.append(el("p", { class: "muted center", style: "margin-top:16px; font-size:18px;" },
      `${tested} of ${D.teams.length} have tested their buzzer — tap TEST on your phone`));
  } else if (D.teams.length) {
    s.append(el("p", { class: "center", style: "margin-top:16px; font-size:18px; color:var(--green);" },
      "✓ All buzzers tested — ready to play"));
  }
}

function renderBuzz(s) {
  const b = D.buzz || { queue: [], top: null, locked: [] };
  const wrap = el("div", { style: "margin-top:16px;" });
  if (b.top) {
    wrap.append(el("div", { class: "center pop", style: "padding:12px 0;" },
      el("div", { style: "font:900 clamp(40px,8vw,116px) 'Unbounded'; color:var(--green); filter:drop-shadow(0 0 24px rgba(46,229,140,.5)); line-height:1;" }, "🔔 " + b.top.name),
      el("div", { class: "overline", style: "color:var(--green); margin-top:10px;" }, "— Answer! —")));
  } else if (b.closed) {
    wrap.append(el("div", { class: "banner center", style: "font-size:24px;" }, "Buzzing closed"));
  } else {
    wrap.append(el("div", { class: "row center", style: "justify-content:center; gap:12px;" },
      el("span", { class: "armed-note", style: "font-size:22px;" }, el("span", { class: "armed-dot" }), "Buzzers are armed")));
    wrap.append(el("p", { class: "muted center", style: "margin-top:10px;" }, "First correct = full points · correct after a wrong attempt = half."));
  }
  const lockedSet = new Set(b.locked || []);
  if (b.queue.length) {
    const list = el("div", { style: "margin-top:20px; max-width:520px; margin-left:auto; margin-right:auto;" });
    list.append(el("div", { class: "overline center", style: "margin-bottom:10px;" }, "In line"));
    b.queue.forEach((item, i) => {
      const isTop = b.top && b.top.id === item.id;
      const row = el("div", { class: "queue-item pop" + (isTop ? " top" : "") + (lockedSet.has(item.id) ? " locked" : "") },
        el("div", { class: "queue-pos" }, String(i + 1)), el("div", { class: "grow qname", style: "font-size:18px;" }, item.name));
      row.style.animationDelay = (i * 0.08) + "s";
      list.append(row);
    });
    wrap.append(list);
  }
  s.append(wrap);
}

function renderWinner(s) {
  const rows = D.scores || [];
  const win = rows[0];
  confettiBurst(document.body);
  s.append(el("div", { class: "center", style: "padding:10px 0;" },
    el("div", { class: "crown", style: "font-size:56px;" }, "♔"),
    el("div", { class: "overline", style: "margin-top:6px;" }, "Champions"),
    el("div", { style: "font:900 clamp(48px,10vw,152px) 'Unbounded'; margin:8px 0; background:var(--grad-gold); -webkit-background-clip:text; background-clip:text; color:transparent; filter:drop-shadow(0 0 28px rgba(255,184,77,.4));" }, win ? win.name : "—"),
    win ? el("div", { class: "muted", style: "font-size:20px;" }, win.score + " points") : ""));
  s.append(el("div", { style: "max-width:640px; margin:20px auto 0;" }, scoreboardEl(rows, false)));
  s.append(el("p", { class: "muted center", style: "margin-top:16px;" }, "Thanks for playing — same time next week?"));
}

function scoreboardEl(rows, big) {
  const box = el("div", {});
  if (!rows.length) { box.append(el("p", { class: "muted center" }, "No teams.")); return box; }
  rows.forEach((row, idx) => {
    const leader = row.rank === 1;
    const name = el("div", { class: "sb-name", style: big ? "font-size:22px;" : "" });
    if (leader) name.append(el("span", { class: "crown" }, "♔"));
    name.append(document.createTextNode(row.name));
    const delta = el("div", {});
    if (row.delta > 0) { delta.className = "sb-delta up"; delta.textContent = "↑ +" + row.delta; }
    const score = el("div", { class: "sb-score", style: big ? "font-size:30px;" : "" }, String(row.score));
    if (row.delta > 0) score.append(el("div", { class: "float-pts" }, "+" + row.delta));
    const r = el("div", { class: "sb-row pop" + (leader ? " leader" : ""), style: big ? "padding:16px 20px;" : "" },
      el("div", { class: "sb-rank", style: big ? "width:44px;height:44px;font-size:20px;" : "" }, String(row.rank)),
      avatar(row, big ? 48 : 38), name, delta, score);
    r.style.animationDelay = (idx * 0.06) + "s";
    box.append(r);
  });
  return box;
}

function updateTimer(rem) {
  if (rem === null || !D.q || !D.q.timer_seconds) return;
  const frac = rem / D.q.timer_seconds;
  if (D.ringApi) D.ringApi.set(frac, String(Math.ceil(rem)));
}

showStage(false);
