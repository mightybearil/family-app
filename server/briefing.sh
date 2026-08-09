#!/usr/bin/env bash
#
# The 10:00 good-morning nudge in the WhatsApp group.
#
# Deliberately does not list the tasks. A wall of chores first thing reads as
# nagging; a short warm note that says there is something waiting, and offers
# the detail on request, does the same job without setting that tone. The bot
# already knows how to elaborate if either of them asks.
#
# The greeting says there are things to get through this week, so it is only
# sent when that is actually true — otherwise the message would be a small lie
# on a morning when everything is already done.
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

# No number back means the bridge or the API is unhappy; stay quiet rather than
# greeting them with a claim that might be wrong.
[ -z "$OPEN" ] && exit 0
[ "$OPEN" -eq 0 ] && exit 0

read -r -d '' PROMPT <<'EOF' || true
שלח לקבוצה עכשיו את ההודעה הבאה בדיוק כפי שהיא, מילה במילה, כולל שורות חדשות.
אל תוסיף כותרת, רשימת משימות, מספרים, אמוג'ים נוספים או כל טקסט משלך.

בוקר טוב ליעל ואמיר,
יש כמה דברים שצריך להספיק השבוע. אם תרצו שאפרט תשאלו או כנסו לאפליקציה :)
שיהיה יום מקסים
EOF

docker exec "$CONTAINER" nanobot trigger "$TRIGGER_ID" "$PROMPT" >/dev/null 2>&1
exit 0
