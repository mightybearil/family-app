#!/usr/bin/env bash
#
# The 10:00 good-morning message in the WhatsApp group.
#
# Deliberately does not list the tasks. A wall of chores first thing reads as
# nagging; a short warm note that says there is something waiting, and offers
# the detail on request, does the same job without setting that tone. The bot
# already knows how to elaborate if either of them asks.
#
# Two messages, chosen by whether anything is actually open — the greeting
# states a fact about their week, so it has to match reality. If the count
# cannot be read at all, say nothing: that is an error, not a clear week, and
# guessing either way would put a false claim in the group.
#
# Runs from family-briefing.timer at 10:00 Israel time.

set -uo pipefail

CONTAINER=nanobot-gateway
BRIDGE=/home/nanobot/.nanobot/workspace/bin/family_tasks.py
TRIGGER_ID="${FAMILY_TRIGGER_ID:-trg_FZRP8G5Q}"

if ! docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
  exit 0
fi

OPEN="$(docker exec "$CONTAINER" python3 "$BRIDGE" count 2>/dev/null | tr -dc '0-9')"
[ -z "$OPEN" ] && exit 0

if [ "$OPEN" -eq 0 ]; then
  read -r -d '' BODY <<'EOF' || true
בוקר טוב ליעל ואמיר,
אין איזה משהו ממש חשוב לעשות אז... תרקדו 💃🏻
שיהיה יום נהדר
EOF
else
  read -r -d '' BODY <<'EOF' || true
בוקר טוב ליעל ואמיר,
יש כמה דברים שצריך להספיק השבוע. אם תרצו שאפרט תשאלו או כנסו לאפליקציה :)
שיהיה יום מקסים
EOF
fi

read -r -d '' PROMPT <<EOF || true
שלח לקבוצה עכשיו את ההודעה הבאה בדיוק כפי שהיא, מילה במילה, כולל שורות חדשות.
אל תוסיף כותרת, רשימת משימות, מספרים, אמוג'ים נוספים או כל טקסט משלך.

${BODY}
EOF

docker exec "$CONTAINER" nanobot trigger "$TRIGGER_ID" "$PROMPT" >/dev/null 2>&1
exit 0
