#!/usr/bin/env python3
"""End-to-end WebSocket gameplay test using a minimal stdlib WS client.

Simulates a host + two teams playing a 3-question quiz (buzzer, freetext, select)
and asserts the scoring rules from the PRD.
"""
import socket
import struct
import base64
import hashlib
import os
import json
import time
import urllib.request

HOST, PORT = "127.0.0.1", int(os.environ.get("QUIZZER_PORT", "8000"))
BASE = f"http://{HOST}:{PORT}"


def http_json(path, method="GET", body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


class WS:
    def __init__(self, name="ws"):
        self.name = name
        self.sock = socket.create_connection((HOST, PORT))
        key = base64.b64encode(os.urandom(16)).decode()
        handshake = (
            f"GET /ws HTTP/1.1\r\nHost: {HOST}:{PORT}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(handshake.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.sock.recv(1024)
        self.buf = buf.split(b"\r\n\r\n", 1)[1]
        self.sock.settimeout(0.4)

    def send(self, obj):
        data = json.dumps(obj).encode()
        mask = os.urandom(4)
        masked = bytes(data[i] ^ mask[i % 4] for i in range(len(data)))
        header = bytearray([0x81])
        n = len(data)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126); header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127); header += struct.pack(">Q", n)
        header += mask
        self.sock.sendall(bytes(header) + masked)

    def _read_n(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise EOFError
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self):
        b = self._read_n(2)
        length = b[1] & 0x7F
        if length == 126:
            length = struct.unpack(">H", self._read_n(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", self._read_n(8))[0]
        payload = self._read_n(length) if length else b""
        return json.loads(payload.decode())

    def drain(self, timeout=0.35):
        msgs = []
        end = time.time() + timeout
        while time.time() < end:
            try:
                msgs.append(self.recv())
            except (socket.timeout, EOFError, OSError):
                break
        return msgs

    def wait_for(self, mtype, timeout=2.0):
        end = time.time() + timeout
        while time.time() < end:
            try:
                m = self.recv()
            except (socket.timeout, OSError):
                continue
            if m.get("type") == mtype:
                return m
        raise AssertionError(f"[{self.name}] timed out waiting for {mtype}")


def latest(msgs, mtype):
    found = [m for m in msgs if m.get("type") == mtype]
    return found[-1] if found else None


FAILS = []
def check(cond, label):
    print(("  ✓ " if cond else "  ✗ ") + label)
    if not cond:
        FAILS.append(label)


def main():
    # --- setup via REST ---
    email = f"e2e_{int(time.time())}@t.com"
    tok = http_json("/api/signup", "POST", {"email": email, "password": "secret123"})["token"]
    qid = http_json("/api/quizzes", "POST", {"title": "E2E"}, token=tok)["id"]
    http_json("/api/quizzes/%d" % qid, "PUT", {"title": "E2E", "questions": [
        {"type": "buzzer", "text": "Buzzer Q", "points": 10, "timer_seconds": 0, "time_increment": 10},
        {"type": "freetext", "text": "Freetext Q", "points": 10, "timer_seconds": 30, "time_increment": 10},
        {"type": "select", "text": "Select Q", "points": 10, "timer_seconds": 30, "time_increment": 5,
         "multi_select": True, "options": ["A", "B", "C"], "correct": [0, 2]},
    ]}, token=tok)
    code = http_json("/api/rooms", "POST", {"quiz_id": qid}, token=tok)["code"]
    print(f"\nRoom {code} created.\n")

    host = WS("host")
    host.send({"type": "host_join", "token": tok, "code": code})
    host.wait_for("joined")

    A = WS("teamA"); A.send({"type": "team_join", "code": code, "name": "Alpha"})
    aid = A.wait_for("joined")["teamId"]
    B = WS("teamB"); B.send({"type": "team_join", "code": code, "name": "Bravo"})
    bid = B.wait_for("joined")["teamId"]
    host.drain()

    # ===== Q1 BUZZER: A buzzes first & wrong, B buzzes & correct -> B half (5) =====
    print("Q1 buzzer (A wrong, B correct after wrong attempt -> half points):")
    host.send({"type": "start"})
    A.wait_for("question"); B.wait_for("question"); host.drain()

    A.send({"type": "buzz"}); time.sleep(0.05)
    B.send({"type": "buzz"}); time.sleep(0.1)
    bz = host.drain()
    buzz = latest(bz, "buzz")
    check(buzz and buzz["top"]["id"] == aid, "A is top of buzz queue (buzzed first)")
    check(buzz and len(buzz["queue"]) == 2, "both teams in queue")

    host.send({"type": "buzz_wrong"}); time.sleep(0.1)   # A wrong
    bz = host.drain()
    buzz = latest(bz, "buzz")
    check(buzz and buzz["top"]["id"] == bid, "after A wrong, B is now top")
    check(buzz and buzz["had_wrong"] is True, "had_wrong flag set")

    host.send({"type": "buzz_correct"}); time.sleep(0.1)  # B correct -> half
    rev = host.wait_for("review")
    awards = {a["teamId"]: a["award"] for a in rev["awards"]}
    check(awards.get(bid) == 5, "B awarded HALF points (5) for correct-after-wrong")
    check(awards.get(aid) == 0, "A awarded 0")
    host.send({"type": "finalize"})
    sb = host.wait_for("scoreboard")
    scores = {r["id"]: r["score"] for r in sb["rows"]}
    check(scores.get(bid) == 5 and scores.get(aid) == 0, "scoreboard after Q1: B=5, A=0")

    # ===== Q2 FREETEXT: both answer, host marks A correct only =====
    print("\nQ2 freetext (host grades A correct, B incorrect):")
    host.send({"type": "next"})
    A.wait_for("question"); B.wait_for("question"); host.drain()
    A.send({"type": "submit_text", "text": "Neon"}); A.wait_for("ack_text")
    B.send({"type": "submit_text", "text": "wrong"}); B.wait_for("ack_text")
    # host should not see answers yet (still active) — end early
    host.send({"type": "evaluate_now"})
    rev = host.wait_for("review")
    ans = {a["teamId"]: a.get("answer") for a in rev["awards"]}
    check(ans.get(aid) == "Neon", "host sees A's freetext answer in review")
    host.send({"type": "grade", "marks": {aid: True, bid: False}})
    rev2 = host.wait_for("review")
    aw = {a["teamId"]: a["award"] for a in rev2["awards"]}
    check(aw.get(aid) == 10 and aw.get(bid) == 0, "grading: A=10, B=0")
    host.send({"type": "finalize"})
    sb = host.wait_for("scoreboard")
    scores = {r["id"]: r["score"] for r in sb["rows"]}
    check(scores.get(aid) == 10 and scores.get(bid) == 5, "after Q2: A=10, B=5")
    rv = A.drain(); check(latest(rv, "reveal") is not None, "participants get reveal after finalize")

    # ===== Q3 SELECT: A picks correct set, B partial -> auto-grade =====
    print("\nQ3 select (auto-grade: A correct set, B partial -> 0):")
    host.send({"type": "next"})
    A.wait_for("question"); B.wait_for("question"); host.drain()
    A.send({"type": "submit_select", "selection": [0, 2]}); A.wait_for("ack_select")
    B.send({"type": "submit_select", "selection": [0]}); B.wait_for("ack_select")
    host.send({"type": "evaluate_now"})
    rev = host.wait_for("review")
    aw = {a["teamId"]: a["award"] for a in rev["awards"]}
    check(aw.get(aid) == 10, "select auto-grade: A correct set -> 10")
    check(aw.get(bid) == 0, "select auto-grade: B partial -> 0")
    # host manual override demo: bump B to 3
    host.send({"type": "set_award", "teamId": bid, "award": 3})
    rev2 = host.wait_for("review")
    aw = {a["teamId"]: a["award"] for a in rev2["awards"]}
    check(aw.get(bid) == 3, "host manual award override works")
    host.send({"type": "finalize"})
    sb = host.wait_for("scoreboard")
    scores = {r["id"]: r["score"] for r in sb["rows"]}
    check(scores.get(aid) == 20 and scores.get(bid) == 8, "final totals: A=20, B=8")

    # ===== reconnect: team A rejoins with same id, keeps score =====
    print("\nReconnect (A rejoins same teamId, keeps score):")
    A.sock.close()
    time.sleep(0.2)
    A2 = WS("teamA2"); A2.send({"type": "team_join", "code": code, "name": "Alpha", "teamId": aid})
    A2.wait_for("joined")
    msgs = A2.drain()
    sbrow = latest(msgs, "scoreboard")
    arow = next((r for r in sbrow["rows"] if r["id"] == aid), None) if sbrow else None
    check(arow and arow["score"] == 20, "reconnected A still has score 20")

    # ===== buzzer check / lock-in / presence alerts =====
    print("\nPre-quiz buzzer check, lock-in, presence alerts:")
    code2 = http_json("/api/rooms", "POST", {"quiz_id": qid}, token=tok)["code"]
    h2 = WS("host2"); h2.send({"type": "host_join", "token": tok, "code": code2})
    h2.wait_for("joined")
    check(h2.wait_for("state").get("has_buzzer") is True, "host told the quiz has a buzzer round")
    C = WS("C"); C.send({"type": "team_join", "code": code2, "name": "Cee"})
    cid = C.wait_for("joined")["teamId"]
    D = WS("D"); D.send({"type": "team_join", "code": code2, "name": "Dee"})
    D.wait_for("joined")
    h2.drain()

    C.send({"type": "buzz_test"})
    check(C.wait_for("buzz_test_ok") is not None, "buzzer check acks the team")
    ros = latest(h2.drain(), "roster")
    check(ros and [t for t in ros["teams"] if t["id"] == cid][0]["tested"] is True,
          "host roster marks that team as tested")

    # skip to the timed select question (index 2 of the e2e quiz)
    h2.send({"type": "start"}); C.wait_for("question"); D.wait_for("question"); h2.drain()
    h2.send({"type": "next"}); C.wait_for("question"); D.wait_for("question"); h2.drain()
    h2.send({"type": "next"}); C.wait_for("question"); D.wait_for("question"); h2.drain()

    C.send({"type": "submit_select", "selection": [0]}); C.wait_for("ack_select")
    C.send({"type": "lock_in", "locked": True})
    check(C.wait_for("lock_state")["locked"] is True, "team can lock in an answer")
    lk = latest(h2.drain(), "locks")
    check(lk and lk["count"] == 1 and lk["total"] == 2, "host sees 1 of 2 locked in")
    C.send({"type": "submit_select", "selection": [1]}); time.sleep(0.2)
    check(not latest(C.drain(), "ack_select"), "edits are rejected while locked")
    C.send({"type": "lock_in", "locked": False}); C.wait_for("lock_state")
    C.send({"type": "submit_select", "selection": [0, 2]})
    check(C.wait_for("ack_select") is not None, "unlocking re-enables editing")
    C.send({"type": "lock_in", "locked": True}); C.wait_for("lock_state")
    D.send({"type": "lock_in", "locked": True}); D.wait_for("lock_state")
    lk = latest(h2.drain(), "locks")
    check(lk and lk["all_in"] is True, "all_in set once every connected team locks")

    D.send({"type": "presence", "away": True}); time.sleep(0.2)
    al = latest(h2.drain(), "presence_alert")
    check(al and al["name"] == "Dee" and al["state"] == "away", "host alerted when a team leaves the app")
    D.sock.close(); time.sleep(0.3)
    msgs = h2.drain()
    check(latest(msgs, "presence_alert")["state"] == "offline", "host alerted when a team drops")
    lk = latest(msgs, "locks")
    check(lk and lk["total"] == 1, "lock total follows the connected-team count")

    print("\n" + ("ALL CHECKS PASSED ✅" if not FAILS else f"FAILED: {FAILS}"))
    return 1 if FAILS else 0


if __name__ == "__main__":
    raise SystemExit(main())
