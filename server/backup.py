#!/usr/bin/env python3
"""
Nightly backup of the Family Tasks database and photo uploads.

Uses SQLite's online backup API rather than copying the file: with WAL enabled,
a plain `cp` of a live database can capture a torn state that restores to a
corrupt or stale copy. The backup API takes a consistent snapshot while the
service keeps serving requests.

Every backup is verified with PRAGMA integrity_check before it is kept — an
unverified backup is a guess, not a backup.

Run by family-backup.timer; see family-backup.service.
"""

from __future__ import annotations

import gzip
import json
import os
import shutil
import sqlite3
import sys
import tarfile
import tempfile
from datetime import datetime, timezone

CONFIG_PATH = os.environ.get("FAMILY_APP_CONFIG", "/etc/family-app/config.json")
BACKUP_DIR = os.environ.get("FAMILY_APP_BACKUPS", "/var/backups/family-app")
KEEP_DAYS = int(os.environ.get("FAMILY_APP_BACKUP_KEEP", "14"))


def log(message: str) -> None:
    print(f"{datetime.now(timezone.utc).isoformat(timespec='seconds')} {message}", flush=True)


def load_paths() -> tuple[str, str]:
    with open(CONFIG_PATH, encoding="utf-8") as fh:
        cfg = json.load(fh)
    return (
        cfg.get("database", "/var/lib/family-app/family_tasks.db"),
        cfg.get("uploads", "/var/lib/family-app/uploads"),
    )


def snapshot_database(source: str, destination: str) -> int:
    """Consistent copy via the online backup API, then verify it."""
    src = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    try:
        dst = sqlite3.connect(destination)
        try:
            src.backup(dst)
            result = dst.execute("PRAGMA integrity_check").fetchone()[0]
            if result != "ok":
                raise RuntimeError(f"integrity check failed: {result}")
            tasks = dst.execute("SELECT COUNT(*) FROM tasks").fetchone()[0]
        finally:
            dst.close()
    finally:
        src.close()
    return tasks


def prune(directory: str, keep: int) -> int:
    backups = sorted(
        (entry for entry in os.listdir(directory) if entry.startswith("family-tasks-")),
        reverse=True,
    )
    removed = 0
    for stale in backups[keep:]:
        try:
            os.remove(os.path.join(directory, stale))
            removed += 1
        except OSError as exc:
            log(f"WARN could not remove {stale}: {exc}")
    return removed


def main() -> int:
    database, uploads = load_paths()
    if not os.path.exists(database):
        log(f"ERROR database not found: {database}")
        return 1

    os.makedirs(BACKUP_DIR, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")

    with tempfile.TemporaryDirectory() as tmp:
        raw = os.path.join(tmp, "family_tasks.db")
        tasks = snapshot_database(database, raw)

        target = os.path.join(BACKUP_DIR, f"family-tasks-{stamp}.db.gz")
        with open(raw, "rb") as src, gzip.open(target, "wb", compresslevel=6) as dst:
            shutil.copyfileobj(src, dst)
        os.chmod(target, 0o600)
        log(f"database backed up: {target} ({os.path.getsize(target)} bytes, {tasks} tasks)")

    # Photos live on disk, so the database alone is not a complete restore.
    if os.path.isdir(uploads) and os.listdir(uploads):
        photos_target = os.path.join(BACKUP_DIR, f"family-tasks-{stamp}-uploads.tar.gz")
        with tarfile.open(photos_target, "w:gz") as tar:
            tar.add(uploads, arcname="uploads")
        os.chmod(photos_target, 0o600)
        log(f"uploads backed up: {photos_target} ({os.path.getsize(photos_target)} bytes)")
    else:
        log("no uploads to back up")

    # Two files per run, so keep twice the day count.
    removed = prune(BACKUP_DIR, KEEP_DAYS * 2)
    if removed:
        log(f"pruned {removed} old backup file(s), keeping ~{KEEP_DAYS} days")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 - the timer should log a clear failure
        log(f"ERROR backup failed: {exc}")
        sys.exit(1)
