#!/usr/bin/env python3
"""Quizzer — live multi-format quiz platform.

Zero dependencies: pure Python 3 standard library. Serves the web UI, a small
JSON REST API (auth + quiz authoring + room creation), and a WebSocket endpoint
for real-time gameplay, all on one asyncio server / one port.

Run:  python3 server.py   (then open http://localhost:8000)
"""
import asyncio
import json
import mimetypes
import os
import sys

from app import db
from app.game import MANAGER
from app import protocol as P

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")
HOST = os.environ.get("QUIZZER_HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT") or os.environ.get("QUIZZER_PORT") or "8000")


# ============================ WebSocket connection ============================

class WSConnection:
    """One websocket client. send_json() is safe to call from sync game code;
    messages are queued and written in order by a background drain task."""

    def __init__(self, writer):
        self.writer = writer
        self.queue = asyncio.Queue()
        self.alive = True
        self.role = None        # 'host' | 'team' | 'display'
        self.room = None
        self.team_id = None
        self._drain_task = asyncio.ensure_future(self._drain())

    def send_json(self, obj):
        if self.alive:
            self.queue.put_nowait(obj)

    async def _drain(self):
        try:
            while self.alive:
                obj = await self.queue.get()
                if obj is None:
                    break
                self.writer.write(P.encode_frame(json.dumps(obj)))
                await self.writer.drain()
        except (ConnectionResetError, BrokenPipeError, asyncio.CancelledError):
            self.alive = False
        except Exception:
            self.alive = False

    def close(self):
        self.alive = False
        self.queue.put_nowait(None)


async def handle_ws(reader, writer, req):
    key = req.header("sec-websocket-key")
    if not key:
        writer.write(b"HTTP/1.1 400 Bad Request\r\n\r\n")
        await writer.drain()
        return
    writer.write(P.ws_handshake_response(key))
    await writer.drain()

    conn = WSConnection(writer)
    try:
        while conn.alive:
            opcode, payload = await P.read_frame(reader)
            if opcode is None or opcode == 0x8:   # EOF or close
                break
            if opcode == 0x9:                      # ping -> pong
                writer.write(P.encode_frame(payload, opcode=0xA))
                await writer.drain()
                continue
            if opcode not in (0x1, 0x2):
                continue
            try:
                msg = json.loads(payload.decode("utf-8"))
            except Exception:
                continue
            dispatch_ws(conn, msg)
    finally:
        cleanup_ws(conn)
        conn.close()


def dispatch_ws(conn, msg):
    t = msg.get("type")

    # ---- join messages establish role ----
    if t == "host_join":
        host_id = db.host_for_token(msg.get("token"))
        room = MANAGER.get(msg.get("code"))
        if not room:
            return conn.send_json({"type": "error", "message": "Room not found."})
        if host_id != room.host_id:
            return conn.send_json({"type": "error", "message": "Not authorized to host this room."})
        conn.role = "host"
        conn.room = room
        room.host_conn = conn
        conn.send_json({"type": "joined", "role": "host", "code": room.code,
                        "title": room.quiz["title"]})
        room.send_full_state(conn)
        # if mid-review, resend the host review panel
        if room.phase == "review":
            room._send_review_to_host()
        return

    if t == "display_join":
        room = MANAGER.get(msg.get("code"))
        if not room:
            return conn.send_json({"type": "error", "message": "Room not found."})
        conn.role = "display"
        conn.room = room
        room.displays.add(conn)
        conn.send_json({"type": "joined", "role": "display", "code": room.code,
                        "title": room.quiz["title"]})
        room.send_full_state(conn)
        return

    if t == "team_join":
        room = MANAGER.get(msg.get("code"))
        if not room:
            return conn.send_json({"type": "error", "message": "Room not found."})
        name = (msg.get("name") or "").strip()[:40]
        if not name:
            return conn.send_json({"type": "error", "message": "Team name is required."})
        tid = msg.get("teamId")
        team = room.teams.get(tid) if tid else None
        if team is None:
            # Reattach by name: the device lost its stored id (reload, cleared
            # storage, new browser). If a team with this name is disconnected,
            # resume it instead of creating a duplicate.
            for t2 in room.teams.values():
                if t2.name.lower() == name.lower():
                    if t2.connected:
                        return conn.send_json({"type": "error",
                                               "message": f"“{name}” is already playing on another device."})
                    team = t2
                    break
        if team is None:
            team = MANAGER.add_team(room, name, msg.get("photo", ""))
        # allow rename / photo update on (re)join
        team.name = name
        team.away = False
        if msg.get("photo"):
            team.photo = msg["photo"]
        if team.conn and team.conn is not conn:
            team.conn.send_json({"type": "error", "message": "This team joined on another device."})
            team.conn.close()
        team.conn = conn
        conn.role = "team"
        conn.room = room
        conn.team_id = team.id
        conn.send_json({"type": "joined", "role": "team", "teamId": team.id,
                        "name": team.name, "code": room.code, "title": room.quiz["title"]})
        room.send_full_state(conn)
        room.broadcast(room.roster_msg())
        return

    # ---- all other messages require an established room ----
    room = conn.room
    if not room:
        return

    if conn.role == "host":
        handle_host_msg(room, t, msg)
    elif conn.role == "team":
        handle_team_msg(room, conn.team_id, t, msg)


def handle_host_msg(room, t, msg):
    if t == "start":
        room.start()
    elif t == "next":
        room.next()
    elif t == "prev":
        room.prev()
    elif t == "skip":
        room.skip()
    elif t == "add_time":
        room.add_time()
    elif t == "evaluate_now":
        room.evaluate_now()
    elif t == "buzz_correct":
        room.buzz_correct()
    elif t == "buzz_wrong":
        room.buzz_wrong()
    elif t == "buzz_abandon":
        room.buzz_abandon()
    elif t == "grade":
        room.grade_freetext(msg.get("marks", {}))
    elif t == "set_award":
        room.set_award(msg.get("teamId"), msg.get("award"))
    elif t == "finalize":
        room.finalize()
    elif t == "end":
        room.end()


def handle_team_msg(room, tid, t, msg):
    if t == "buzz":
        room.buzz(tid)
    elif t == "submit_text":
        room.submit_text(tid, (msg.get("text") or "")[:2000])
    elif t == "submit_select":
        room.submit_select(tid, msg.get("selection", []))
    elif t == "presence":
        # device backgrounded / foregrounded — surface it to the host roster
        team = room.teams.get(tid)
        if team:
            team.away = bool(msg.get("away"))
            room.broadcast(room.roster_msg())


def cleanup_ws(conn):
    room = conn.room
    if not room:
        return
    if conn.role == "host" and room.host_conn is conn:
        room.host_conn = None
    elif conn.role == "display":
        room.displays.discard(conn)
    elif conn.role == "team":
        team = room.teams.get(conn.team_id)
        if team and team.conn is conn:
            team.conn = None
            room.broadcast(room.roster_msg())


# ================================ HTTP / REST =================================

def json_response(obj, status="200 OK"):
    body = json.dumps(obj).encode()
    return (
        f"HTTP/1.1 {status}\r\n"
        "Content-Type: application/json\r\n"
        f"Content-Length: {len(body)}\r\n"
        "Connection: close\r\n\r\n"
    ).encode() + body


def text_response(text, status="200 OK", ctype="text/plain"):
    body = text.encode() if isinstance(text, str) else text
    return (
        f"HTTP/1.1 {status}\r\n"
        f"Content-Type: {ctype}\r\n"
        f"Content-Length: {len(body)}\r\n"
        "Connection: close\r\n\r\n"
    ).encode() + body


def serve_static(path):
    if path == "/" or path == "":
        path = "/index.html"
    # prevent path traversal
    rel = os.path.normpath(path).lstrip("/")
    full = os.path.join(WEB, rel)
    if not full.startswith(WEB) or not os.path.isfile(full):
        return text_response("Not found", "404 Not Found")
    ctype, _ = mimetypes.guess_type(full)
    ctype = ctype or "application/octet-stream"
    with open(full, "rb") as f:
        data = f.read()
    return text_response(data, ctype=ctype)


def require_host(req):
    return db.host_for_token(req.bearer())


def handle_api(req):
    path = req.path
    method = req.method

    if path == "/api/signup" and method == "POST":
        d = req.json()
        email, pw = (d.get("email") or "").strip(), d.get("password") or ""
        if not email or len(pw) < 6:
            return json_response({"error": "Email and a password of 6+ characters are required."}, "400 Bad Request")
        token, err = db.create_host(email, pw)
        if err:
            return json_response({"error": err}, "400 Bad Request")
        return json_response({"token": token, "email": email.lower()})

    if path == "/api/login" and method == "POST":
        d = req.json()
        token, err = db.login(d.get("email") or "", d.get("password") or "")
        if err:
            return json_response({"error": err}, "401 Unauthorized")
        return json_response({"token": token, "email": (d.get("email") or "").strip().lower()})

    # everything below requires auth
    host_id = require_host(req)
    if host_id is None:
        return json_response({"error": "Not authenticated."}, "401 Unauthorized")

    if path == "/api/me" and method == "GET":
        return json_response({"email": db.host_email(host_id)})

    if path == "/api/quizzes" and method == "GET":
        return json_response({"quizzes": db.list_quizzes(host_id)})

    if path == "/api/quizzes" and method == "POST":
        d = req.json()
        qid = db.create_quiz(host_id, d.get("title"))
        return json_response({"id": qid})

    if path.startswith("/api/quizzes/"):
        try:
            qid = int(path.split("/")[3])
        except (IndexError, ValueError):
            return json_response({"error": "Bad quiz id."}, "400 Bad Request")
        if method == "GET":
            quiz = db.get_quiz(host_id, qid)
            if not quiz:
                return json_response({"error": "Quiz not found."}, "404 Not Found")
            return json_response(quiz)
        if method == "PUT":
            d = req.json()
            ok = db.save_quiz(host_id, qid, d.get("title"), d.get("questions", []))
            return json_response({"ok": ok}) if ok else json_response({"error": "Not found."}, "404 Not Found")
        if method == "DELETE":
            ok = db.delete_quiz(host_id, qid)
            return json_response({"ok": ok})

    if path == "/api/rooms" and method == "POST":
        d = req.json()
        quiz = db.get_quiz(host_id, d.get("quiz_id"))
        if not quiz:
            return json_response({"error": "Quiz not found."}, "404 Not Found")
        room = MANAGER.create(host_id, quiz)
        return json_response({"code": room.code})

    if path.startswith("/api/rooms/") and method == "GET":
        code = path.split("/")[3]
        room = MANAGER.get(code)
        return json_response({"exists": bool(room),
                              "title": room.quiz["title"] if room else None})

    return json_response({"error": "Unknown endpoint."}, "404 Not Found")


# also allow checking room existence without auth (for the join page)
def handle_public_api(req):
    if req.path.startswith("/api/rooms/") and req.method == "GET":
        code = req.path.split("/")[3]
        room = MANAGER.get(code)
        return json_response({"exists": bool(room),
                              "title": room.quiz["title"] if room else None})
    return None


# ============================ connection handler =============================

async def handle_conn(reader, writer):
    try:
        req = await P.read_http_request(reader)
        if req is None:
            writer.close()
            return

        if req.is_ws_upgrade and req.path == "/ws":
            await handle_ws(reader, writer, req)
            return

        if req.path.startswith("/api/"):
            # public room lookup needs no auth
            pub = handle_public_api(req) if req.path.startswith("/api/rooms/") and req.method == "GET" else None
            resp = pub or handle_api(req)
            writer.write(resp)
            await writer.drain()
        else:
            writer.write(serve_static(req.path))
            await writer.drain()
    except (ConnectionResetError, BrokenPipeError, asyncio.IncompleteReadError):
        pass
    except Exception as e:
        try:
            writer.write(text_response(f"Server error: {e}", "500 Internal Server Error"))
            await writer.drain()
        except Exception:
            pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def main():
    db.init()
    mimetypes.add_type("application/javascript", ".js")
    server = await asyncio.start_server(handle_conn, HOST, PORT)
    print(f"\n  Quizzer running →  http://localhost:{PORT}\n")
    print("  Host console:   http://localhost:%d/" % PORT)
    print("  Join a game:    http://localhost:%d/play.html" % PORT)
    print("  Shared display: http://localhost:%d/display.html\n" % PORT)
    print("  (Ctrl+C to stop)\n")
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n  Stopped.\n")
        sys.exit(0)
