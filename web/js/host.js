// Host console: dashboard, quiz authoring, and live room control.

if (!Auth.token) location.href = "/";
$("#whoami").textContent = Auth.email || "";
$("#logout").onclick = () => { Auth.clear(); location.href = "/"; };

function showView(name) {
  for (const v of ["dash", "editor", "live"]) $("#view-" + v).classList.toggle("hide", v !== name);
}

// ============================ DASHBOARD ============================

async function loadQuizzes() {
  const list = $("#quizList");
  list.innerHTML = "";
  let data;
  try { data = await api("/api/quizzes"); }
  catch (e) { if (String(e).includes("authenticated")) { Auth.clear(); location.href = "/"; } return; }
  if (!data.quizzes.length) {
    list.append(el("p", { class: "muted" }, "No quizzes yet. Create one to get started."));
    return;
  }
  for (const q of data.quizzes) {
    list.append(el("div", { class: "quizitem" },
      el("div", {},
        el("div", { class: "title" }, q.title),
        el("div", { class: "muted tiny" }, `${q.qcount} question${q.qcount === 1 ? "" : "s"}`)),
      el("div", { class: "row" },
        el("button", { class: "btn sm", onclick: () => openEditor(q.id) }, "Edit"),
        el("button", { class: "btn sm primary", onclick: () => hostLive(q.id), disabled: q.qcount === 0 }, "Host live →"),
        el("button", { class: "btn sm ghost", title: "Download as .json backup", onclick: () => exportQuiz(q.id) }, "⬇"),
        el("button", { class: "btn sm ghost", onclick: () => deleteQuiz(q.id, q.title) }, "🗑"))
    ));
  }
}

// ---- starter quizzes (shipped in the repo, survive disk wipes) ----
async function loadSeeds() {
  const root = $("#seedList");
  root.innerHTML = "";
  let data;
  try { data = await api("/api/seeds"); } catch (e) { return; }
  if (!data.seeds.length) {
    root.append(el("p", { class: "muted tiny" }, "No starter quizzes bundled. Add .json files to the seeds/ folder in the repo."));
    return;
  }
  for (const s of data.seeds) {
    const parts = Object.entries(s.breakdown || {})
      .map(([t, n]) => n + " " + (QTYPE_LABEL[t] || t).toLowerCase()).join(" · ");
    root.append(el("div", { class: "quizitem" },
      el("div", {},
        el("div", { class: "title" }, s.title),
        el("div", { class: "muted tiny" }, `${s.count} question${s.count === 1 ? "" : "s"}${parts ? " — " + parts : ""}`)),
      el("button", { class: "btn sm", onclick: (e) => addSeed(s.name, e.target) }, "+ Add to my quizzes")));
  }
}

async function addSeed(name, btn) {
  btn.disabled = true; btn.textContent = "Adding…";
  try {
    await api("/api/seeds/import", "POST", { name });
    await loadQuizzes();
    btn.textContent = "Added ✓";
    setTimeout(() => { btn.disabled = false; btn.textContent = "+ Add to my quizzes"; }, 1500);
  } catch (e) {
    btn.disabled = false; btn.textContent = "+ Add to my quizzes";
    alert(e.message);
  }
}

// ---- JSON export / import (backup that survives anything) ----
async function exportQuiz(id) {
  const quiz = await api("/api/quizzes/" + id);
  const clean = {
    title: quiz.title,
    questions: quiz.questions.map((q) => ({
      type: q.type, text: q.text, image_url: q.image_url, points: q.points,
      timer_seconds: q.timer_seconds, time_increment: q.time_increment,
      multi_select: q.multi_select, options: q.options, correct: q.correct,
    })),
  };
  const blob = new Blob([JSON.stringify(clean, null, 2)], { type: "application/json" });
  const a = el("a", { href: URL.createObjectURL(blob), download: slug(quiz.title) + ".json" });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const slug = (s) => String(s || "quiz").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "quiz";

$("#importBtn").onclick = () => $("#importFile").click();
$("#importFile").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const r = await api("/api/quizzes/import", "POST", data);
    await loadQuizzes();
    alert(`Imported “${r.title}”.`);
  } catch (err) {
    alert("Could not import that file: " + err.message);
  }
  e.target.value = "";
};

$("#createQuiz").onclick = async () => {
  const title = $("#newTitle").value.trim() || "Untitled quiz";
  const { id } = await api("/api/quizzes", "POST", { title });
  $("#newTitle").value = "";
  openEditor(id);
};

async function deleteQuiz(id, title) {
  if (!confirm(`Delete "${title}"? This can't be undone.`)) return;
  await api("/api/quizzes/" + id, "DELETE");
  loadQuizzes();
}

// ============================ EDITOR ============================

let E = { id: null, title: "", questions: [] };

const defaultQuestion = (type) => ({
  type, text: "", image_url: "", media_url: "", media_type: "", media_scale: 100, points: 10,
  timer_seconds: type === "buzzer" ? 0 : 30, time_increment: 10,
  multi_select: false, options: type === "select" ? ["", ""] : [], correct: [],
});

async function openEditor(id) {
  const quiz = await api("/api/quizzes/" + id);
  E = { id, title: quiz.title, questions: quiz.questions.map(normalizeQ) };
  $("#editTitle").value = quiz.title;
  $("#saveState").textContent = "";
  renderQuestions();
  showView("editor");
}

function normalizeQ(q) {
  return {
    type: q.type, text: q.text || "", image_url: q.image_url || "",
    media_url: q.media_url || "", media_type: q.media_type || "",
    media_scale: q.media_scale ?? 100,
    points: q.points ?? 10, timer_seconds: q.timer_seconds ?? 30,
    time_increment: q.time_increment ?? 10, multi_select: !!q.multi_select,
    options: q.options || [], correct: q.correct || [],
  };
}

$("#backToDash").onclick = () => { showView("dash"); loadQuizzes(); };
$("#addQuestion").onclick = () => {
  E.questions.push(defaultQuestion($("#addType").value));
  renderQuestions();
};

function renderQuestions() {
  const root = $("#questions");
  root.innerHTML = "";
  $("#noQuestions").classList.toggle("hide", E.questions.length > 0);
  E.questions.forEach((q, i) => root.append(questionCard(q, i)));
}

function questionCard(q, i) {
  const card = el("div", { class: "qcard" });
  const head = el("div", { class: "qhead" },
    el("div", { class: "qnum" }, String(i + 1)),
    el("span", { class: "pill " + q.type }, QTYPE_LABEL[q.type]),
    el("div", { class: "grow" }),
    el("button", { class: "btn sm", onclick: () => openPreview(i) }, "👁 Preview"),
    el("button", { class: "btn sm ghost", onclick: () => { if (i > 0) { swap(i, i - 1); } } }, "↑"),
    el("button", { class: "btn sm ghost", onclick: () => { if (i < E.questions.length - 1) swap(i, i + 1); } }, "↓"),
    el("button", { class: "btn sm ghost", onclick: () => { E.questions.splice(i, 1); renderQuestions(); } }, "🗑"));
  card.append(head);

  const bind = (key, parse) => (e) => { q[key] = parse ? parse(e.target.value) : e.target.value; };

  card.append(el("label", {}, "Question text"));
  card.append(el("textarea", { onchange: bind("text") }, q.text));

  card.append(mediaEditor(q, i));

  // type-specific
  if (q.type === "select") card.append(selectEditor(q));

  const grid = el("div", { class: "grid cols3", style: "margin-top:12px;" });
  grid.append(numField("Points", q.points, bind("points", Number)));
  if (q.type === "buzzer") {
    grid.append(numField("Buzz timer (sec, 0 = open)", q.timer_seconds, bind("timer_seconds", Number)));
  } else {
    grid.append(numField("Timer (seconds)", q.timer_seconds, bind("timer_seconds", Number)));
  }
  grid.append(numField("Add-time increment (sec)", q.time_increment, bind("time_increment", Number)));
  card.append(grid);
  return card;
}

function numField(label, val, onchange) {
  return el("div", {}, el("label", {}, label), el("input", { type: "number", value: val, onchange }));
}

// ---- media: upload image / audio / video, or paste a URL, plus size ----
const ACCEPT = "image/*,audio/*,video/*";

function mediaEditor(q, idx) {
  const wrap = el("div", { style: "margin-top:12px;" });
  wrap.append(el("label", {}, "Media (optional) — image, audio or video"));

  const body = el("div", {});
  function redraw() { body.innerHTML = ""; body.append(hasMedia(q) ? attached() : picker()); }

  function hasMedia(x) { return !!(x.media_url || x.image_url); }

  function attached() {
    const box = el("div", {});
    box.append(el("div", { class: "row spread", style: "margin-bottom:8px;" },
      el("span", { class: "pill" }, mediaLabel(q)),
      el("button", { class: "btn sm ghost", onclick: () => {
        q.media_url = ""; q.media_type = ""; q.image_url = ""; redraw();
      } }, "✕ Remove")));
    const prev = mediaEl(q, "220px");
    if (prev) box.append(prev);
    // size control (images and video only — audio has no visual size)
    if ((q.media_type || "image") !== "audio") {
      const val = el("span", { class: "scale-val" }, (q.media_scale || 100) + "%");
      const slider = el("input", { type: "range", min: "20", max: "100", step: "5",
        value: String(q.media_scale || 100) });
      slider.addEventListener("input", (e) => {
        q.media_scale = Number(e.target.value);
        val.textContent = q.media_scale + "%";
        const m = box.querySelector(".qmedia");
        if (m) m.style.width = q.media_scale + "%";
      });
      box.append(el("div", { class: "scale-row" },
        el("span", { class: "muted tiny" }, "Size"), slider, val));
    }
    return box;
  }

  function picker() {
    const drop = el("div", { class: "media-drop" });
    const file = el("input", { type: "file", accept: ACCEPT, class: "hide" });
    const status = el("div", { class: "muted tiny", style: "margin-top:8px;" },
      "Drag a file here, or");
    const btn = el("button", { class: "btn sm", onclick: () => file.click() }, "Choose file");
    file.addEventListener("change", () => file.files[0] && upload(file.files[0], status, redraw, q));
    drop.append(el("div", { style: "font-size:26px;" }, "🖼️ 🎵 🎬"), status, btn);
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault(); drop.classList.remove("over");
      const f = e.dataTransfer.files[0];
      if (f) upload(f, status, redraw, q);
    });
    drop.append(file);
    const urlRow = el("div", { class: "row", style: "margin-top:10px;" },
      el("input", { type: "text", placeholder: "…or paste a media URL", id: "murl" + idx }),
      el("button", { class: "btn sm", onclick: () => {
        const v = $("#murl" + idx).value.trim();
        if (!v) return;
        q.media_url = v;
        q.media_type = guessType(v);
        redraw();
      } }, "Use"));
    return el("div", {}, drop, urlRow);
  }

  redraw();
  wrap.append(body);
  return wrap;
}

function guessType(url) {
  const u = url.split("?")[0].toLowerCase();
  if (/\.(mp3|m4a|aac|ogg|wav|weba)$/.test(u)) return "audio";
  if (/\.(mp4|webm|mov|m4v)$/.test(u)) return "video";
  return "image";
}

async function upload(file, status, done, q) {
  status.textContent = `Uploading ${file.name}…`;
  try {
    const res = await fetch("/api/upload", {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream",
                 "Authorization": "Bearer " + Auth.token },
      body: file,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Upload failed");
    q.media_url = data.url;
    q.media_type = data.type;
    if (!q.media_scale) q.media_scale = 100;
    done();
  } catch (e) {
    status.textContent = "";
    status.append(el("span", { class: "err" }, e.message));
  }
}

function swap(a, b) { [E.questions[a], E.questions[b]] = [E.questions[b], E.questions[a]]; renderQuestions(); }

function selectEditor(q) {
  const box = el("div", { style: "margin-top:12px;" });
  box.append(el("label", { class: "row", style: "gap:8px; align-items:center;" },
    el("input", { type: "checkbox", style: "width:auto;", ...(q.multi_select ? { checked: "checked" } : {}),
      onchange: (e) => { q.multi_select = e.target.checked; if (!q.multi_select && q.correct.length > 1) q.correct = q.correct.slice(0, 1); renderQuestions(); } }),
    "Allow multiple correct answers (multi-select)"));

  const opts = el("div", { style: "margin-top:8px;" });
  function renderOpts() {
    opts.innerHTML = "";
    q.options.forEach((opt, oi) => {
      const isCorrect = q.correct.includes(oi);
      opts.append(el("div", { class: "opt-row" },
        el("input", { type: q.multi_select ? "checkbox" : "radio", name: "correct-" + q.options.length + Math.random(),
          style: "width:auto;", ...(isCorrect ? { checked: "checked" } : {}),
          title: "Mark correct",
          onchange: (e) => {
            if (q.multi_select) {
              if (e.target.checked) q.correct.push(oi); else q.correct = q.correct.filter(x => x !== oi);
            } else { q.correct = e.target.checked ? [oi] : []; }
            renderOpts();
          } }),
        el("input", { type: "text", value: opt, placeholder: "Option " + (oi + 1),
          onchange: (e) => { q.options[oi] = e.target.value; } }),
        el("button", { class: "btn sm ghost", onclick: () => { q.options.splice(oi, 1); q.correct = q.correct.filter(x => x !== oi).map(x => x > oi ? x - 1 : x); renderOpts(); } }, "✕")));
    });
    opts.append(el("button", { class: "btn sm", onclick: () => { q.options.push(""); renderOpts(); } }, "+ Add option"));
  }
  renderOpts();
  box.append(el("label", { style: "margin-top:10px;" }, "Options (check the correct one" + (q.multi_select ? "s" : "") + ")"));
  box.append(opts);
  return box;
}

// ============ PREVIEW: how this question lands on each surface ============

let PV = { idx: 0, surface: "player" };

function openPreview(i) {
  PV = { idx: i, surface: PV.surface || "player" };
  let m = $("#previewModal");
  if (m) m.remove();
  m = el("div", { class: "modal", id: "previewModal" },
    el("div", { class: "modal-card" },
      el("div", { class: "row spread", style: "margin-bottom:14px;" },
        el("h2", { style: "margin:0;" }, "Preview — question " + (i + 1)),
        el("button", { class: "btn sm ghost", onclick: closePreview }, "✕ Close")),
      el("div", { class: "seg", id: "pvSeg", style: "max-width:460px;" },
        el("button", { class: "seg-btn", "data-s": "player" }, "📱 Player"),
        el("button", { class: "seg-btn", "data-s": "presenter" }, "📺 Presenter"),
        el("button", { class: "seg-btn", "data-s": "host" }, "🎛 Host")),
      el("p", { class: "muted tiny center", id: "pvNote", style: "margin:0 0 14px;" }, ""),
      el("div", { id: "pvBody" }),
      el("div", { class: "row", style: "justify-content:center; margin-top:16px; gap:10px;" },
        el("button", { class: "btn sm", onclick: () => stepPreview(-1), disabled: i === 0 }, "← Prev question"),
        el("button", { class: "btn sm", onclick: () => stepPreview(1), disabled: i >= E.questions.length - 1 }, "Next question →"))));
  m.addEventListener("click", (e) => { if (e.target === m) closePreview(); });
  document.body.append(m);
  $$("#pvSeg .seg-btn").forEach((b) => { b.onclick = () => { PV.surface = b.dataset.s; renderPreview(); }; });
  document.addEventListener("keydown", pvKeys);
  renderPreview();
}

function closePreview() {
  const m = $("#previewModal");
  if (m) m.remove();
  document.removeEventListener("keydown", pvKeys);
}
function pvKeys(e) {
  if (e.key === "Escape") closePreview();
  else if (e.key === "ArrowRight") stepPreview(1);
  else if (e.key === "ArrowLeft") stepPreview(-1);
}
function stepPreview(d) {
  const n = PV.idx + d;
  if (n < 0 || n >= E.questions.length) return;
  openPreview(n);
}

function renderPreview() {
  const q = E.questions[PV.idx];
  if (!q) return;
  $$("#pvSeg .seg-btn").forEach((b) => b.classList.toggle("on", b.dataset.s === PV.surface));
  const body = $("#pvBody");
  body.innerHTML = "";
  const note = $("#pvNote");
  const badge = q.type === "buzzer" ? "BUZZER" : q.type === "freetext" ? "FREE TEXT"
    : (q.multi_select ? "SELECT MANY" : "SELECT ONE");

  if (PV.surface === "player") {
    note.textContent = "What each team sees on their phone.";
    const card = el("div", { class: "card" },
      el("div", { class: "row spread", style: "margin-bottom:8px;" },
        el("span", { class: "pill " + q.type }, badge),
        el("span", { class: "pill" }, (q.points || 0) + " PTS")));
    const m = mediaEl(q, "200px"); if (m) card.append(m);
    if (q.text) card.append(el("div", { style: "font:600 18px/1.35 'Outfit'; margin-bottom:12px;" }, q.text));
    if (q.type === "buzzer") {
      card.append(el("div", { class: "center" },
        el("div", { class: "buzzdisc", style: "width:150px;" },
          el("div", { class: "gloss" }), el("div", { class: "face" }, el("span", {}, "BUZZ")))));
    } else if (q.type === "freetext") {
      card.append(el("div", { class: "timerbar", style: "margin-bottom:10px;" }, el("div", { style: "width:70%;" })));
      card.append(el("textarea", { placeholder: "Type your answer…", style: "min-height:70px;" }));
    } else {
      const box = el("div", { class: "stack" });
      (q.options || []).forEach((o, i2) => box.append(el("div", { class: "opt-card" + (i2 === 0 ? " on" : "") },
        el("span", { class: "chip-letter" }, String.fromCharCode(65 + i2)),
        el("span", { class: "grow" }, o || "(empty option)"),
        el("span", { class: "tick" }, "✓"))));
      card.append(box);
    }
    if (q.type !== "buzzer") card.append(el("button", { class: "btn primary block lg", style: "margin-top:14px;" }, "🔒 Lock in"));
    body.append(el("div", { class: "phone-frame" }, card));

  } else if (PV.surface === "presenter") {
    note.textContent = "The shared screen — cast to a TV or shown in Present mode.";
    const stage = el("div", { class: "tv-frame" },
      el("div", { class: "row", style: "gap:10px; margin-bottom:10px;" },
        el("span", { class: "pill " + q.type }, badge),
        el("span", { class: "pill" }, (q.points || 0) + " PTS")));
    if (q.text) stage.append(el("div", { class: "qbig", style: "font-size:clamp(22px,3vw,44px);" }, q.text));
    const m = mediaEl(q, "300px"); if (m) stage.append(m);
    if (q.type === "select") {
      const grid = el("div", { class: "grid cols2" });
      (q.options || []).forEach((o, i2) => grid.append(el("div", { class: "opt-card", style: "font-size:18px;" },
        el("span", { class: "chip-letter" }, String.fromCharCode(65 + i2)),
        el("span", { class: "grow" }, o || "(empty option)"))));
      stage.append(grid);
    } else if (q.type === "buzzer") {
      stage.append(el("div", { class: "row center", style: "justify-content:center; margin-top:12px;" },
        el("span", { class: "armed-note", style: "font-size:17px;" }, el("span", { class: "armed-dot" }), "Buzzers are armed")));
    }
    body.append(stage);

  } else {
    note.textContent = "Your control screen, with the answer key visible.";
    const card = el("div", { class: "card" },
      el("div", { class: "row spread", style: "margin-bottom:8px;" },
        el("div", { class: "row", style: "gap:8px;" },
          el("span", { class: "pill " + q.type }, badge),
          el("span", { class: "pill" }, (q.points || 0) + " PTS")),
        el("span", { class: "muted tiny" }, q.timer_seconds ? q.timer_seconds + "s timer" : "no timer")));
    if (q.text) card.append(el("div", { class: "qbig", style: "font-size:24px;" }, q.text));
    const m = mediaEl(q, "180px"); if (m) card.append(m);
    if (q.type === "select") {
      const grid = el("div", { class: "grid cols2" });
      (q.options || []).forEach((o, i2) => {
        const right = (q.correct || []).includes(i2);
        grid.append(el("div", { class: "opt-card" + (right ? " on" : "") },
          el("span", { class: "chip-letter" }, String.fromCharCode(65 + i2)),
          el("span", { class: "grow" }, o || "(empty option)"),
          right ? el("span", { class: "pill green" }, "✓ correct") : null));
      });
      card.append(grid);
      card.append(el("p", { class: "muted tiny", style: "margin-top:8px;" }, "Auto-graded against this key."));
    } else if (q.type === "buzzer") {
      card.append(el("div", { class: "row", style: "gap:8px; margin-top:10px;" },
        el("button", { class: "btn good grow" }, "✓ Correct"),
        el("button", { class: "btn bad grow" }, "✗ Wrong — reopen")));
      card.append(el("p", { class: "muted tiny", style: "margin-top:8px;" },
        `First correct buzz scores ${q.points || 0}; after a wrong attempt, ${Math.floor((q.points || 0) / 2)}.`));
    } else {
      card.append(el("p", { class: "muted tiny", style: "margin-top:10px;" },
        "Answers stay hidden until the timer ends, then you mark each team ✓/✗."));
    }
    body.append(card);
  }
}

$("#saveQuiz").onclick = async () => {
  // pull latest title
  E.title = $("#editTitle").value.trim() || "Untitled quiz";
  // basic validation
  for (let i = 0; i < E.questions.length; i++) {
    const q = E.questions[i];
    if (q.type === "select") {
      q.options = q.options.filter(o => o.trim() !== "");
      if (q.options.length < 2) return flashSave("Q" + (i + 1) + ": needs at least 2 options.", true);
      if (!q.correct.length) return flashSave("Q" + (i + 1) + ": mark a correct answer.", true);
    }
  }
  await api("/api/quizzes/" + E.id, "PUT", { title: E.title, questions: E.questions });
  flashSave("Saved ✓", false);
};

function flashSave(msg, isErr) {
  const s = $("#saveState");
  s.textContent = msg;
  s.className = isErr ? "err" : "ok";
  if (!isErr) setTimeout(() => { s.textContent = ""; }, 2000);
}

// ============================ LIVE CONSOLE ============================

let H = null; // live state

async function hostLive(quizId) {
  const { code } = await api("/api/rooms", "POST", { quiz_id: quizId });
  startLive(code);
}

function startLive(code) {
  H = { code, phase: "lobby", q: null, index: -1, total: 0, teams: [], review: null, ws: null };
  $("#roomCode").textContent = code;
  $("#joinUrl").textContent = location.host + "/play.html";
  showView("live");

  const ws = new GameSocket();
  H.ws = ws;
  H.timer = new SyncTimer((rem) => renderTimer(rem));
  ws.onstatus = (up) => { $("#connState").textContent = up ? "" : "reconnecting…"; };
  ws
    .on("joined", (m) => { $("#liveTitle").textContent = m.title; })
    .on("state", (m) => {
      H.phase = m.phase; H.q = m.q; H.index = m.index; H.total = m.total;
      if (m.has_buzzer !== undefined) H.hasBuzzer = m.has_buzzer;
      renderLive();
    })
    .on("roster", (m) => { H.teams = m.teams; renderTeams(); if (H.phase === "lobby") renderPresent(); })
    .on("question", (m) => { H.phase = "active"; H.q = m.q; H.index = m.index; H.total = m.total; H.review = null; renderLive(); })
    .on("phase", (m) => { H.phase = m.phase; if (m.q) H.q = m.q; renderLive(); })
    .on("timer", (m) => H.timer.update(m))
    .on("buzz", (m) => { H.buzz = m; if (H.phase === "active") { renderSidePanel(); renderPresent(); } })
    .on("locks", (m) => { H.locks = m; if (H.phase === "active") { renderSidePanel(); renderPresent(); } })
    .on("presence_alert", (m) => { presenceAlert(m.name, m.state, m.id); flashTeamChip(m.id); })
    .on("review", (m) => { H.review = m; H.phase = "review"; renderLive(); })
    .on("scoreboard", (m) => { H.phase = "scoreboard"; H.scoreboard = m.rows; renderLive(); })
    .on("ended", (m) => { H.phase = "ended"; H.scoreboard = m.rows; renderLive(); })
    .on("error", (m) => alert(m.message));
  ws.connect({ type: "host_join", token: Auth.token, code });
}

$("#endRoom").onclick = () => {
  if (confirm("End this game for everyone?")) { H.ws.send({ type: "end" }); }
};
$("#presentBtn").onclick = () => { H.present = !H.present; renderPresentShell(); };

// ==================== PRESENT MODE (common view + control strip) ====================

function renderPresentShell() {
  let o = $("#presentOverlay");
  if (!H || !H.present) { if (o) o.remove(); return; }
  if (!o) {
    o = el("div", { class: "present", id: "presentOverlay" },
      el("div", { class: "present-stage", id: "presentStage" }),
      el("div", { class: "present-bar", id: "presentBar" }));
    document.body.append(o);
  }
  renderPresent();
}

function renderPresent() {
  if (!H || !H.present) return;
  const s = $("#presentStage"), bar = $("#presentBar");
  if (!s) return;
  s.innerHTML = ""; bar.innerHTML = "";
  H.pRing = null;
  const send = (t) => () => H.ws.send({ type: t });

  // ---- stage (mirrors the shared display) ----
  if (H.phase === "lobby") {
    s.append(el("div", { class: "center" },
      el("div", { class: "overline" }, "Join at " + location.host + "/play.html — enter code"),
      el("div", { class: "code-hero", style: "margin:10px 0 26px;" }, H.code)));
    const chips = el("div", { class: "chips", style: "justify-content:center;" });
    (H.teams || []).forEach((t, i) => { const c = el("div", { class: "chip pop" }, avatar(t, 30), t.name); c.style.animationDelay = (i * 0.08) + "s"; chips.append(c); });
    s.append(el("h3", { class: "center" }, (H.teams || []).length + " teams in"), chips);
  } else if (H.phase === "ended") {
    const rows = H.scoreboard || []; const win = rows[0];
    if (!document.querySelector(".confetti")) confettiBurst(document.body);
    s.append(el("div", { class: "center" },
      el("div", { class: "crown", style: "font-size:52px;" }, "♔"),
      el("div", { class: "overline" }, "Champions"),
      el("div", { style: "font:900 clamp(40px,9vw,120px) 'Unbounded'; margin:8px 0; background:var(--grad-gold); -webkit-background-clip:text; background-clip:text; color:transparent;" }, win ? win.name : "—")));
    s.append(el("div", { style: "max-width:640px; margin:16px auto 0;" }, scoreboardEl(rows)));
  } else if (H.phase === "scoreboard") {
    s.append(el("div", { class: "overline center", style: "margin-bottom:12px;" }, "Scoreboard · after question " + (H.index + 1)));
    s.append(el("div", { style: "max-width:720px; margin:0 auto; width:100%;" }, scoreboardEl(H.scoreboard || [])));
  } else if (H.q) {
    const badgeText = H.q.type === "buzzer" ? "BUZZER" : H.q.type === "freetext" ? "FREE TEXT" : (H.q.multi_select ? "SELECT MANY" : "SELECT ONE");
    const head = el("div", { class: "row spread", style: "margin-bottom:8px;" },
      el("div", { class: "row", style: "gap:10px;" },
        el("span", { class: "pill " + H.q.type }, badgeText),
        el("span", { class: "pill" }, H.q.points + " PTS"),
        el("span", { class: "muted tiny" }, "Q" + (H.index + 1) + " of " + H.total)));
    if (H.phase === "active" && H.q.timer_seconds > 0) { const r = makeRing(130, 42); H.pRing = r; head.append(r.node); }
    s.append(head);
    s.append(el("div", { class: "qbig", style: "font-size:clamp(28px,4.5vw,64px);" }, H.q.text || ""));
    { const m = mediaEl(H.q, "40vh"); if (m) s.append(m); }
    if (H.q.type === "select") {
      const grid = el("div", { class: "grid cols2" });
      H.q.options.forEach((o, i) => grid.append(el("div", { class: "opt-card", style: "font-size:20px;" },
        el("span", { class: "chip-letter" }, String.fromCharCode(65 + i)), el("span", { class: "grow" }, o))));
      s.append(grid);
    }
    if (H.phase === "review") {
      s.append(el("div", { class: "banner violet center", style: "margin-top:18px; font-size:20px;" }, "⏳ Time's up — judging on the host console…"));
    } else if (H.q.type !== "buzzer" && H.locks && H.locks.total) {
      s.append(el("div", { class: "center", style: "margin-top:18px;" },
        el("div", { class: H.locks.all_in ? "banner good" : "banner", style: "font-size:20px; display:inline-block;" },
          H.locks.all_in ? `✓ All ${H.locks.total} teams locked in` : `🔒 ${H.locks.count} of ${H.locks.total} locked in`)));
    }
    const away = (H.teams || []).filter((t) => !t.connected || t.away).length;
    if (away) s.append(el("div", { class: "center", style: "margin-top:12px;" },
      el("span", { class: "pill amber" }, `👀 ${away} team${away === 1 ? "" : "s"} away from the app`)));
    if (H.phase === "active" && H.q.type === "buzzer") {
      const b = H.buzz || { queue: [], top: null };
      if (b.top) s.append(el("div", { class: "center pop", style: "margin-top:14px; font:900 clamp(28px,5vw,64px) 'Unbounded'; color:var(--green); filter:drop-shadow(0 0 20px rgba(46,229,140,.5));" }, "🔔 " + b.top.name + " — answer!"));
      else s.append(el("div", { class: "row center", style: "justify-content:center; margin-top:16px;" },
        el("span", { class: "armed-note", style: "font-size:18px;" }, el("span", { class: "armed-dot" }), b.closed ? "Buzzing closed" : "Buzzers are armed")));
    }
    if (H.timer) renderTimer(H.timer.remaining());
  }

  // ---- control strip ----
  bar.append(el("button", { class: "btn", onclick: () => { H.present = false; renderPresentShell(); } }, "✕ Exit"));
  if (H.phase === "lobby") bar.append(el("button", { class: "btn primary", onclick: send("start") }, "▶ Start quiz"));
  if (H.phase === "active") {
    if (H.q && H.q.timer_seconds > 0) bar.append(el("button", { class: "btn warn", onclick: send("add_time") }, "+ Time"));
    if (H.q && H.q.type === "buzzer") {
      const has = !!(H.buzz && H.buzz.top);
      bar.append(el("button", { class: "btn good", onclick: send("buzz_correct"), disabled: !has }, "✓ Correct"),
                 el("button", { class: "btn bad", onclick: send("buzz_wrong"), disabled: !has }, "✗ Wrong"));
    } else {
      bar.append(el("button", { class: "btn good", onclick: send("evaluate_now") }, "End & evaluate"));
    }
    bar.append(el("button", { class: "btn", onclick: send("skip") }, "Skip"));
  }
  if (H.phase === "review") {
    if (H.q && H.q.type !== "freetext") bar.append(el("button", { class: "btn primary", onclick: send("finalize") }, "Finalize → scoreboard"));
    else bar.append(el("span", { class: "muted tiny", style: "align-self:center;" }, "Grade free-text answers on the console (Exit), then finalize."));
  }
  if (H.phase === "scoreboard") bar.append(el("button", { class: "btn primary", onclick: send(H.index + 1 >= H.total ? "end" : "next") }, H.index + 1 >= H.total ? "Finish 🏁" : "Next →"));
}

function renderTeams() {
  const gone = H.teams.filter((t) => !t.connected || t.away).length;
  const label = H.teams.length + " team" + (H.teams.length === 1 ? "" : "s");
  const el2 = $("#teamCount");
  el2.innerHTML = "";
  el2.append(document.createTextNode(label));
  // persists after the flash banner fades, so a quiet exodus stays visible
  if (gone) el2.append(el("span", { class: "pill amber", style: "margin-left:8px;" },
    gone + " away"));
  const root = $("#teamChips");
  root.innerHTML = "";
  if (!H.teams.length) { root.append(el("span", { class: "muted tiny" }, "Waiting for teams to join…")); return; }
  const showTested = H.phase === "lobby" && H.hasBuzzer;
  for (const t of H.teams) {
    const state = !t.connected ? "offline" : (t.away ? "away" : null);
    let tag;
    if (state) tag = el("span", { class: "pill " + (state === "away" ? "amber" : "red") }, state);
    else if (showTested) tag = t.tested ? el("span", { class: "pill green" }, "✓ buzzer")
                                        : el("span", { class: "pill" }, "untested");
    else if (H.phase === "active" && H.q && H.q.type !== "buzzer" && t.locked) tag = el("span", { class: "pill green" }, "🔒 locked");
    else tag = el("span", { class: "muted tiny" }, String(t.score));
    const chip = el("div", { class: "chip" + (t.connected && !t.away ? "" : " off"), "data-team": t.id },
      avatar(t), t.name, tag);
    root.append(chip);
  }
  if (showTested) {
    const n = H.teams.filter((t) => t.tested).length;
    root.append(el("div", { class: "muted tiny", style: "width:100%; margin-top:6px;" },
      `${n} of ${H.teams.length} tested their buzzer` + (n < H.teams.length ? " — ask the rest to tap TEST" : " ✓")));
  }
}

function flashTeamChip(id) {
  const c = document.querySelector(`.chip[data-team="${id}"]`);
  if (!c) return;
  c.classList.add("alerting");
  setTimeout(() => c.classList.remove("alerting"), 2800);
}

function renderTimer(rem) {
  if (rem === null || !H.q || !H.q.timer_seconds) return;
  const frac = rem / H.q.timer_seconds;
  if (H.ringApi) H.ringApi.set(frac, String(Math.ceil(rem)));
  if (H.pRing) H.pRing.set(frac, String(Math.ceil(rem)));
  if (H.barEl) {
    H.barEl.style.width = Math.max(0, frac * 100) + "%";
    H.barEl.style.background = frac > 0.4 ? "var(--green)" : (frac >= 0.2 ? "var(--amber)" : "var(--red)");
  }
}

function renderLive() {
  $("#livePhase").textContent = { lobby: "Lobby", active: "Question live", review: "Reviewing", scoreboard: "Scoreboard", ended: "Finished" }[H.phase] || H.phase;
  $("#liveProgress").textContent = (H.index >= 0 && H.q) ? `Q${H.index + 1} of ${H.total}` : (H.total ? H.total + " questions" : "");
  renderStage();
  renderControls();
  renderSidePanel();
  renderTeams();
  renderPresent();
}

function renderStage() {
  const s = $("#liveStage");
  s.innerHTML = "";
  H.ringApi = null; H.barEl = null;
  if (H.phase === "lobby") {
    s.append(el("div", { class: "center", style: "padding:30px 0;" },
      el("h1", {}, "Ready when you are"),
      el("p", { class: "muted" }, "Share the room code. Teams appear on the right as they join. Press Start to begin.")));
    return;
  }
  if (H.phase === "ended") {
    s.append(el("h1", { class: "center" }, "🏆 Final results"));
    s.append(scoreboardEl(H.scoreboard || []));
    return;
  }
  if (H.phase === "scoreboard") {
    s.append(el("h2", {}, "Standings"));
    s.append(scoreboardEl(H.scoreboard || []));
    return;
  }
  // active or review: show the question
  if (!H.q) return;
  const badgeText = H.q.type === "buzzer" ? "BUZZER" : H.q.type === "freetext" ? "FREE TEXT" : (H.q.multi_select ? "SELECT MANY" : "SELECT ONE");
  s.append(el("div", { class: "row spread", style: "margin-bottom:8px;" },
    el("div", { class: "row", style: "gap:8px;" },
      el("span", { class: "pill " + H.q.type }, badgeText),
      el("span", { class: "pill" }, H.q.points + " PTS")),
    (H.phase === "active" && H.q.timer_seconds > 0 && H.q.type !== "freetext") ? hostRing() : el("span", {})));
  s.append(el("div", { class: "qbig", style: "font-size:clamp(24px,3vw,40px);" }, H.q.text || "(no text)"));
  { const m = mediaEl(H.q, "26vh"); if (m) s.append(m); }

  if (H.q.type === "select") {
    const grid = el("div", { class: "grid cols2" });
    H.q.options.forEach((o, i) => {
      const correct = H.phase !== "active" && H.review && H.review.correct_options && H.review.correct_options.includes(o);
      grid.append(el("div", { class: "opt-card" + (correct ? " on" : "") }, el("span", { class: "chip-letter" }, String.fromCharCode(65 + i)), el("span", { class: "grow" }, o)));
    });
    s.append(grid);
  }

  if (H.phase === "active" && H.q.type === "freetext" && H.q.timer_seconds > 0) {
    const bar = el("div", { class: "timerbar", style: "margin-top:16px;" }, el("div", { style: "width:100%;" }));
    H.barEl = bar.firstChild;
    s.append(bar);
    H.timer && renderTimer(H.timer.remaining());
  } else if (H.phase === "active" && H.q.type === "buzzer") {
    s.append(el("p", { class: "muted", style: "margin-top:14px;" }, "Buzzers open — resolve in the “Buzz order” panel."));
    H.timer && renderTimer(H.timer.remaining());
  } else if (H.phase === "active") {
    H.timer && renderTimer(H.timer.remaining());
  }
}

function hostRing() { const r = makeRing(64, 20); H.ringApi = r; return r.node; }

function renderControls() {
  const c = $("#controls");
  c.innerHTML = "";
  const send = (t) => () => H.ws.send({ type: t });

  if (H.phase === "lobby") {
    c.append(el("button", { class: "btn primary lg", onclick: send("start") }, "▶ Start quiz"));
    return;
  }
  if (H.phase === "ended") {
    c.append(el("span", { class: "muted" }, "Game over. You can close this window."));
    return;
  }

  // navigation (always available per PRD)
  c.append(el("button", { class: "btn", onclick: send("prev"), disabled: H.index <= 0 }, "← Prev"));
  c.append(el("button", { class: "btn", onclick: send("skip") }, "Skip"));

  if (H.phase === "active") {
    if (H.q && H.q.timer_seconds > 0) c.append(el("button", { class: "btn warn", onclick: send("add_time") }, "+ Add time"));
    if (H.q && (H.q.type === "freetext" || H.q.type === "select"))
      c.append(el("button", { class: "btn good", onclick: send("evaluate_now") }, "End & evaluate now"));
    c.append(el("button", { class: "btn", onclick: send("next") }, "Next →"));
  }
  if (H.phase === "scoreboard") {
    c.append(el("button", { class: "btn primary", onclick: send(H.index + 1 >= H.total ? "end" : "next") },
      H.index + 1 >= H.total ? "Finish 🏁" : "Next question →"));
  }
}

function renderSidePanel() {
  const p = $("#sidePanel");
  if (H.phase === "active" && H.q && H.q.type === "buzzer") return renderBuzzPanel(p);
  if (H.phase === "review") return renderReviewPanel(p);
  if (H.phase === "active" && H.q && H.q.type === "freetext") {
    p.innerHTML = ""; p.append(el("h3", {}, "Free-text"), lockProgress(),
      el("p", { class: "muted tiny" }, "Answers are hidden until the timer ends or you click “End & evaluate now”. Then grade each team."));
    return;
  }
  if (H.phase === "active" && H.q && H.q.type === "select") {
    p.innerHTML = ""; p.append(el("h3", {}, "Select"), lockProgress(),
      el("p", { class: "muted tiny" }, "Auto-graded against your answer key when the timer ends. You can review and adjust before scores apply."));
    return;
  }
  p.innerHTML = ""; p.append(el("h3", {}, "Panel"), el("p", { class: "muted tiny" }, "Controls update with the round."));
}

function lockProgress() {
  const i = H.locks;
  if (!i || !i.total) return el("p", { class: "muted tiny" }, "Waiting for teams to lock in…");
  const box = el("div", { style: "margin-bottom:10px;" });
  box.append(el("div", { class: i.all_in ? "banner good" : "banner", style: "font-size:15px;" },
    i.all_in ? `✓ All ${i.total} teams locked in — safe to evaluate` : `🔒 ${i.count} of ${i.total} teams locked in`));
  const bar = el("div", { class: "timerbar", style: "margin-top:8px;" },
    el("div", { style: `width:${Math.round((i.count / i.total) * 100)}%; background:${i.all_in ? "var(--green)" : "var(--blue)"};` }));
  box.append(bar);
  return box;
}

function renderBuzzPanel(p) {
  p.innerHTML = "";
  p.append(el("div", { class: "row spread" }, el("h3", { style: "margin:0;" }, "Buzz order"),
    H.buzz && H.buzz.had_wrong ? el("span", { class: "pill" }, "Half points in play") : ""));
  const b = H.buzz || { queue: [], top: null, locked: [] };
  if (!b.queue.length) p.append(el("p", { class: "muted tiny" }, b.closed ? "Buzzing closed — no buzzes." : "Waiting for the first buzz…"));
  const lockedSet = new Set(b.locked || []);
  b.queue.forEach((item, i) => {
    const isTop = b.top && b.top.id === item.id;
    const isLocked = lockedSet.has(item.id);
    p.append(el("div", { class: "queue-item" + (isTop ? " top" : "") + (isLocked ? " locked" : "") },
      el("div", { class: "queue-pos" }, String(i + 1)), el("div", { class: "grow" }, item.name),
      isTop ? el("span", { class: "pill", style: "border-color:var(--good); color:var(--good);" }, "answering") : (isLocked ? el("span", { class: "muted tiny" }, "out") : "")));
  });
  const actions = el("div", { class: "stack", style: "margin-top:14px;" });
  const hasTop = !!(b.top);
  actions.append(el("div", { class: "row" },
    el("button", { class: "btn good grow", onclick: () => H.ws.send({ type: "buzz_correct" }), disabled: !hasTop }, "✓ Correct"),
    el("button", { class: "btn bad grow", onclick: () => H.ws.send({ type: "buzz_wrong" }), disabled: !hasTop }, "✗ Wrong")));
  actions.append(el("button", { class: "btn ghost block", onclick: () => H.ws.send({ type: "buzz_abandon" }) }, "Abandon (no points)"));
  p.append(actions);
}

function renderReviewPanel(p) {
  p.innerHTML = "";
  const r = H.review;
  if (!r) { p.append(el("p", { class: "muted" }, "Preparing review…")); return; }
  p.append(el("h3", {}, "Review & award — " + QTYPE_LABEL[r.qtype]));
  if (r.qtype === "select" && r.correct_options)
    p.append(el("div", { class: "banner good", style: "margin-bottom:10px;" }, "Correct: " + r.correct_options.join(", ")));
  if (r.qtype === "buzzer")
    p.append(el("p", { class: "muted tiny" }, r.buzz_winner ? "Winner gets " + (r.had_wrong ? "half" : "full") + " points. Adjust below if needed." : "No correct buzz — award is zero unless you adjust."));

  if (!r.awards.length) p.append(el("p", { class: "muted" }, "No teams have joined."));

  r.awards.forEach((a) => {
    const row = el("div", { class: "review-row" });
    row.append(avatar(a, 30));
    const mid = el("div", { class: "ans" }, el("b", {}, a.name));
    if (r.qtype === "freetext") {
      mid.append(el("div", { class: "muted tiny" }, a.answered ? "“" + a.answer + "”" : "(no answer)"));
    } else if (r.qtype === "select") {
      mid.append(el("div", { class: "muted tiny" }, (a.selectionText && a.selectionText.length ? a.selectionText.join(", ") : "(no answer)") + (a.correct ? " ✓" : "")));
    }
    row.append(mid);

    if (r.qtype === "freetext") {
      row.append(el("button", { class: "btn sm good", onclick: () => H.ws.send({ type: "set_award", teamId: a.teamId, award: r.points }) }, "✓"));
      row.append(el("button", { class: "btn sm bad", onclick: () => H.ws.send({ type: "set_award", teamId: a.teamId, award: 0 }) }, "✗"));
    }
    const inp = el("input", { type: "number", value: a.award, onchange: (e) => H.ws.send({ type: "set_award", teamId: a.teamId, award: Number(e.target.value) }) });
    row.append(inp);
    p.append(row);
  });

  p.append(el("button", { class: "btn primary block", style: "margin-top:8px;", onclick: () => H.ws.send({ type: "finalize" }) }, "Finalize round & show scoreboard"));
}

function scoreboardEl(rows) {
  const box = el("div", {});
  if (!rows.length) { box.append(el("p", { class: "muted" }, "No teams.")); return box; }
  rows.forEach((row) => {
    const leader = row.rank === 1;
    const name = el("div", { class: "sb-name" });
    if (leader) name.append(el("span", { class: "crown" }, "♔"));
    name.append(document.createTextNode(row.name));
    const delta = el("div", {});
    if (row.delta > 0) { delta.className = "sb-delta up"; delta.textContent = "+" + row.delta; }
    box.append(el("div", { class: "sb-row" + (leader ? " leader" : "") },
      el("div", { class: "sb-rank" }, String(row.rank)), avatar(row), name, delta,
      el("div", { class: "sb-score" }, String(row.score))));
  });
  return box;
}

// ============================ init ============================
showView("dash");
loadQuizzes();
loadSeeds();
