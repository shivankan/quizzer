# Quizzer — live multi-format quiz platform

A single-tool live trivia host: buzzer rounds, free-text, and multiple-choice —
displayed, collected, arbitrated, and scored in real time from one screen.
Participants join from a phone with no install.

This is **Phase 1 (Core MVP)** from the PRD, built with **zero dependencies** —
pure Python 3 standard library on the backend, vanilla HTML/CSS/JS on the front.
No `npm`, no build step, no database server.

## Run it

```bash
cd Quizzer
python3 server.py
```

Then open **http://localhost:8000**.

- **Host console** — `/` (sign up, author quizzes, run a live room)
- **Join a game** — `/play.html` (players, by room code)
- **Shared display** — `/display.html` (cast to a TV/projector)

To let phones on the same Wi-Fi join, share `http://<your-computer-ip>:8000`.
Set a different port with `QUIZZER_PORT=9000 python3 server.py`.

## What works (PRD Phase 1)

**Host accounts & authoring**
- Email/password signup & login (PBKDF2-hashed, unique emails)
- Create / edit / delete multiple saved quizzes
- Three question types — **Buzzer**, **Free-text** (timed), **Select** (single/multi, timed)
- Per-question text, image (URL), point value, timer length, add-time increment
- Unlimited select options, one or more marked correct

**Live room**
- Start a room from any quiz → human-enterable 5-char join code
- Guests join by code (no account), set team name + optional photo
- Live roster updates; late joiners welcome; reconnect keeps your team & score

**Run-time loop**
- Server-authoritative timer synced to all devices (drift < 1s)
- **Buzzer:** live buzz order, mark top team right/wrong, wrong reopens to the
  rest; first correct = full points, correct-after-a-wrong = **half points**
  (automatic); abandon = no points
- **Free-text:** answers hidden until the timer ends (or host ends early), then
  host grades each team correct/incorrect; revealed to everyone on finalize
- **Select:** auto-graded against the answer key at timer end; host can extend or
  adjust before scores apply
- Host can go **prev / skip / next** anytime and **add time** (even after expiry)
- Per-round award summary, **editable per team**, before finalizing
- Live scoreboard on the shared display and on demand for players

## Password reset (email)

Hosts who forget a password use **Forgot password?** on the sign-in card. The server
issues a single-use token that expires in 30 minutes, emails a link, and the link
opens `/reset.html` to choose a new password. Resetting signs the host out everywhere.

Email goes out over plain SMTP (stdlib `smtplib`). Configure it with environment
variables — on Render, add these under *Environment*:

| Variable | Example | Notes |
|---|---|---|
| `QUIZZER_SMTP_HOST` | `smtp.gmail.com` | |
| `QUIZZER_SMTP_PORT` | `587` | `465` switches to implicit TLS |
| `QUIZZER_SMTP_USER` | `you@gmail.com` | |
| `QUIZZER_SMTP_PASS` | *app password* | Gmail needs an **App Password**, not your login |
| `QUIZZER_MAIL_FROM` | `Quizzer <you@gmail.com>` | optional, defaults to `SMTP_USER` |
| `QUIZZER_BASE_URL` | `https://your-app.onrender.com` | so links point at the public site, not localhost |

**If SMTP isn't configured the flow still works** — the reset link is written to the
server log instead of being emailed (visible in Render's *Logs* tab), and the UI says
so plainly rather than pretending a mail was sent.

Security properties, all covered by `tests/test_ws.py`: tokens are stored only as
SHA-256 hashes, are single-use, expire after 30 minutes, revoke existing sessions on
use, are rate-limited to one per address per minute, and `/api/forgot` returns an
identical response whether or not the address has an account (no email enumeration).

## Architecture

| Piece | File |
|---|---|
| Server entry (asyncio, HTTP + WebSocket on one port) | `server.py` |
| Auth + quiz persistence (SQLite) | `app/db.py` |
| Live room state machine, buzzer, timers, scoring | `app/game.py` |
| WebSocket framing + HTTP parsing (RFC 6455) | `app/protocol.py` |
| Host console (dashboard, authoring, live control) | `web/host.html`, `web/js/host.js` |
| Participant app | `web/play.html`, `web/js/play.js` |
| Shared display | `web/display.html`, `web/js/display.js` |
| Shared client helpers (API, WS, timer sync) | `web/js/common.js` |

Host accounts and quizzes persist in `quizzer.db` (SQLite, created on first run).
Live room state is in memory — rooms exist while the server runs.

## Tests

End-to-end gameplay test drives a host + two teams through a full 3-question game
over real WebSockets and asserts every scoring rule:

```bash
python3 server.py &          # in one shell
python3 tests/test_ws.py     # in another
```

Covers: buzzer half-point rule, free-text grading (answers hidden until eval),
select auto-grading, manual award override, scoreboard totals, and reconnect.

## Notable design decisions

- **WebSockets from day one.** The PRD calls out that buzzer fairness and timer
  sync need real-time transport with server-authoritative timing — retrofitting
  it onto polling later would mean rebuilding the run-time layer. So it's here
  from the start. Buzz order is resolved by server receive time.
- **Zero dependencies.** Runs on a stock macOS/Linux Python 3. Nothing to install.
- **Join by code** (PRD's chosen v1 substitute for "same-network discovery").

## Not in Phase 1 (per PRD)

Audio/video question media, co-host handoff, spectator mode, local-network room
discovery, analytics, templates, payments, AI question generation. Team photos,
reconnect, and editable per-question increments are included here as early wins.
