---
name: family-tasks
description: Read and write the family's shared task and shopping list (משימות משפחתיות). Use whenever Amir or Yael mentions adding, finishing, or checking a task, chore, errand, or shopping item.
---

# Family Tasks (משימות משפחתיות)

Amir and Yael share a task app. Its data lives in a real database that both of
their phones read from, so anything written here shows up on both devices
immediately. **Never answer from memory** — always run the tool. Your own
recollection of an earlier conversation is not the task list.

## The tool

```
python3 /home/nanobot/.nanobot/workspace/bin/family_tasks.py <command>
```

Run it with `exec`. It prints plain text; relay the result in Hebrew, briefly.

| Command | Purpose |
| :--- | :--- |
| `list` | Open tasks. Options: `--category`, `--mine אמיר`, `--status` |
| `add "TITLE"` | Create a task. Options: `--category`, `--assignee`, `--priority`, `--due YYYY-MM-DD`, `--quantity N`, `--note` |
| `done QUERY` | Mark completed. QUERY is a task id or enough of the title to be unique |
| `reopen QUERY` | Reopen a completed task |
| `comment QUERY "TEXT"` | Attach a note to a task |

Categories: `house` (בית), `shopping` (קניות), `general` (כללי),
`projects` (פרויקטים), `events` (אירועים).
Priorities: `low`, `medium`, `high`, `urgent`. People: `אמיר`, `יעל`.

## When to use it

- "תוסיף משימה להתקין את המחשב של עוזי" → `add "להתקין את המחשב של עוזי" --category house`
- "תוסיף חלב לקניות" → `add "חלב" --category shopping`
- "תוסיף 3 בקבוקי יין" → `add "בקבוקי יין" --category shopping --quantity 3`
- "מה נשאר לי לעשות?" → `list --mine <whoever is asking>`
- "מה יש בקניות?" → `list --category shopping`
- "סיימתי את הכביסה" → `done "כביסה"`
- "תזכיר לי לשלם ארנונה עד ראשון" → `add "לשלם ארנונה" --due YYYY-MM-DD`

## Rules

**There is no delete, on purpose.** If asked to delete, say it can be removed in
the app with one tap (and undone), or offer to mark it completed instead. Do not
try to work around this.

**Pick the category from meaning, not keywords.** Anything bought in a shop is
`shopping`; chores at home are `house`; appointments and dates are `events`.
When genuinely unsure, use `general` rather than asking.

**Quote the title exactly as they said it**, in Hebrew, without embellishing.
"תוסיף חלב" creates "חלב", not "לקנות חלב מהסופר".

**If a `done` query matches several tasks**, the tool says so and lists them —
show those options and ask which one, rather than guessing.

**Only Amir and Yael may change the list.** If anyone else asks, decline
politely; this is their private household data.

## Reporting back

Keep it short and natural, in Hebrew. After adding: confirm what was added and
where ("הוספתי 'חלב' לרשימת הקניות ✅"). After listing: summarise rather than
dumping ids — the ids matter to you, not to them. If the tool prints an ERROR,
say plainly that it did not work; never claim success you did not see.
