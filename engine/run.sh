#!/usr/bin/env bash
# Runs Claude Code on UnderScope for up to 5 hours, then stops.
# It also stops early if: all milestones are done, your Pro usage limit is reached,
# or the agent stops making progress. Press Ctrl+C to stop at any time.
#
#   ./run.sh                 # 5 hours
#   MINUTES=10 ./run.sh      # quick test
set -u
cd "$(dirname "$0")"

MINUTES="${MINUTES:-300}"
END=$(( $(date +%s) + MINUTES * 60 ))
LOGDIR=".agent-logs"
mkdir -p "$LOGDIR"

# Work on a fresh branch so main is never touched. Uncommitted changes come along.
BRANCH="agent/$(date +%Y-%m-%d-%H%M%S)"
git switch -c "$BRANCH" || { echo "Could not create branch $BRANCH"; exit 1; }
echo "Working on branch $BRANCH for up to $MINUTES minutes. Logs in $LOGDIR/"

# Mac has no 'timeout' command, so do it by hand.
run_with_limit() {
  local secs=$1; shift
  "$@" &
  local pid=$!
  ( sleep "$secs" && kill -TERM "$pid" 2>/dev/null ) &
  local watcher=$!
  wait "$pid"; local rc=$?
  kill "$watcher" 2>/dev/null; wait "$watcher" 2>/dev/null
  return $rc
}

n=0
stalls=0
while [ "$(date +%s)" -lt "$END" ]; do
  if grep -q "^STATUS: DONE" PROGRESS.md 2>/dev/null; then
    echo "All milestones done."; break
  fi
  n=$((n + 1))
  log="$LOGDIR/session-$n.jsonl"
  left=$(( END - $(date +%s) ))
  before=$(git rev-parse HEAD)
  started=$(date +%s)

  echo "[$(date +%H:%M)] session $n starting"
  run_with_limit "$left" claude -p "Read TASK.md and follow it." \
    --permission-mode auto \
    --model sonnet \
    --output-format stream-json --verbose \
    > "$log" 2>&1
  lasted=$(( $(date +%s) - started ))
  echo "[$(date +%H:%M)] session $n ended after $((lasted / 60)) min"

  if tail -n 5 "$log" | grep -qiE 'usage limit|limit reached|hit your limit'; then
    echo "Your Pro usage limit was reached. Stopping; all committed work is saved."; break
  fi

  # Guard against burning time and usage when something is broken.
  if [ "$(git rev-parse HEAD)" = "$before" ]; then
    stalls=$((stalls + 1))
    if [ "$lasted" -lt 60 ] || [ "$stalls" -ge 2 ]; then
      echo "The agent isn't making progress. Last lines of $log:"
      tail -n 5 "$log" | cut -c1-400
      break
    fi
  else
    stalls=0
  fi
  sleep 5
done

echo "Done. Review with: git log --oneline main..$BRANCH   and read PROGRESS.md"
