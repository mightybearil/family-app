#!/usr/bin/env bash
#
# Posts the morning briefing to the WhatsApp group at 10:00 Israel time.
#
# The facts are assembled deterministically by the bridge, so the agent cannot
# invent a task or misremember a date; its job is to relay those lines and add
# a couple of short, practical suggestions. That split matters — a made-up
# suggestion is harmless, a made-up task is not.
#
# Runs from family-briefing.timer.

set -uo pipefail

CONTAINER=nanobot-gateway
BRIDGE=/home/nanobot/.nanobot/workspace/bin/family_tasks.py
TRIGGER_ID="${FAMILY_TRIGGER_ID:-trg_FZRP8G5Q}"

if ! docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
  exit 0
fi

BRIEF="$(docker exec "$CONTAINER" python3 "$BRIDGE" briefing --days 7 2>/dev/null)"

if [ -z "${BRIEF//[$'\t\r\n ']/}" ]; then
  exit 0
fi

read -r -d '' PROMPT <<EOF || true
זה הסיכום היומי. שלח אותו לקבוצה בהודעה אחת.

פתח ב"בוקר טוב" קצר, ואז העתק את השורות הבאות בדיוק כפי שהן — בלי לשנות שמות,
תאריכים או ניסוח, ובלי להוסיף משימות שלא מופיעות כאן:

${BRIEF}

בסוף ההודעה הוסף 2-3 הצעות קצרות ומעשיות איך אפשר להתקדם עם המשימות האלה —
למשל לחלק משימה גדולה לצעד ראשון קטן, לאחד כמה מטלות לאותה יציאה מהבית, או
להציע לקבוע תאריך למשימה שאין לה. הצעות בלבד, משפט אחד כל אחת, בלי לשנות דבר
במשימות עצמן.
EOF

docker exec "$CONTAINER" nanobot trigger "$TRIGGER_ID" "$PROMPT" >/dev/null 2>&1
exit 0
