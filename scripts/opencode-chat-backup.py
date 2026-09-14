#!/usr/bin/env python3
"""opencode-chat-backup: export every opencode chat to JSON files.

Backs up all current chats (sessions) from OpenCode's SQLite store using
`opencode export <sessionID>` (full fidelity, re-importable via
`opencode import`). Read-only against the database — safe to run anytime,
including while OpenCode is open and from cron.

Layout:
  <backup-root>/<repo>/<slug>__<sanitized-title>.json

- <repo> is the git remote name when the session directory is a checkout,
  else the directory basename (e.g. sessions in /home/james land in `james/`).
- The filename is stable per session (slug is unique), so repeat runs
  overwrite in place instead of accumulating duplicates.

Usage:
  python3 opencode-chat-backup.py --dry-run
  python3 opencode-chat-backup.py
  python3 opencode-chat-backup.py --root ~/Documents/opencode-backups
  python3 opencode-chat-backup.py --prune-deleted   # remove JSONs whose session is gone
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import subprocess
import sys

DEFAULT_ROOT = os.path.expanduser("~/Documents/opencode-backups")


def resolve_db(explicit: str | None) -> str:
    if explicit:
        return os.path.abspath(os.path.expanduser(explicit))
    env = os.environ.get("OPENCODE_DB")
    if env:
        return os.path.abspath(os.path.expanduser(env))
    xdg = os.environ.get("XDG_DATA_HOME", os.path.expanduser("~/.local/share"))
    candidates = [
        os.path.join(xdg, "opencode", "opencode.db"),
        os.path.expanduser("~/.local/share/opencode/opencode.db"),
    ]
    existing = [(p, os.path.getsize(p)) for p in candidates if os.path.isfile(p)]
    if not existing:
        return candidates[1]
    existing.sort(key=lambda t: t[1], reverse=True)
    return existing[0][0]


def sanitize(name: str, limit: int = 60) -> str:
    name = (name or "untitled").strip().lower()
    name = re.sub(r"[^a-z0-9]+", "-", name).strip("-")
    return (name or "untitled")[:limit].rstrip("-") or "untitled"


def repo_name(directory: str) -> str:
    """Best-effort repo label for a session directory.

    Prefers the git origin remote name when the directory is a checkout,
    else falls back to the directory basename.
    """
    if directory and os.path.isdir(os.path.join(directory, ".git")):
        try:
            proc = subprocess.run(
                ["git", "-C", directory, "remote", "get-url", "origin"],
                capture_output=True, text=True, timeout=10,
            )
            url = (proc.stdout or "").strip().rstrip("/")
            if url:
                if url.endswith(".git"):
                    url = url[:-4]
                base = url.rsplit("/", 1)[-1].rsplit(":", 1)[-1]
                if base:
                    return sanitize(base)
        except (OSError, subprocess.SubprocessError):
            pass
    if directory:
        base = os.path.basename(os.path.normpath(directory))
        if base:
            return sanitize(base)
    return "global"


def list_sessions(db_path: str) -> list[dict]:
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=30)
    try:
        cols = [d[1] for d in con.execute('PRAGMA table_info("session")')]
        want = [c for c in ("id", "slug", "title", "directory", "time_updated")
                if c in cols]
        rows = con.execute(
            f'SELECT {", ".join(want)} FROM session ORDER BY time_updated DESC'
        ).fetchall()
        return [dict(zip(want, r)) for r in rows]
    finally:
        con.close()


def export_session(session_id: str, dest: str) -> None:
    tmp = dest + ".tmp"
    with open(tmp, "w") as fh:
        proc = subprocess.run(
            ["opencode", "export", session_id],
            stdout=fh, stderr=subprocess.PIPE, text=True, timeout=300,
        )
    if proc.returncode != 0:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise RuntimeError(f"opencode export failed: {proc.stderr.strip()[-300:]}")
    # Validate before accepting: must be JSON with the session id inside.
    with open(tmp) as fh:
        payload = json.load(fh)
    info = payload.get("info", {})
    if info.get("id") != session_id:
        os.remove(tmp)
        raise RuntimeError("export payload session id mismatch")
    os.replace(tmp, dest)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--db", default=None, help="path to opencode.db")
    ap.add_argument("--root", default=DEFAULT_ROOT, help="backup root directory")
    ap.add_argument("--dry-run", action="store_true",
                    help="report what would be exported without writing")
    ap.add_argument("--prune-deleted", action="store_true",
                    help="remove JSON backups whose session no longer exists")
    ap.add_argument("--force", action="store_true",
                    help="skip confirmation prompt")
    args = ap.parse_args(argv or sys.argv[1:])

    db_path = resolve_db(args.db)
    if not os.path.isfile(db_path):
        print(f"error: database not found: {db_path}", file=sys.stderr)
        return 2
    root = os.path.abspath(os.path.expanduser(args.root))

    sessions = list_sessions(db_path)
    if not sessions:
        print("no sessions found; nothing to back up.")
        return 0

    planned = []
    for s in sessions:
        repo = repo_name(s.get("directory", ""))
        fname = f"{s.get('slug', s['id'])}__{sanitize(s.get('title', ''))}.json"
        planned.append((s, os.path.join(root, repo, fname)))

    print(f"sessions: {len(sessions)}  root: {root}")
    for s, dest in planned:
        print(f"  [{repo_name(s.get('directory', ''))}] "
              f"{s['id']}  {s.get('title', '')[:50]!r} -> {dest}")

    if args.dry_run:
        print("dry-run: no changes made.")
        return 0

    if not args.force and sys.stdin.isatty() and len(sessions) > 20:
        answer = input(f"Export {len(sessions)} chats to {root}? [y/N] ").strip().lower()
        if answer not in ("y", "yes"):
            print("aborted.")
            return 0

    os.makedirs(root, exist_ok=True)
    ok, failed = 0, []
    for s, dest in planned:
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        try:
            export_session(s["id"], dest)
            ok += 1
            print(f"  wrote {dest}")
        except Exception as exc:  # noqa: BLE001
            failed.append((s["id"], str(exc)))
            print(f"  FAILED {s['id']}: {exc}", file=sys.stderr)

    if args.prune_deleted:
        live = {os.path.basename(d) for _, d in planned}
        pruned = 0
        for dirpath, _, filenames in os.walk(root):
            for fn in filenames:
                if fn.endswith(".json") and fn not in live:
                    full = os.path.join(dirpath, fn)
                    print(f"  pruning stale backup {full}")
                    os.remove(full)
                    pruned += 1
        print(f"pruned {pruned} stale backup(s).")

    print(f"done: {ok} exported, {len(failed)} failed.")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
