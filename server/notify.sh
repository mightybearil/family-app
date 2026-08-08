#!/usr/bin/env bash
#
# Posts new family-task activity to the WhatsApp notification group.
#
# The agent is only woken when there is genuinely something to say. An earlier
# version had nanobot poll on a schedule and decide for itself whether to stay
# quiet — it kept announcing "אין עדכונים חדשים", because asking a language
# model to reliably output nothing is not something you can enforce.
#
# Here the decision is made before the agent is involved at all: this script
# checks for news, and simply exits when there is none. No turn, no message,
# no tokens. That also makes a one-minute interval affordable, so updates
# arrive promptly instead of on a slow poll.

set -uo pipefail

CONTAINER=nanobot-gateway
BRIDGE=/home/nanobot/.nanobot/workspace/bin/family_tasks.py
TRIGGER_ID="${FAMILY_TRIGGER_ID:-trg_FZRP8G5Q}"

# Nothing to do if the agent is not running.
if ! docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
  exit 0
fi

NEWS="$(docker exec "$CONTAINER" python3 "$BRIDGE" news 2>/dev/null)"

# The common case: no news, so stay completely silent.
if [ -z "${NEWS//[$'\t\r\n ']/}" ]; then
  exit 0
fi

# The lines are already written ready to send. The agent's only job is to pass
# them through, so a comment reaches the group worded exactly as it was typed.
read -r -d '' PROMPT <<EOF || true
עדכונים חדשים מהאפליקציה. שלח אותם לקבוצה כמו שהם, שורה אחת לכל עדכון.
אל תנסח מחדש, אל תתרגם, אל תקצר ואל תוסיף שום מילה משלך.

${NEWS}
EOF

docker exec "$CONTAINER" nanobot trigger "$TRIGGER_ID" "$PROMPT" >/dev/null 2>&1
exit 0
