#!/usr/bin/env bash
# Weekly opencode maintenance: back up all chats, then attempt DB cleanup.
# Idempotent — safe to re-run. Designed for cron (no TTY assumed).
#
# Usage:
#   ./opencode-maintenance-cron.sh              # full run (backup + cleanup attempt)
#   ./opencode-maintenance-cron.sh --catch-up   # run only if last success is >7 days old (for @reboot)
#   ./opencode-maintenance-cron.sh --backup-only # skip the DB cleanup step
#   ./opencode-maintenance-cron.sh --verify-only # report status, change nothing
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_ROOT="$HOME/Documents/opencode-backups"
MARKER="$BACKUP_ROOT/.last-success"
LOG="$BACKUP_ROOT/maintenance.log"
LOCK="$BACKUP_ROOT/.maintenance.lock"
CATCH_UP_DAYS=7

MODE="full"
for arg in "$@"; do
  case "$arg" in
    --catch-up) MODE="catch-up" ;;
    --backup-only) MODE="backup-only" ;;
    --verify-only) MODE="verify-only" ;;
    -h|--help)
      echo "Usage: $0 [--catch-up] [--backup-only] [--verify-only]"
      exit 0 ;;
  esac
done

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG"; }

days_since_marker() {
  [ -f "$MARKER" ] || { echo 99999; return 0; }
  echo $(( ($(date +%s) - $(stat -c %Y "$MARKER")) / 86400 ))
}

verify() {
  echo "=== verify ==="
  echo "backup root: $BACKUP_ROOT"
  echo "chats backed up: $(find "$BACKUP_ROOT" -name '*.json' 2>/dev/null | wc -l)"
  if [ -f "$MARKER" ]; then
    echo "last success: $(stat -c %y "$MARKER" | cut -d. -f1) ($(days_since_marker) days ago)"
  else
    echo "last success: never"
  fi
  tail -n 5 "$LOG" 2>/dev/null || echo "(no log yet)"
  crontab -l 2>/dev/null | grep -F "opencode-maintenance-cron.sh" || echo "(no crontab entry)"
}

if [ "$MODE" = "verify-only" ]; then verify; exit 0; fi

if [ "$MODE" = "catch-up" ]; then
  if [ "$(days_since_marker)" -le "$CATCH_UP_DAYS" ]; then
    exit 0  # weekly run already covered it; nothing to catch up
  fi
fi

mkdir -p "$BACKUP_ROOT"
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "another maintenance run is in progress; exiting" >&2
  exit 0
fi

log "=== maintenance run ($MODE) ==="

log "step 1/2: backing up chats..."
if python3 "$SCRIPT_DIR/opencode-chat-backup.py" --force >>"$LOG" 2>&1; then
  log "chat backup OK"
else
  log "chat backup FAILED; skipping cleanup"
  exit 1
fi

if [ "$MODE" = "backup-only" ]; then
  date +%s > "$MARKER"
  log "backup-only done"
  exit 0
fi

log "step 2/2: attempting DB cleanup (applies only if OpenCode is closed)..."
set +e
python3 "$SCRIPT_DIR/opencode-db-maintain.py" --apply --force >>"$LOG" 2>&1
rc=$?
set -e
case $rc in
  0) log "DB cleanup applied" ;;
  3) log "DB cleanup skipped: OpenCode is running (will retry next run)" ;;
  *) log "DB cleanup FAILED with exit $rc" ;;
esac

date +%s > "$MARKER"
log "run finished"
