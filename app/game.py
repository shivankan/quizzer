"""In-memory live-room state machine: rooms, teams, buzzer, timers, scoring.

Logic here is synchronous; it pushes messages by calling ``conn.send_json(dict)``
on registered connection objects and schedules timer expiry on the asyncio loop.
"""
import asyncio
import secrets
import time

# Room codes avoid easily-confused characters (no 0/O/1/I).
_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

# phases: lobby | active | review | scoreboard | ended


def _gen_code():
    return "".join(secrets.choice(_CODE_ALPHABET) for _ in range(5))


class Team:
    def __init__(self, tid, name, photo):
        self.id = tid
        self.name = name
        self.photo = photo or ""
        self.score = 0
        self.conn = None  # current participant ws connection (or None if disconnected)
        self.away = False  # device backgrounded (app switch / screen off), reported by client
        self.buzz_tested = False  # passed the pre-quiz buzzer check

    @property
    def connected(self):
        return self.conn is not None


class Room:
    def __init__(self, code, host_id, quiz):
        self.code = code
        self.host_id = host_id
        self.quiz = quiz                 # {id, title, questions:[...]}
        self.created_at = time.time()

        self.host_conn = None
        self.displays = set()
        self.teams = {}                  # tid -> Team

        self.phase = "lobby"
        self.index = -1                  # current question index

        # timer
        self.deadline = None             # epoch seconds, or None
        self._timer_handle = None

        # per-question working state
        self.buzz_queue = []             # team ids, in buzz order
        self.locked = set()              # team ids out for this question (wrong)
        self.buzz_closed = False         # timer expired -> no new buzzes
        self.had_wrong = False
        self.text_answers = {}           # tid -> str
        self.select_answers = {}         # tid -> [indices]
        self.locked_in = set()           # team ids who locked their answer this question
        self.awards = {}                 # tid -> int (provisional, editable in review)
        self.revealed = False

    # ---------- helpers ----------
    @property
    def question(self):
        if 0 <= self.index < len(self.quiz["questions"]):
            return self.quiz["questions"][self.index]
        return None

    @property
    def has_buzzer(self):
        """True if any question is a buzzer round — gates the pre-quiz buzzer check."""
        return any(q["type"] == "buzzer" for q in self.quiz["questions"])

    def all_conns(self):
        conns = list(self.displays)
        if self.host_conn:
            conns.append(self.host_conn)
        for t in self.teams.values():
            if t.conn:
                conns.append(t.conn)
        return conns

    def broadcast(self, msg, include_host=True):
        targets = list(self.displays)
        for t in self.teams.values():
            if t.conn:
                targets.append(t.conn)
        if include_host and self.host_conn:
            targets.append(self.host_conn)
        for c in targets:
            c.send_json(msg)

    def to_host(self, msg):
        if self.host_conn:
            self.host_conn.send_json(msg)

    # ---------- public question payload ----------
    def public_question(self):
        q = self.question
        if not q:
            return None
        return {
            "type": q["type"],
            "text": q["text"],
            "image_url": q["image_url"],
            "media_url": q.get("media_url", ""),
            "media_type": q.get("media_type", ""),
            "media_scale": q.get("media_scale", 100),
            "media_first": bool(q.get("media_first")),
            "points": q["points"],
            "multi_select": q.get("multi_select", False),
            "options": q.get("options", []) if q["type"] == "select" else [],
            "timer_seconds": q["timer_seconds"],
            "time_increment": q["time_increment"],
        }

    def roster_msg(self):
        return {
            "type": "roster",
            "teams": [
                {"id": t.id, "name": t.name, "photo": t.photo,
                 "connected": t.connected, "away": t.away, "score": t.score,
                 "tested": t.buzz_tested, "locked": t.id in self.locked_in}
                for t in self.teams.values()
            ],
        }

    def scoreboard_rows(self, deltas=None):
        deltas = deltas or {}
        rows = sorted(self.teams.values(), key=lambda t: -t.score)
        out = []
        rank = 0
        last = None
        for i, t in enumerate(rows):
            if t.score != last:
                rank = i + 1
                last = t.score
            out.append({
                "rank": rank, "id": t.id, "name": t.name, "photo": t.photo,
                "score": t.score, "delta": deltas.get(t.id, 0),
                "connected": t.connected,
            })
        return out

    # ---------- timer ----------
    def _clear_timer(self):
        if self._timer_handle:
            self._timer_handle.cancel()
            self._timer_handle = None

    def _arm_timer(self, seconds):
        self._clear_timer()
        if seconds and seconds > 0:
            self.deadline = time.time() + seconds
            loop = asyncio.get_event_loop()
            self._timer_handle = loop.call_later(seconds + 0.01, self._on_timeout)
        else:
            self.deadline = None
        self._broadcast_timer()

    def _broadcast_timer(self):
        self.broadcast({
            "type": "timer",
            "deadline": self.deadline,
            "server_now": time.time(),
            "running": self.deadline is not None and self.phase == "active",
        })

    def _on_timeout(self):
        self._timer_handle = None
        if self.phase != "active":
            return
        q = self.question
        if not q:
            return
        if q["type"] == "buzzer":
            self.buzz_closed = True
            self.deadline = None
            self._broadcast_timer()
            self._broadcast_buzz()
        else:
            self._enter_review()

    # ---------- lifecycle / navigation ----------
    def _reset_question_state(self):
        self.buzz_queue = []
        self.locked = set()
        self.buzz_closed = False
        self.had_wrong = False
        self.text_answers = {}
        self.select_answers = {}
        self.awards = {}
        self.revealed = False

    def _enter_active(self, index):
        self._clear_timer()
        self.index = index
        if index >= len(self.quiz["questions"]):
            return self.end()
        self._reset_question_state()
        self.phase = "active"
        q = self.question
        self.broadcast({
            "type": "question",
            "q": self.public_question(),
            "index": self.index,
            "total": len(self.quiz["questions"]),
            "phase": self.phase,
        })
        # buzzer timer is optional; if 0, stays open until host resolves
        self._arm_timer(q["timer_seconds"])
        if q["type"] == "buzzer":
            self._broadcast_buzz()
        else:
            self._broadcast_locks()
        self.send_full_state(self.host_conn) if self.host_conn else None

    def start(self):
        if not self.quiz["questions"]:
            self.to_host({"type": "error", "message": "This quiz has no questions."})
            return
        self._enter_active(0)

    def next(self):
        self._enter_active(self.index + 1)

    def prev(self):
        self._enter_active(max(0, self.index - 1))

    def skip(self):
        self._enter_active(self.index + 1)

    def add_time(self):
        q = self.question
        if not q or self.phase != "active":
            return
        inc = q.get("time_increment") or 10
        base = max(self.deadline or 0, time.time())
        self.deadline = base + inc
        self.buzz_closed = False
        loop = asyncio.get_event_loop()
        self._clear_timer()
        self._timer_handle = loop.call_later(self.deadline - time.time() + 0.01, self._on_timeout)
        self._broadcast_timer()
        if q["type"] == "buzzer":
            self._broadcast_buzz()

    def evaluate_now(self):
        if self.phase != "active":
            return
        q = self.question
        if q and q["type"] == "buzzer":
            return  # buzzer resolved via host marking, not "evaluate"
        self._enter_review()

    def end(self):
        self._clear_timer()
        self.phase = "ended"
        self.broadcast({"type": "ended", "rows": self.scoreboard_rows()})

    # ---------- buzzer ----------
    def _current_top(self):
        for tid in self.buzz_queue:
            if tid not in self.locked:
                return tid
        return None

    def _broadcast_buzz(self):
        top = self._current_top()
        queue = [{"id": tid, "name": self.teams[tid].name}
                 for tid in self.buzz_queue if tid in self.teams]
        msg = {
            "type": "buzz",
            "queue": queue,
            "top": {"id": top, "name": self.teams[top].name} if top else None,
            "locked": list(self.locked),
            "closed": self.buzz_closed,
            "had_wrong": self.had_wrong,
        }
        self.broadcast(msg)

    def buzz(self, tid):
        q = self.question
        if self.phase != "active" or not q or q["type"] != "buzzer":
            return
        if self.buzz_closed:
            if self.teams.get(tid) and self.teams[tid].conn:
                self.teams[tid].conn.send_json({"type": "your_buzz", "position": None, "closed": True})
            return
        if tid in self.locked:
            return
        if tid not in self.buzz_queue:
            self.buzz_queue.append(tid)
        pos = [t for t in self.buzz_queue if t not in self.locked].index(tid) + 1
        t = self.teams.get(tid)
        if t and t.conn:
            t.conn.send_json({"type": "your_buzz", "position": pos, "closed": False})
        self._broadcast_buzz()

    def buzz_correct(self):
        q = self.question
        if self.phase != "active" or not q or q["type"] != "buzzer":
            return
        top = self._current_top()
        if not top:
            return
        pts = q["points"] // 2 if self.had_wrong else q["points"]
        self.awards = {top: pts}
        self._enter_review(buzz_winner=top)

    def buzz_wrong(self):
        q = self.question
        if self.phase != "active" or not q or q["type"] != "buzzer":
            return
        top = self._current_top()
        if not top:
            return
        self.locked.add(top)
        self.had_wrong = True
        self._broadcast_buzz()
        # everyone wrong / no one left and buzzing closed -> let host abandon

    def buzz_abandon(self):
        q = self.question
        if self.phase != "active" or not q or q["type"] != "buzzer":
            return
        self.awards = {}
        self._enter_review()

    # ---------- pre-quiz buzzer check ----------
    def buzz_test(self, tid):
        """Lobby-only warm-up so teams can confirm their buzzer registers."""
        if self.phase != "lobby":
            return
        t = self.teams.get(tid)
        if not t:
            return
        t.buzz_tested = True
        if t.conn:
            t.conn.send_json({"type": "buzz_test_ok"})
        self.broadcast(self.roster_msg())

    # ---------- lock-in ----------
    def connected_count(self):
        return sum(1 for t in self.teams.values() if t.connected)

    def set_lock(self, tid, locked):
        """Teams lock an answer in; they may unlock and re-lock while time remains."""
        q = self.question
        if self.phase != "active" or not q or q["type"] == "buzzer":
            return
        if tid not in self.teams:
            return
        if locked:
            self.locked_in.add(tid)
        else:
            self.locked_in.discard(tid)
        t = self.teams[tid]
        if t.conn:
            t.conn.send_json({"type": "lock_state", "locked": tid in self.locked_in})
        self._broadcast_locks()

    def refresh_locks(self):
        """Re-broadcast lock totals when the connected-team count changes
        (join / drop mid-question), so the host's "n of N" stays accurate."""
        q = self.question
        if self.phase == "active" and q and q["type"] != "buzzer":
            self._broadcast_locks()

    def _broadcast_locks(self):
        total = self.connected_count()
        n = len([t for t in self.locked_in if self.teams.get(t) and self.teams[t].connected])
        self.broadcast({
            "type": "locks",
            "locked": list(self.locked_in),
            "count": n,
            "total": total,
            "all_in": total > 0 and n >= total,
        })
        self.broadcast(self.roster_msg())

    # ---------- presence alerts ----------
    def presence_alert(self, team, state):
        """Fun, visible callout when a team backgrounds the app or drops mid-question."""
        if self.phase not in ("active", "review"):
            return
        self.broadcast({"type": "presence_alert", "name": team.name,
                        "id": team.id, "state": state})

    # ---------- answer submission ----------
    def submit_text(self, tid, text):
        if self.phase == "active" and self.question and self.question["type"] == "freetext":
            if tid in self.locked_in:
                return  # must unlock to edit
            self.text_answers[tid] = text
            t = self.teams.get(tid)
            if t and t.conn:
                t.conn.send_json({"type": "ack_text", "text": text})

    def submit_select(self, tid, selection):
        q = self.question
        if tid in self.locked_in:
            return  # must unlock to edit
        if self.phase == "active" and q and q["type"] == "select":
            opts = q.get("options", [])
            sel = [i for i in selection if isinstance(i, int) and 0 <= i < len(opts)]
            if not q.get("multi_select") and len(sel) > 1:
                sel = sel[:1]
            self.select_answers[tid] = sel
            t = self.teams.get(tid)
            if t and t.conn:
                t.conn.send_json({"type": "ack_select", "selection": sel})

    # ---------- review / grading ----------
    def _enter_review(self, buzz_winner=None):
        self._clear_timer()
        self.deadline = None
        self.phase = "review"
        q = self.question
        self._broadcast_timer()

        if q["type"] == "select":
            correct = set(q.get("correct", []))
            self.awards = {}
            for t in self.teams.values():
                sel = set(self.select_answers.get(t.id, []))
                self.awards[t.id] = q["points"] if sel == correct and sel else 0
        elif q["type"] == "freetext":
            # default everyone to 0; host grades to award full
            self.awards = {t.id: self.awards.get(t.id, 0) for t in self.teams.values()}
        # buzzer: awards already set by buzz_correct / abandon

        self.broadcast({"type": "phase", "phase": "review",
                        "index": self.index, "q": self.public_question()})
        self._send_review_to_host(buzz_winner)
        # participants: simple "answers locked, host reviewing" handled client-side via phase

    def _send_review_to_host(self, buzz_winner=None):
        q = self.question
        payload = {
            "type": "review",
            "qtype": q["type"],
            "points": q["points"],
            "buzz_winner": buzz_winner,
            "had_wrong": self.had_wrong,
            "awards": [],
        }
        for t in self.teams.values():
            entry = {
                "teamId": t.id, "name": t.name, "photo": t.photo,
                "prevScore": t.score, "award": self.awards.get(t.id, 0),
            }
            if q["type"] == "freetext":
                entry["answer"] = self.text_answers.get(t.id, "")
                entry["answered"] = t.id in self.text_answers
            elif q["type"] == "select":
                sel = self.select_answers.get(t.id, [])
                entry["selection"] = sel
                entry["selectionText"] = [q["options"][i] for i in sel if i < len(q["options"])]
                entry["correct"] = set(sel) == set(q.get("correct", [])) and bool(sel)
            payload["awards"].append(entry)
        if q["type"] == "select":
            payload["correct_options"] = [q["options"][i] for i in q.get("correct", []) if i < len(q["options"])]
        self.to_host(payload)

    def grade_freetext(self, marks):
        # marks: {teamId: bool} -> correct teams get full points
        q = self.question
        if self.phase != "review" or not q or q["type"] != "freetext":
            return
        for tid, ok in marks.items():
            if tid in self.teams:
                self.awards[tid] = q["points"] if ok else 0
        self._send_review_to_host()

    def set_award(self, tid, award):
        if self.phase != "review" or tid not in self.teams:
            return
        try:
            self.awards[tid] = int(award)
        except (TypeError, ValueError):
            return
        self._send_review_to_host()

    def finalize(self):
        if self.phase != "review":
            return
        q = self.question
        deltas = {}
        for tid, t in self.teams.items():
            a = int(self.awards.get(tid, 0))
            t.score += a
            deltas[tid] = a
        self.phase = "scoreboard"
        self.revealed = True
        # reveal answers to everyone
        reveal = {"type": "reveal", "qtype": q["type"], "index": self.index}
        if q["type"] == "freetext":
            reveal["answers"] = [
                {"name": t.name, "text": self.text_answers.get(t.id, ""),
                 "correct": self.awards.get(t.id, 0) > 0}
                for t in self.teams.values() if t.id in self.text_answers
            ]
        elif q["type"] == "select":
            reveal["correct_options"] = [q["options"][i] for i in q.get("correct", []) if i < len(q["options"])]
        self.broadcast(reveal)
        self.broadcast({
            "type": "scoreboard",
            "rows": self.scoreboard_rows(deltas),
            "final": False,
        })

    # ---------- state sync ----------
    def send_full_state(self, conn, role=None):
        """Send a connecting/reconnecting client everything it needs."""
        if conn is None:
            return
        conn.send_json({
            "type": "state",
            "phase": self.phase,
            "index": self.index,
            "total": len(self.quiz["questions"]),
            "title": self.quiz["title"],
            "has_buzzer": self.has_buzzer,
            "q": self.public_question() if self.phase in ("active", "review", "scoreboard") else None,
        })
        conn.send_json(self.roster_msg())
        if self.phase in ("active", "review", "scoreboard"):
            conn.send_json({
                "type": "timer", "deadline": self.deadline,
                "server_now": time.time(),
                "running": self.deadline is not None and self.phase == "active",
            })
        q = self.question
        if self.phase == "active" and q and q["type"] == "buzzer":
            top = self._current_top()
            conn.send_json({
                "type": "buzz",
                "queue": [{"id": tid, "name": self.teams[tid].name}
                          for tid in self.buzz_queue if tid in self.teams],
                "top": {"id": top, "name": self.teams[top].name} if top else None,
                "locked": list(self.locked), "closed": self.buzz_closed,
                "had_wrong": self.had_wrong,
            })
        q2 = self.question
        if self.phase == "active" and q2 and q2["type"] != "buzzer":
            total = self.connected_count()
            n = len([t for t in self.locked_in if self.teams.get(t) and self.teams[t].connected])
            conn.send_json({"type": "locks", "locked": list(self.locked_in),
                            "count": n, "total": total,
                            "all_in": total > 0 and n >= total})
        if self.phase == "scoreboard":
            conn.send_json({"type": "scoreboard", "rows": self.scoreboard_rows(), "final": False})
        if self.phase == "ended":
            conn.send_json({"type": "ended", "rows": self.scoreboard_rows()})


class RoomManager:
    def __init__(self):
        self.rooms = {}  # code -> Room

    def create(self, host_id, quiz):
        for _ in range(20):
            code = _gen_code()
            if code not in self.rooms:
                break
        room = Room(code, host_id, quiz)
        self.rooms[code] = room
        return room

    def get(self, code):
        return self.rooms.get((code or "").upper().strip())

    def add_team(self, room, name, photo, tid=None):
        if tid and tid in room.teams:
            return room.teams[tid]
        tid = tid or secrets.token_urlsafe(12)
        # if rejoin id provided but unknown (room restarted), create fresh under new id
        if tid in room.teams:
            return room.teams[tid]
        team = Team(tid, name, photo)
        room.teams[tid] = team
        return team


MANAGER = RoomManager()
