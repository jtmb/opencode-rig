#!/usr/bin/env bash
# Weekly opencode maintenance: back up all chats, then attempt DB cleanup.
# Idempotent — safe to re-run. Designed for cron (no TTY assumed).
#
# Usage:
#   ./opencode-maintenance-cron.sh                 # full run (backup + cleanup attempt)
#   ./opencode-maintenance-cron.sh --backup-only    # skip the DB cleanup step
#   ./opencode-maintenance-cron.sh --catch-up       # run full maintenance only if cleanup is >7 days old
#   ./opencode-maintenance-cron.sh --backup-only --catch-up  # catch-up backup only
#   ./opencode-maintenance-cron.sh --verify-only    # report status, change nothing
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_ROOT="$HOME/Documents/opencode-backups"
BACKUP_MARKER="$BACKUP_ROOT/.last-backup"
CLEANUP_MARKER="$BACKUP_ROOT/.last-cleanup"
LEGACY_MARKER="$BACKUP_ROOT/.last-success"
LOG="$BACKUP_ROOT/maintenance.log"
LOCK="$BACKUP_ROOT/.maintenance.lock"
CATCH_UP_DAYS=7

MODE="full"
CATCH_UP=0
for arg in "$@"; do
  case "$arg" in
    --catch-up) CATCH_UP=1 ;;
    --backup-only)
      if [ "$MODE" != "full" ]; then
        echo "Usage: $0 [--backup-only] [--catch-up] [--verify-only]" >&2
        exit 2
      fi
      MODE="backup-only" ;;
    --verify-only)
      if [ "$MODE" != "full" ] || [ "$CATCH_UP" -eq 1 ]; then
        echo "Usage: $0 [--backup-only] [--catch-up] [--verify-only]" >&2
        exit 2
      fi
      MODE="verify-only" ;;
    -h|--help)
      echo "Usage: $0 [--backup-only] [--catch-up] [--verify-only]"
      exit 0 ;;
    *)
      echo "Usage: $0 [--backup-only] [--catch-up] [--verify-only]" >&2
      exit 2 ;;
  esac
done
if [ "$MODE" = "verify-only" ] && [ "$CATCH_UP" -eq 1 ]; then
  echo "Usage: $0 [--backup-only] [--catch-up] [--verify-only]" >&2
  exit 2
fi

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG"; }

days_since_marker() {
  local marker="$1"
  [ -f "$marker" ] || { echo 99999; return 0; }
  echo $(( ($(date +%s) - $(stat -c %Y "$marker")) / 86400 ))
}

marker_status() {
  local label="$1"
  local marker="$2"
  if [ -f "$marker" ]; then
    echo "$label: $(stat -c %y "$marker" | cut -d. -f1) ($(days_since_marker "$marker") days ago)"
  else
    echo "$label: never"
  fi
}

verify() {
  echo "=== verify ==="
  echo "backup root: $BACKUP_ROOT"
  echo "chats backed up: $(find "$BACKUP_ROOT" -name '*.json' 2>/dev/null | wc -l)"
  marker_status "last backup" "$BACKUP_MARKER"
  marker_status "last cleanup" "$CLEANUP_MARKER"
  if [ -f "$LEGACY_MARKER" ]; then
    echo "legacy success marker is present but ignored: $LEGACY_MARKER"
  fi
  tail -n 5 "$LOG" 2>/dev/null || echo "(no log yet)"
  crontab -l 2>/dev/null | grep -F "opencode-maintenance-cron.sh" || echo "(no crontab entry)"
}

if [ "$MODE" = "verify-only" ]; then verify; exit 0; fi

if [ "$CATCH_UP" -eq 1 ] && [ "$(days_since_marker "$CLEANUP_MARKER")" -le "$CATCH_UP_DAYS" ]; then
  exit 0  # weekly run already covered it; nothing to catch up
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
date +%s > "$BACKUP_MARKER"

if [ "$MODE" = "backup-only" ]; then
  log "backup-only done"
  exit 0
fi

log "step 2/2: attempting DB cleanup (applies only if OpenCode is closed)..."
set +e
python3 "$SCRIPT_DIR/opencode-db-maintain.py" --apply --force >>"$LOG" 2>&1
rc=$?
set -e
case $rc in
  0)
    date +%s > "$CLEANUP_MARKER"
    log "DB cleanup applied"
    log "run finished" ;;
  3)
    log "DB cleanup skipped: OpenCode is running (will retry next run)" ;;
  *)
    log "DB cleanup FAILED with exit $rc"
    exit "$rc" ;;
esac
