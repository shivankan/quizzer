"""SQLite persistence + auth helpers. Stdlib only."""
import sqlite3
import os
import json
import time
import hashlib
import secrets
import threading

# Override with QUIZZER_DB to point at a persistent disk when deployed
# (e.g. /var/data/quizzer.db on a Render disk); defaults to the project dir.
DB_PATH = os.environ.get("QUIZZER_DB") or os.path.join(
    os.path.dirname(os.path.dirname(__file__)), "quizzer.db")

_local = threading.local()


def _conn():
    # asyncio runs on one thread, but guard anyway with a thread-local conn.
    c = getattr(_local, "conn", None)
    if c is None:
        c = sqlite3.connect(DB_PATH)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        _local.conn = c
    return c


SCHEMA = """
CREATE TABLE IF NOT EXISTS hosts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT UNIQUE NOT NULL,
    pw_hash    TEXT NOT NULL,
    pw_salt    TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    host_id    INTEGER NOT NULL,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS resets (
    token_hash TEXT PRIMARY KEY,
    host_id    INTEGER NOT NULL,
    created_at REAL NOT NULL,
    expires_at REAL NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS quizzes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id    INTEGER NOT NULL,
    title      TEXT NOT NULL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS questions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    quiz_id     INTEGER NOT NULL,
    position    INTEGER NOT NULL,
    type        TEXT NOT NULL,            -- buzzer | freetext | select
    text        TEXT NOT NULL DEFAULT '',
    image_url   TEXT NOT NULL DEFAULT '',
    points      INTEGER NOT NULL DEFAULT 10,
    timer_seconds   INTEGER NOT NULL DEFAULT 30,
    time_increment  INTEGER NOT NULL DEFAULT 10,
    multi_select    INTEGER NOT NULL DEFAULT 0,
    options_json    TEXT NOT NULL DEFAULT '[]',
    correct_json    TEXT NOT NULL DEFAULT '[]'
);
"""


def init():
    c = _conn()
    c.executescript(SCHEMA)
    c.commit()


# ---------- auth ----------

def _hash(password, salt):
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100_000).hex()


def create_host(email, password):
    email = email.strip().lower()
    salt = secrets.token_hex(16)
    pw_hash = _hash(password, salt)
    c = _conn()
    try:
        cur = c.execute(
            "INSERT INTO hosts(email, pw_hash, pw_salt, created_at) VALUES (?,?,?,?)",
            (email, pw_hash, salt, time.time()),
        )
        c.commit()
    except sqlite3.IntegrityError:
        return None, "An account with that email already exists."
    return _new_session(cur.lastrowid), None


def login(email, password):
    email = email.strip().lower()
    row = _conn().execute("SELECT * FROM hosts WHERE email=?", (email,)).fetchone()
    if not row:
        return None, "No account with that email."
    if _hash(password, row["pw_salt"]) != row["pw_hash"]:
        return None, "Incorrect password."
    return _new_session(row["id"]), None


def _new_session(host_id):
    token = secrets.token_urlsafe(24)
    c = _conn()
    c.execute(
        "INSERT INTO sessions(token, host_id, created_at) VALUES (?,?,?)",
        (token, host_id, time.time()),
    )
    c.commit()
    return token


def host_for_token(token):
    if not token:
        return None
    row = _conn().execute("SELECT host_id FROM sessions WHERE token=?", (token,)).fetchone()
    return row["host_id"] if row else None


def host_email(host_id):
    row = _conn().execute("SELECT email FROM hosts WHERE id=?", (host_id,)).fetchone()
    return row["email"] if row else None


def host_id_by_email(email):
    row = _conn().execute(
        "SELECT id FROM hosts WHERE email=?", ((email or "").strip().lower(),)
    ).fetchone()
    return row["id"] if row else None


# ---------- password reset ----------

RESET_TTL = 30 * 60  # seconds


def _token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def create_reset(host_id):
    """Issue a single-use, expiring reset token. Only its hash is stored, so a
    database leak can't be turned into account takeover."""
    token = secrets.token_urlsafe(32)
    now = time.time()
    c = _conn()
    # one live token per host — issuing a new one invalidates older ones
    c.execute("DELETE FROM resets WHERE host_id=?", (host_id,))
    c.execute(
        "INSERT INTO resets(token_hash, host_id, created_at, expires_at) VALUES (?,?,?,?)",
        (_token_hash(token), host_id, now, now + RESET_TTL),
    )
    c.commit()
    return token


def peek_reset(token):
    """Return host_id if the token is valid and unused, else None."""
    row = _conn().execute(
        "SELECT host_id, expires_at, used FROM resets WHERE token_hash=?",
        (_token_hash(token or ""),),
    ).fetchone()
    if not row or row["used"] or row["expires_at"] < time.time():
        return None
    return row["host_id"]


def consume_reset(token, new_password):
    """Validate the token, set the new password, burn the token, and sign out
    every existing session for that host."""
    host_id = peek_reset(token)
    if host_id is None:
        return None, "That reset link is invalid or has expired."
    if not new_password or len(new_password) < 6:
        return None, "Password needs at least 6 characters."
    salt = secrets.token_hex(16)
    c = _conn()
    c.execute("UPDATE hosts SET pw_hash=?, pw_salt=? WHERE id=?",
              (_hash(new_password, salt), salt, host_id))
    c.execute("DELETE FROM resets WHERE host_id=?", (host_id,))
    c.execute("DELETE FROM sessions WHERE host_id=?", (host_id,))  # log out everywhere
    c.commit()
    return _new_session(host_id), None


# ---------- quizzes ----------

def list_quizzes(host_id):
    rows = _conn().execute(
        "SELECT q.id, q.title, q.updated_at, "
        "(SELECT COUNT(*) FROM questions WHERE quiz_id=q.id) AS qcount "
        "FROM quizzes q WHERE host_id=? ORDER BY updated_at DESC",
        (host_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def create_quiz(host_id, title):
    now = time.time()
    c = _conn()
    cur = c.execute(
        "INSERT INTO quizzes(host_id, title, created_at, updated_at) VALUES (?,?,?,?)",
        (host_id, title or "Untitled quiz", now, now),
    )
    c.commit()
    return cur.lastrowid


def get_quiz(host_id, quiz_id):
    c = _conn()
    q = c.execute("SELECT * FROM quizzes WHERE id=? AND host_id=?", (quiz_id, host_id)).fetchone()
    if not q:
        return None
    qs = c.execute(
        "SELECT * FROM questions WHERE quiz_id=? ORDER BY position", (quiz_id,)
    ).fetchall()
    questions = []
    for r in qs:
        d = dict(r)
        d["options"] = json.loads(d.pop("options_json"))
        d["correct"] = json.loads(d.pop("correct_json"))
        d["multi_select"] = bool(d["multi_select"])
        questions.append(d)
    return {"id": q["id"], "title": q["title"], "questions": questions}


def quiz_owner(quiz_id):
    row = _conn().execute("SELECT host_id FROM quizzes WHERE id=?", (quiz_id,)).fetchone()
    return row["host_id"] if row else None


def save_quiz(host_id, quiz_id, title, questions):
    c = _conn()
    owner = quiz_owner(quiz_id)
    if owner != host_id:
        return False
    c.execute(
        "UPDATE quizzes SET title=?, updated_at=? WHERE id=?",
        (title or "Untitled quiz", time.time(), quiz_id),
    )
    c.execute("DELETE FROM questions WHERE quiz_id=?", (quiz_id,))
    for pos, q in enumerate(questions):
        qtype = q.get("type", "buzzer")
        if qtype not in ("buzzer", "freetext", "select"):
            qtype = "buzzer"
        c.execute(
            "INSERT INTO questions(quiz_id, position, type, text, image_url, points, "
            "timer_seconds, time_increment, multi_select, options_json, correct_json) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (
                quiz_id, pos, qtype,
                (q.get("text") or "").strip(),
                (q.get("image_url") or "").strip(),
                int(q.get("points") or 0),
                int(q.get("timer_seconds") or 0),
                int(q.get("time_increment") or 0),
                1 if q.get("multi_select") else 0,
                json.dumps(q.get("options") or []),
                json.dumps(q.get("correct") or []),
            ),
        )
    c.commit()
    return True


def import_quiz(host_id, data):
    """Create a quiz for a host from {title, questions:[...]}. Returns the new id.

    Used by seed import and by JSON upload, so both paths share validation
    (save_quiz coerces types and drops unknown fields).
    """
    title = (data.get("title") or "Imported quiz").strip()[:120] or "Imported quiz"
    # de-duplicate the title so a re-import never silently overwrites
    base, n = title, 2
    while quiz_id_by_title(host_id, title):
        title = f"{base} ({n})"
        n += 1
    qid = create_quiz(host_id, title)
    save_quiz(host_id, qid, title, data.get("questions") or [])
    return qid, title


def quiz_id_by_title(host_id, title):
    row = _conn().execute(
        "SELECT id FROM quizzes WHERE host_id=? AND title=?", (host_id, title)
    ).fetchone()
    return row["id"] if row else None


def delete_quiz(host_id, quiz_id):
    c = _conn()
    if quiz_owner(quiz_id) != host_id:
        return False
    c.execute("DELETE FROM questions WHERE quiz_id=?", (quiz_id,))
    c.execute("DELETE FROM quizzes WHERE id=?", (quiz_id,))
    c.commit()
    return True
