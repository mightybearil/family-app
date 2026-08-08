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

import base64
import binascii
import hmac
import json
import logging
import mimetypes
import os
import sqlite3
import sys
import threading
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CONFIG_PATH = os.environ.get("FAMILY_APP_CONFIG", "/etc/family-app/config.json")
DEFAULT_DB = "/var/lib/family-app/family_tasks.db"
DEFAULT_UPLOADS = "/var/lib/family-app/uploads"
DEFAULT_PORT = 8901
# Photos arrive base64-encoded inside the JSON body, which inflates them ~33%.
MAX_BODY_BYTES = 12 * 1024 * 1024
MAX_PHOTO_BYTES = 6 * 1024 * 1024

# Photos are stored on disk, not in SQLite: a few megabytes of BLOB per task
# would bloat the database file and slow every unrelated query.
PHOTO_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}

CATEGORIES = ("house", "shopping", "general", "projects", "events")
PRIORITIES = ("low", "medium", "high", "urgent")
STATUSES = ("pending", "in_progress", "completed", "overdue")

TASK_COLUMNS = (
    "id", "title", "description", "category", "assignee", "priority", "status",
    "progress", "due_date", "due_time", "location", "quantity", "created_by",
    "created_at", "updated_at",
)

# Columns added after the first release. CREATE TABLE IF NOT EXISTS will not add
# them to a database that already exists, so they are applied explicitly.
MIGRATIONS = (
    ("tasks", "due_time", "TEXT"),
    ("tasks", "location", "TEXT"),
)

log = logging.getLogger("family-storage")


def now_iso() -> str:
    # Milliseconds, not seconds: two status changes inside one second would
    # otherwise be indistinguishable, and the feed could show a stale one.
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


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
    cfg.setdefault("uploads", DEFAULT_UPLOADS)
    cfg.setdefault("port", DEFAULT_PORT)
    cfg.setdefault("host", "127.0.0.1")
    return cfg


def decode_data_url(value) -> tuple[bytes, str]:
    """
    Accepts a data: URL or bare base64 and returns (bytes, extension).
    Rejects anything that is not an image type we are willing to store.
    """
    if not isinstance(value, str) or not value.strip():
        raise ValidationError("photo data is required")

    text = value.strip()
    mime = "image/jpeg"
    if text.startswith("data:"):
        header, _, payload = text.partition(",")
        if not payload:
            raise ValidationError("malformed data URL")
        mime = header[5:].split(";")[0].strip().lower() or "image/jpeg"
        text = payload

    if mime not in PHOTO_TYPES:
        raise ValidationError(f"unsupported image type: {mime}")

    try:
        raw = base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValidationError(f"photo is not valid base64: {exc}") from exc

    if not raw:
        raise ValidationError("photo is empty")
    if len(raw) > MAX_PHOTO_BYTES:
        raise ValidationError(f"photo exceeds {MAX_PHOTO_BYTES // (1024 * 1024)} MB")
    return raw, PHOTO_TYPES[mime]


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
        self._migrate(conn)

    def _migrate(self, conn: sqlite3.Connection) -> None:
        """Adds columns introduced after a database was first created."""
        for table, column, coltype in MIGRATIONS:
            existing = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
            if column in existing:
                continue
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {coltype}")
            conn.commit()
            log.info("Migrated: added %s.%s", table, column)

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



def clean_time(value) -> str | None:
    """Accepts HH:MM (24h). Anything else is treated as no time rather than an error."""
    if value in (None, ""):
        return None
    text = str(value).strip()
    parts = text.split(":")
    if len(parts) < 2:
        return None
    try:
        hour, minute = int(parts[0]), int(parts[1])
    except ValueError:
        return None
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        return None
    return f"{hour:02d}:{minute:02d}"

def normalise_task(raw: dict) -> dict:
    if not isinstance(raw, dict):
        raise ValidationError("task must be an object")

    # A chore can belong to one of them or to both, so assignees is a list.
    # `assignee` stays populated with the first for the existing foreign key
    # and for any reader that predates multi-assignment.
    raw_assignees = raw.get("assignees")
    if isinstance(raw_assignees, str):
        raw_assignees = [raw_assignees]
    if not isinstance(raw_assignees, list):
        raw_assignees = [raw.get("assignee")]

    assignees = []
    for candidate in raw_assignees:
        member = clean_text(candidate, "assignee", max_length=64)
        if member and member not in assignees:
            assignees.append(member)
    assignee = assignees[0] if assignees else None

    created_at = clean_text(raw.get("created_at") or now_iso(), "created_at", max_length=40)
    return {
        "id": clean_text(raw.get("id") or str(uuid.uuid4()), "id", max_length=64, required=True),
        "title": clean_text(raw.get("title"), "title", max_length=200, required=True),
        "description": clean_text(raw.get("description"), "description", max_length=5000),
        "category": clean_enum(raw.get("category"), CATEGORIES, "general"),
        "assignee": assignee,
        "assignees": assignees,
        "priority": clean_enum(raw.get("priority"), PRIORITIES, "medium"),
        "status": clean_enum(raw.get("status"), STATUSES, "pending"),
        "progress": clean_int(raw.get("progress"), low=0, high=100, fallback=0),
        "due_date": clean_due_date(raw.get("due_date")),
        "due_time": clean_time(raw.get("due_time")),
        "location": clean_text(raw.get("location"), "location", max_length=200) or None,
        "quantity": clean_int(raw.get("quantity"), low=1, high=9999, fallback=1),
        "created_by": clean_text(raw.get("created_by"), "created_by", max_length=64) or None,
        "created_at": created_at,
        "updated_at": clean_text(raw.get("updated_at") or created_at, "updated_at", max_length=40),
    }


def row_to_task(row: sqlite3.Row, assignees: list[str] | None = None) -> dict:
    task = {key: row[key] for key in TASK_COLUMNS}
    task["progress"] = int(task["progress"] or 0)
    task["quantity"] = int(task["quantity"] or 1)
    # Falls back to the single column for rows written before the join table.
    task["assignees"] = assignees if assignees is not None else (
        [task["assignee"]] if task["assignee"] else []
    )
    return task


# -------------------------------------------------------------------- actions

class Actions:
    def __init__(self, db: Database, uploads: str = DEFAULT_UPLOADS):
        self.db = db
        self.uploads = uploads
        os.makedirs(uploads, exist_ok=True)

    def dispatch(self, payload: dict) -> dict:
        action = payload.get("action")
        if not isinstance(action, str):
            raise ValidationError("action is required")
        handler = getattr(self, f"do_{action}", None)
        if handler is None:
            raise ValidationError(f"unknown action: {action}")
        return handler(payload)


    def _sync_assignees(self, task_id: str, assignees: list[str]) -> list[str]:
        """
        Replaces the task's assignee rows. Unknown member ids are dropped rather
        than raising, so one bad id cannot fail an otherwise valid save; the
        foreign key would reject them anyway.
        """
        known = {r["id"] for r in self.db.query("SELECT id FROM members")}
        valid = [m for m in assignees if m in known]

        self.db.execute("DELETE FROM task_assignees WHERE task_id = ?", (task_id,))
        for member in valid:
            self.db.execute(
                "INSERT OR IGNORE INTO task_assignees (task_id, member_id) VALUES (?,?)",
                (task_id, member),
            )
        return valid

    def _assignees_for(self, task_ids: list[str]) -> dict[str, list[str]]:
        """One query for many tasks, rather than one query per row."""
        if not task_ids:
            return {}
        placeholders = ",".join("?" * len(task_ids))
        rows = self.db.query(
            f"SELECT task_id, member_id FROM task_assignees WHERE task_id IN ({placeholders})",
            tuple(task_ids),
        )
        grouped: dict[str, list[str]] = {}
        for row in rows:
            grouped.setdefault(row["task_id"], []).append(row["member_id"])
        return grouped

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
            # Matches tasks assigned to this person, including shared ones.
            clauses.append("id IN (SELECT task_id FROM task_assignees WHERE member_id = ?)")
            params.append(str(filters["assignee"])[:64])

        sql = "SELECT * FROM tasks"
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY created_at DESC"

        rows = self.db.query(sql, tuple(params))
        grouped = self._assignees_for([r["id"] for r in rows])
        return {"tasks": [row_to_task(r, grouped.get(r["id"], None)) for r in rows]}

    def do_get_task(self, payload: dict) -> dict:
        task_id = clean_text(payload.get("taskId"), "taskId", max_length=64, required=True)
        rows = self.db.query("SELECT * FROM tasks WHERE id = ?", (task_id,))
        if not rows:
            return {"task": None}
        grouped = self._assignees_for([task_id])
        return {"task": row_to_task(rows[0], grouped.get(task_id, None))}

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
        task["assignees"] = self._sync_assignees(task["id"], task.get("assignees") or [])
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
        if "assignees" in changes or "assignee" in changes:
            merged["assignees"] = self._sync_assignees(task_id, merged.get("assignees") or [])
        else:
            # Untouched: keep what is already stored rather than wiping it.
            merged["assignees"] = self._assignees_for([task_id]).get(task_id, [])

        if "status" in changes:
            self._log_activity("update_status", task_id, f"{merged['title']}: {merged['status']}", None)
        return {"task": merged}

    def do_delete_task(self, payload: dict) -> dict:
        task_id = clean_text(payload.get("taskId"), "taskId", max_length=64, required=True)
        rows = self.db.query("SELECT title FROM tasks WHERE id = ?", (task_id,))

        # Rows cascade via the schema's foreign keys, but the files on disk do
        # not — collect them before the delete or they are orphaned forever.
        orphans = [r["path"] for r in
                   self.db.query("SELECT path FROM photos WHERE task_id = ?", (task_id,))]

        self.db.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
        for stored_name in orphans:
            self._remove_upload(stored_name)

        if rows:
            self._log_activity("delete_task", None, rows[0]["title"], None)
        return {"deleted": bool(rows), "taskId": task_id, "photosRemoved": len(orphans)}

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
        self._log_activity("add_comment", comment["task_id"], comment["content"][:200], comment["author"])
        return {"comment": comment}

    # -- links -------------------------------------------------------------

    def do_get_links(self, payload: dict) -> dict:
        task_id = clean_text(payload.get("taskId"), "taskId", max_length=64, required=True)
        rows = self.db.query(
            "SELECT id, task_id, url, title, added_by, created_at FROM links "
            "WHERE task_id = ? ORDER BY created_at ASC",
            (task_id,),
        )
        return {"links": [dict(r) for r in rows]}

    def do_add_link(self, payload: dict) -> dict:
        raw = payload.get("link") or {}
        url = clean_text(raw.get("url"), "url", max_length=2000, required=True)
        if not url.lower().startswith(("http://", "https://")):
            raise ValidationError("url must be http or https")
        link = {
            "id": clean_text(raw.get("id") or str(uuid.uuid4()), "id", max_length=64),
            "task_id": clean_text(raw.get("task_id") or payload.get("taskId"), "task_id",
                                  max_length=64, required=True),
            "url": url,
            "title": clean_text(raw.get("title"), "title", max_length=200) or url,
            "added_by": clean_text(raw.get("added_by"), "added_by", max_length=64) or None,
            "created_at": clean_text(raw.get("created_at") or now_iso(), "created_at", max_length=40),
        }
        if not self.db.query("SELECT 1 FROM tasks WHERE id = ?", (link["task_id"],)):
            raise ValidationError(f"no such task: {link['task_id']}")
        self.db.execute(
            "INSERT OR REPLACE INTO links (id, task_id, url, title, added_by, created_at) "
            "VALUES (?,?,?,?,?,?)",
            tuple(link[k] for k in ("id", "task_id", "url", "title", "added_by", "created_at")),
        )
        return {"link": link}

    def do_delete_link(self, payload: dict) -> dict:
        link_id = clean_text(payload.get("linkId"), "linkId", max_length=64, required=True)
        self.db.execute("DELETE FROM links WHERE id = ?", (link_id,))
        return {"deleted": True, "linkId": link_id}

    # -- photos ------------------------------------------------------------

    def do_get_photos(self, payload: dict) -> dict:
        """Metadata only — callers fetch bytes per photo so a task with many
        attachments does not force one enormous response."""
        task_id = clean_text(payload.get("taskId"), "taskId", max_length=64, required=True)
        rows = self.db.query(
            "SELECT id, task_id, filename, uploaded_by, created_at FROM photos "
            "WHERE task_id = ? ORDER BY created_at ASC",
            (task_id,),
        )
        return {"photos": [dict(r) for r in rows]}

    def do_get_photo(self, payload: dict) -> dict:
        photo_id = clean_text(payload.get("photoId"), "photoId", max_length=64, required=True)
        rows = self.db.query("SELECT * FROM photos WHERE id = ?", (photo_id,))
        if not rows:
            raise ValidationError(f"no such photo: {photo_id}")

        stored = self._resolve_upload(rows[0]["path"])
        try:
            with open(stored, "rb") as fh:
                raw = fh.read()
        except OSError as exc:
            raise ValidationError(f"photo file is missing: {exc}") from exc

        mime = mimetypes.guess_type(stored)[0] or "image/jpeg"
        return {"photo": {
            "id": rows[0]["id"],
            "task_id": rows[0]["task_id"],
            "filename": rows[0]["filename"],
            "created_at": rows[0]["created_at"],
            "data": f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}",
        }}

    def do_add_photo(self, payload: dict) -> dict:
        raw_photo = payload.get("photo") or {}
        task_id = clean_text(raw_photo.get("task_id") or payload.get("taskId"),
                             "task_id", max_length=64, required=True)
        if not self.db.query("SELECT 1 FROM tasks WHERE id = ?", (task_id,)):
            raise ValidationError(f"no such task: {task_id}")

        blob, extension = decode_data_url(raw_photo.get("data") or raw_photo.get("path"))
        photo_id = clean_text(raw_photo.get("id") or str(uuid.uuid4()), "id", max_length=64)

        # The stored name is derived from the id, never from client input, so a
        # crafted filename cannot escape the uploads directory.
        stored_name = f"{uuid.uuid4().hex}{extension}"
        target = os.path.join(self.uploads, stored_name)
        os.makedirs(self.uploads, exist_ok=True)
        with open(target, "wb") as fh:
            fh.write(blob)
        os.chmod(target, 0o600)

        record = {
            "id": photo_id,
            "task_id": task_id,
            "filename": clean_text(raw_photo.get("filename"), "filename", max_length=120) or stored_name,
            "path": stored_name,
            "uploaded_by": clean_text(raw_photo.get("uploaded_by"), "uploaded_by", max_length=64) or None,
            "created_at": clean_text(raw_photo.get("created_at") or now_iso(), "created_at", max_length=40),
        }
        self.db.execute(
            "INSERT OR REPLACE INTO photos (id, task_id, filename, path, uploaded_by, created_at) "
            "VALUES (?,?,?,?,?,?)",
            tuple(record[k] for k in ("id", "task_id", "filename", "path", "uploaded_by", "created_at")),
        )
        self._log_activity("add_photo", task_id, record["filename"], record["uploaded_by"])
        log.info("stored photo %s (%d bytes) for task %s", photo_id, len(blob), task_id)
        return {"photo": {k: v for k, v in record.items() if k != "path"}}

    def do_delete_photo(self, payload: dict) -> dict:
        photo_id = clean_text(payload.get("photoId"), "photoId", max_length=64, required=True)
        rows = self.db.query("SELECT path FROM photos WHERE id = ?", (photo_id,))
        self.db.execute("DELETE FROM photos WHERE id = ?", (photo_id,))
        if rows:
            self._remove_upload(rows[0]["path"])
        return {"deleted": bool(rows), "photoId": photo_id}

    # -- upload helpers ----------------------------------------------------

    def _resolve_upload(self, stored_name: str) -> str:
        """Join under the uploads dir and refuse anything that escapes it."""
        base = os.path.realpath(self.uploads)
        target = os.path.realpath(os.path.join(base, os.path.basename(str(stored_name))))
        if not target.startswith(base + os.sep):
            raise ValidationError("invalid photo path")
        return target

    def _remove_upload(self, stored_name: str) -> None:
        try:
            os.remove(self._resolve_upload(stored_name))
        except (OSError, ValidationError) as exc:
            log.warning("could not remove upload %s: %s", stored_name, exc)

    # -- activity ----------------------------------------------------------

    def do_get_activity(self, payload: dict) -> dict:
        """
        Collapses repeats before returning. Completing a task, un-completing it
        and completing it again is one fact — "it is done" — not three feed
        entries, and a double-tap should never read as two separate events.

        Deduplication happens on read rather than on write so the underlying log
        stays a complete audit trail; only the presentation is condensed.
        """
        limit = clean_int(payload.get("limit", 20), low=1, high=200, fallback=20)
        task_id = payload.get("taskId")

        # Over-fetch: identical events collapse away, so reading exactly `limit`
        # rows would return a short page whenever there are repeats.
        fetch = min(limit * 5, 500)
        if task_id:
            rows = self.db.query(
                "SELECT * FROM activity_log WHERE task_id = ? "
                "ORDER BY created_at DESC, rowid DESC LIMIT ?",
                (str(task_id)[:64], fetch),
            )
        else:
            rows = self.db.query(
                "SELECT * FROM activity_log ORDER BY created_at DESC, rowid DESC LIMIT ?", (fetch,)
            )

        seen: set[tuple] = set()
        activity = []
        for row in rows:
            entry = dict(row)
            # Rows arrive newest-first, so the first occurrence is the one to keep.
            # Status changes ignore the details, collapsing a done/undone/done
            # sequence to where the task actually ended up. Other actions keep
            # details in the key, since two different comments are two events.
            if entry.get("action") == "update_status":
                key = (entry.get("task_id"), "update_status", entry.get("actor"))
            else:
                key = (entry.get("task_id"), entry.get("action"),
                       entry.get("actor"), entry.get("details"))
            if key in seen:
                continue
            seen.add(key)
            activity.append(entry)
            if len(activity) >= limit:
                break
        return {"activity": activity}

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
    Handler.actions = Actions(db, config["uploads"])

    server = ThreadingHTTPServer((config["host"], int(config["port"])), Handler)
    server.daemon_threads = True
    log.info("Storage service on http://%s:%s  db=%s  uploads=%s",
             config["host"], config["port"], config["database"], config["uploads"])
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("Shutting down")
        server.shutdown()


if __name__ == "__main__":
    main()
