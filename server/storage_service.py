#!/usr/bin/env python3
"""
Family Tasks storage service.

A deterministic JSON-over-HTTP layer in front of the SQLite database defined in
schema.sql. It exists because the task list must not live inside a language
model's conversation transcript: an LLM recalling a list can drop, invent, or
truncate entries, and every read costs tokens. CRUD belongs here; nanobot keeps
the natural-language work (WhatsApp, summaries) it is actually good at.

Standard library only — the host is a 1 GB instance already running two
containers, so this adds no dependency tree and ~20 MB of RSS.

Protocol
    POST /api      {"action": "...", ...}  ->  {"success": true, "data": {...}}
    GET  /api/health                       ->  {"status": "ok", ...}

Authentication
    Authorization: Bearer <token>   (token read from the config file)
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import sqlite3
import sys
import threading
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CONFIG_PATH = os.environ.get("FAMILY_APP_CONFIG", "/etc/family-app/config.json")
DEFAULT_DB = "/var/lib/family-app/family_tasks.db"
DEFAULT_PORT = 8901
MAX_BODY_BYTES = 2 * 1024 * 1024

CATEGORIES = ("house", "shopping", "general", "projects", "events")
PRIORITIES = ("low", "medium", "high", "urgent")
STATUSES = ("pending", "in_progress", "completed", "overdue")

TASK_COLUMNS = (
    "id", "title", "description", "category", "assignee", "priority", "status",
    "progress", "due_date", "quantity", "created_by", "created_at", "updated_at",
)

log = logging.getLogger("family-storage")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class ValidationError(Exception):
    """Client sent something unusable; surfaced as success:false, not a 500."""


# --------------------------------------------------------------------- config

def load_config() -> dict:
    try:
        with open(CONFIG_PATH, encoding="utf-8") as fh:
            cfg = json.load(fh)
    except FileNotFoundError:
        sys.exit(f"Config not found: {CONFIG_PATH}")
    except json.JSONDecodeError as exc:
        sys.exit(f"Config is not valid JSON: {exc}")

    token = str(cfg.get("apiToken") or "").strip()
    if not token:
        sys.exit("Config must set a non-empty 'apiToken'.")

    cfg["apiToken"] = token
    cfg.setdefault("database", DEFAULT_DB)
    cfg.setdefault("port", DEFAULT_PORT)
    cfg.setdefault("host", "127.0.0.1")
    return cfg


# ------------------------------------------------------------------- database

class Database:
    """
    One connection per thread. SQLite objects are not shareable across threads,
    and WAL lets readers proceed while a writer holds the lock.
    """

    def __init__(self, path: str, schema_path: str | None = None):
        self.path = path
        self._local = threading.local()
        self._write_lock = threading.Lock()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self._initialise(schema_path)

    def _initialise(self, schema_path: str | None) -> None:
        conn = self.connection
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        if schema_path and os.path.exists(schema_path):
            with open(schema_path, encoding="utf-8") as fh:
                conn.executescript(fh.read())
            conn.commit()
            log.info("Schema applied from %s", schema_path)

    @property
    def connection(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self.path, timeout=10.0, isolation_level=None)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys=ON")
            self._local.conn = conn
        return conn

    def query(self, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        return self.connection.execute(sql, params).fetchall()

    def execute(self, sql: str, params: tuple = ()) -> None:
        # Serialised: SQLite allows a single writer, and this keeps "database is
        # locked" out of the response path entirely.
        with self._write_lock:
            self.connection.execute(sql, params)


# ----------------------------------------------------------------- validation

def clean_text(value, field: str, *, max_length: int, required: bool = False) -> str:
    if value is None:
        value = ""
    if not isinstance(value, (str, int, float)):
        raise ValidationError(f"{field} must be text")
    text = str(value).strip()
    if required and not text:
        raise ValidationError(f"{field} is required")
    if len(text) > max_length:
        raise ValidationError(f"{field} exceeds {max_length} characters")
    return text


def clean_enum(value, allowed: tuple, fallback: str) -> str:
    return value if value in allowed else fallback


def clean_int(value, *, low: int, high: int, fallback: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(low, min(high, number))


def clean_due_date(value) -> str | None:
    """Accepts YYYY-MM-DD, an ISO timestamp, or epoch milliseconds."""
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value / 1000, timezone.utc).strftime("%Y-%m-%d")
    text = str(value).strip()
    for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(text[: len(fmt) + 2].rstrip("Z"), fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    raise ValidationError(f"due_date is not a recognisable date: {value!r}")


def normalise_task(raw: dict) -> dict:
    if not isinstance(raw, dict):
        raise ValidationError("task must be an object")

    assignee = raw.get("assignee")
    if assignee in ("", None):
        assignee = None

    created_at = clean_text(raw.get("created_at") or now_iso(), "created_at", max_length=40)
    return {
        "id": clean_text(raw.get("id") or str(uuid.uuid4()), "id", max_length=64, required=True),
        "title": clean_text(raw.get("title"), "title", max_length=200, required=True),
        "description": clean_text(raw.get("description"), "description", max_length=5000),
        "category": clean_enum(raw.get("category"), CATEGORIES, "general"),
        "assignee": clean_text(assignee, "assignee", max_length=64) or None,
        "priority": clean_enum(raw.get("priority"), PRIORITIES, "medium"),
        "status": clean_enum(raw.get("status"), STATUSES, "pending"),
        "progress": clean_int(raw.get("progress"), low=0, high=100, fallback=0),
        "due_date": clean_due_date(raw.get("due_date")),
        "quantity": clean_int(raw.get("quantity"), low=1, high=9999, fallback=1),
        "created_by": clean_text(raw.get("created_by"), "created_by", max_length=64) or None,
        "created_at": created_at,
        "updated_at": clean_text(raw.get("updated_at") or created_at, "updated_at", max_length=40),
    }


def row_to_task(row: sqlite3.Row) -> dict:
    task = {key: row[key] for key in TASK_COLUMNS}
    task["progress"] = int(task["progress"] or 0)
    task["quantity"] = int(task["quantity"] or 1)
    return task


# -------------------------------------------------------------------- actions

class Actions:
    def __init__(self, db: Database):
        self.db = db

    def dispatch(self, payload: dict) -> dict:
        action = payload.get("action")
        if not isinstance(action, str):
            raise ValidationError("action is required")
        handler = getattr(self, f"do_{action}", None)
        if handler is None:
            raise ValidationError(f"unknown action: {action}")
        return handler(payload)

    # -- health ------------------------------------------------------------

    def do_ping(self, _payload: dict) -> dict:
        count = self.db.query("SELECT COUNT(*) AS n FROM tasks")[0]["n"]
        return {"pong": True, "tasks": count, "time": now_iso()}

    # -- tasks -------------------------------------------------------------

    def do_get_tasks(self, payload: dict) -> dict:
        filters = payload.get("filters") or {}
        clauses, params = [], []
        for column, allowed in (("category", CATEGORIES), ("status", STATUSES)):
            value = filters.get(column)
            if value in allowed:
                clauses.append(f"{column} = ?")
                params.append(value)
        if filters.get("assignee"):
            clauses.append("assignee = ?")
            params.append(str(filters["assignee"])[:64])

        sql = "SELECT * FROM tasks"
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY created_at DESC"
        return {"tasks": [row_to_task(r) for r in self.db.query(sql, tuple(params))]}

    def do_get_task(self, payload: dict) -> dict:
        task_id = clean_text(payload.get("taskId"), "taskId", max_length=64, required=True)
        rows = self.db.query("SELECT * FROM tasks WHERE id = ?", (task_id,))
        return {"task": row_to_task(rows[0]) if rows else None}

    def do_create_task(self, payload: dict) -> dict:
        task = normalise_task(payload.get("task") or payload.get("taskData") or {})
        self.db.execute(
            """INSERT INTO tasks (id, title, description, category, assignee, priority,
                                  status, progress, due_date, quantity, created_by,
                                  created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET
                 title=excluded.title, description=excluded.description,
                 category=excluded.category, assignee=excluded.assignee,
                 priority=excluded.priority, status=excluded.status,
                 progress=excluded.progress, due_date=excluded.due_date,
                 quantity=excluded.quantity, updated_at=excluded.updated_at""",
            tuple(task[c] for c in TASK_COLUMNS),
        )
        self._log_activity("create_task", task["id"], task["title"], task["created_by"])
        return {"task": task}

    def do_update_task(self, payload: dict) -> dict:
        task_id = clean_text(payload.get("taskId"), "taskId", max_length=64, required=True)
        rows = self.db.query("SELECT * FROM tasks WHERE id = ?", (task_id,))
        if not rows:
            raise ValidationError(f"no such task: {task_id}")

        changes = payload.get("changes") or {}
        if not isinstance(changes, dict):
            raise ValidationError("changes must be an object")

        merged = normalise_task({**row_to_task(rows[0]), **changes, "id": task_id})
        merged["updated_at"] = now_iso()
        assignments = ", ".join(f"{c} = ?" for c in TASK_COLUMNS if c != "id")
        self.db.execute(
            f"UPDATE tasks SET {assignments} WHERE id = ?",
            tuple(merged[c] for c in TASK_COLUMNS if c != "id") + (task_id,),
        )
        if "status" in changes:
            self._log_activity("update_status", task_id, f"{merged['title']}: {merged['status']}", None)
        return {"task": merged}

    def do_delete_task(self, payload: dict) -> dict:
        task_id = clean_text(payload.get("taskId"), "taskId", max_length=64, required=True)
        rows = self.db.query("SELECT title FROM tasks WHERE id = ?", (task_id,))
        # Comments, photos and links cascade via the schema's foreign keys.
        self.db.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
        if rows:
            self._log_activity("delete_task", None, rows[0]["title"], None)
        return {"deleted": bool(rows), "taskId": task_id}

    # -- comments ----------------------------------------------------------

    def do_get_comments(self, payload: dict) -> dict:
        task_id = clean_text(payload.get("taskId"), "taskId", max_length=64, required=True)
        rows = self.db.query(
            "SELECT id, task_id, author, content, created_at FROM comments "
            "WHERE task_id = ? ORDER BY created_at ASC",
            (task_id,),
        )
        return {"comments": [dict(r) for r in rows]}

    def do_add_comment(self, payload: dict) -> dict:
        raw = payload.get("comment") or {}
        comment = {
            "id": clean_text(raw.get("id") or str(uuid.uuid4()), "id", max_length=64),
            "task_id": clean_text(raw.get("task_id") or payload.get("taskId"), "task_id",
                                  max_length=64, required=True),
            "author": clean_text(raw.get("author"), "author", max_length=64) or None,
            "content": clean_text(raw.get("content"), "content", max_length=5000, required=True),
            "created_at": clean_text(raw.get("created_at") or now_iso(), "created_at", max_length=40),
        }
        if not self.db.query("SELECT 1 FROM tasks WHERE id = ?", (comment["task_id"],)):
            raise ValidationError(f"no such task: {comment['task_id']}")
        self.db.execute(
            "INSERT OR REPLACE INTO comments (id, task_id, author, content, created_at) "
            "VALUES (?,?,?,?,?)",
            (comment["id"], comment["task_id"], comment["author"],
             comment["content"], comment["created_at"]),
        )
        self._log_activity("add_comment", comment["task_id"], comment["content"][:60], comment["author"])
        return {"comment": comment}

    # -- activity ----------------------------------------------------------

    def do_get_activity(self, payload: dict) -> dict:
        limit = clean_int(payload.get("limit", 20), low=1, high=200, fallback=20)
        task_id = payload.get("taskId")
        if task_id:
            rows = self.db.query(
                "SELECT * FROM activity_log WHERE task_id = ? ORDER BY created_at DESC LIMIT ?",
                (str(task_id)[:64], limit),
            )
        else:
            rows = self.db.query(
                "SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?", (limit,)
            )
        return {"activity": [dict(r) for r in rows]}

    def do_get_members(self, _payload: dict) -> dict:
        rows = self.db.query("SELECT id, name, avatar, phone FROM members ORDER BY id")
        return {"members": [dict(r) for r in rows]}

    def _log_activity(self, action: str, task_id, details, actor) -> None:
        self.db.execute(
            "INSERT INTO activity_log (id, task_id, action, details, source, actor, created_at) "
            "VALUES (?,?,?,?,?,?,?)",
            (str(uuid.uuid4()), task_id, action, str(details or "")[:200], "user", actor, now_iso()),
        )


# ---------------------------------------------------------------------- http

class Handler(BaseHTTPRequestHandler):
    server_version = "FamilyStorage/1.0"
    protocol_version = "HTTP/1.1"

    config: dict = {}
    actions: Actions

    def log_message(self, fmt, *args):  # noqa: A003 - base class hook
        log.info("%s - %s", self.client_address[0], fmt % args)

    def _respond(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _authorised(self) -> bool:
        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return False
        # Constant-time: a timing oracle on the token is cheap to avoid.
        return hmac.compare_digest(header[7:].strip(), self.config["apiToken"])

    def do_GET(self):  # noqa: N802 - base class hook
        if self.path.rstrip("/") in ("/api/health", "/health"):
            self._respond(200, {"status": "ok", "service": "family-storage", "time": now_iso()})
            return
        self._respond(404, {"success": False, "error": "not found"})

    def do_POST(self):  # noqa: N802 - base class hook
        if self.path.rstrip("/") not in ("/api", ""):
            self._respond(404, {"success": False, "error": "not found"})
            return

        if not self._authorised():
            self._respond(401, {"success": False, "error": "unauthorized"})
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY_BYTES:
            self._respond(413, {"success": False, "error": "invalid body size"})
            return

        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            self._respond(400, {"success": False, "error": f"invalid JSON: {exc}"})
            return

        if not isinstance(payload, dict):
            self._respond(400, {"success": False, "error": "body must be a JSON object"})
            return

        try:
            data = self.actions.dispatch(payload)
            self._respond(200, {"success": True, "data": data, "error": ""})
        except ValidationError as exc:
            self._respond(200, {"success": False, "data": {}, "error": str(exc)})
        except sqlite3.Error as exc:
            log.exception("database error")
            self._respond(500, {"success": False, "data": {}, "error": f"database error: {exc}"})
        except Exception as exc:  # noqa: BLE001 - must not kill the thread
            log.exception("unhandled error")
            self._respond(500, {"success": False, "data": {}, "error": f"internal error: {exc}"})


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        stream=sys.stdout,
    )
    config = load_config()
    schema = os.environ.get("FAMILY_APP_SCHEMA", "/opt/family-app/schema.sql")

    db = Database(config["database"], schema)
    Handler.config = config
    Handler.actions = Actions(db)

    server = ThreadingHTTPServer((config["host"], int(config["port"])), Handler)
    server.daemon_threads = True
    log.info("Storage service on http://%s:%s  db=%s",
             config["host"], config["port"], config["database"])
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("Shutting down")
        server.shutdown()


if __name__ == "__main__":
    main()
