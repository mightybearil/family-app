#!/usr/bin/env python3
"""
Bridge between the nanobot agent and the Family Tasks database.

The agent runs inside a container, so it cannot reach the storage service on
the host's 127.0.0.1:8901. It calls the public HTTPS endpoint instead, which it
can already reach (it talks to the model provider the same way).

The API token is read from a file beside this script rather than passed as an
argument, so it never appears in the agent's prompt, its tool-call arguments, or
the session transcripts those get written to.

Deliberately offers no delete. An LLM misreading a Hebrew message is a poor way
to lose data, and deleting in the app is one tap with an undo. Everything here
is additive or a status change, so the worst case is a stray task rather than a
missing one.

Usage
    family_tasks.py list [--category CATEGORY] [--status STATUS] [--mine MEMBER]
    family_tasks.py add TITLE [--category C] [--assignee M] [--priority P]
                              [--due YYYY-MM-DD] [--quantity N] [--note TEXT]
    family_tasks.py done QUERY          # id, or enough of the title to be unique
    family_tasks.py reopen QUERY
    family_tasks.py comment QUERY TEXT
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

API_URL = os.environ.get("FAMILY_API_URL", "https://family-tasks.duckdns.org/api")
TOKEN_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "api-token")
TIMEOUT = 25

CATEGORIES = ("house", "shopping", "general", "projects", "events")
PRIORITIES = ("low", "medium", "high", "urgent")

# The agent thinks in names, the database stores ids.
MEMBER_ALIASES = {
    "אמיר": "member1", "amir": "member1", "member1": "member1",
    "יעל": "member2", "yael": "member2", "member2": "member2",
}

CATEGORY_ALIASES = {
    "בית": "house", "משימות בית": "house", "house": "house",
    "קניות": "shopping", "סופר": "shopping", "shopping": "shopping",
    "כללי": "general", "general": "general",
    "פרויקטים": "projects", "פרויקט": "projects", "projects": "projects",
    "אירועים": "events", "אירוע": "events", "events": "events",
}


def fail(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def read_token() -> str:
    try:
        with open(TOKEN_FILE, encoding="utf-8") as fh:
            token = fh.read().strip()
    except OSError as exc:
        fail(f"cannot read the API token ({exc}). Ask Amir to reinstall the bridge.")
    if not token:
        fail("the API token file is empty")
    return token


def call(payload: dict) -> dict:
    request = urllib.request.Request(
        API_URL,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "Authorization": f"Bearer {read_token()}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        fail(f"the task server rejected the request (HTTP {exc.code})")
    except Exception as exc:  # noqa: BLE001 - surfaced to the agent as plain text
        fail(f"could not reach the task server: {exc}")

    if not body.get("success"):
        fail(body.get("error") or "the task server reported a failure")
    return body.get("data") or {}


def describe(task: dict) -> str:
    bits = [f"[{task['id'][:8]}]", task.get("title") or "(ללא כותרת)"]
    if task.get("category"):
        bits.append(f"({task['category']})")
    if task.get("status") == "completed":
        bits.append("✓ הושלם")
    if task.get("due_date"):
        bits.append(f"יעד {task['due_date']}")
    if (task.get("quantity") or 1) > 1:
        bits.append(f"x{task['quantity']}")
    if task.get("assignee"):
        bits.append(f"-> {task['assignee']}")
    return " ".join(bits)


def find_task(query: str) -> dict:
    """Accepts a task id, an id prefix, or enough of the title to be unique."""
    tasks = call({"action": "get_tasks", "filters": {}}).get("tasks", [])
    needle = query.strip().lower()

    exact = [t for t in tasks if t["id"].lower() == needle or t["id"].lower().startswith(needle)]
    if len(exact) == 1:
        return exact[0]

    matches = [t for t in tasks if needle in (t.get("title") or "").lower()]
    if not matches:
        fail(f"no task matches {query!r}")
    if len(matches) > 1:
        listing = "; ".join(describe(t) for t in matches[:5])
        fail(f"{query!r} matches {len(matches)} tasks — be more specific: {listing}")
    return matches[0]


def cmd_list(args) -> None:
    filters = {}
    if args.category:
        filters["category"] = CATEGORY_ALIASES.get(args.category.lower(), args.category)
    if args.status:
        filters["status"] = args.status
    if args.mine:
        filters["assignee"] = MEMBER_ALIASES.get(args.mine.lower(), args.mine)

    tasks = call({"action": "get_tasks", "filters": filters}).get("tasks", [])
    open_tasks = [t for t in tasks if t.get("status") != "completed"]

    if not open_tasks:
        print("אין משימות פתוחות.")
        return
    print(f"{len(open_tasks)} משימות פתוחות:")
    for task in open_tasks:
        print(f"  {describe(task)}")


def cmd_add(args) -> None:
    category = CATEGORY_ALIASES.get((args.category or "general").lower(), args.category or "general")
    if category not in CATEGORIES:
        fail(f"unknown category {args.category!r}; use one of: {', '.join(CATEGORIES)}")

    priority = (args.priority or "medium").lower()
    if priority not in PRIORITIES:
        fail(f"unknown priority {args.priority!r}; use one of: {', '.join(PRIORITIES)}")

    task = {
        "title": args.title.strip(),
        "category": category,
        "priority": priority,
        "status": "pending",
        "description": args.note or "",
        "quantity": max(1, args.quantity or 1),
    }
    if args.assignee:
        member = MEMBER_ALIASES.get(args.assignee.lower())
        if not member:
            fail(f"unknown person {args.assignee!r}; use אמיר or יעל")
        task["assignee"] = member
        task["created_by"] = member
    if args.due:
        task["due_date"] = args.due

    created = call({"action": "create_task", "task": task}).get("task", {})
    print(f"נוספה משימה: {describe(created)}")


def cmd_done(args) -> None:
    task = find_task(args.query)
    if task.get("status") == "completed":
        print(f"כבר מסומנת כהושלמה: {describe(task)}")
        return
    updated = call({
        "action": "update_task", "taskId": task["id"], "changes": {"status": "completed"}
    }).get("task", {})
    print(f"סומנה כהושלמה: {describe(updated)}")


def cmd_reopen(args) -> None:
    task = find_task(args.query)
    updated = call({
        "action": "update_task", "taskId": task["id"],
        "changes": {"status": "pending", "progress": 0}
    }).get("task", {})
    print(f"הוחזרה לפתוחה: {describe(updated)}")


def cmd_comment(args) -> None:
    task = find_task(args.query)
    call({"action": "add_comment", "comment": {
        "task_id": task["id"], "content": args.text, "author": "nanobot",
    }})
    print(f"נוספה הערה למשימה: {describe(task)}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Family Tasks bridge for the nanobot agent")
    sub = parser.add_subparsers(dest="command", required=True)

    p_list = sub.add_parser("list", help="list open tasks")
    p_list.add_argument("--category")
    p_list.add_argument("--status")
    p_list.add_argument("--mine", help="filter to one person")
    p_list.set_defaults(func=cmd_list)

    p_add = sub.add_parser("add", help="create a task")
    p_add.add_argument("title")
    p_add.add_argument("--category")
    p_add.add_argument("--assignee")
    p_add.add_argument("--priority")
    p_add.add_argument("--due", help="YYYY-MM-DD")
    p_add.add_argument("--quantity", type=int)
    p_add.add_argument("--note")
    p_add.set_defaults(func=cmd_add)

    p_done = sub.add_parser("done", help="mark a task completed")
    p_done.add_argument("query")
    p_done.set_defaults(func=cmd_done)

    p_reopen = sub.add_parser("reopen", help="reopen a completed task")
    p_reopen.add_argument("query")
    p_reopen.set_defaults(func=cmd_reopen)

    p_comment = sub.add_parser("comment", help="add a comment to a task")
    p_comment.add_argument("query")
    p_comment.add_argument("text")
    p_comment.set_defaults(func=cmd_comment)

    return parser


if __name__ == "__main__":
    parsed = build_parser().parse_args()
    parsed.func(parsed)
