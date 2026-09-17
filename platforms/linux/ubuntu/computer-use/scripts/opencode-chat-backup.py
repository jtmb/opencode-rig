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
- The slug identifies the session. Repeat exports with the same title
  overwrite in place. A changed title creates another filename; the manifest
  records script-owned exports so successful replacements and deleted sessions
  can be pruned safely.

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
import tempfile
from urllib.request import pathname2url

DEFAULT_ROOT = os.path.expanduser("~/Documents/opencode-backups")
MANIFEST_NAME = ".opencode-chat-backup-manifest.json"


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


def readonly_uri(db_path: str) -> str:
    return f"file:{pathname2url(os.path.abspath(db_path))}?mode=ro"


def list_sessions(db_path: str) -> list[dict]:
    con = sqlite3.connect(readonly_uri(db_path), uri=True, timeout=30)
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
    parent = os.path.dirname(dest) or "."
    fd, tmp = tempfile.mkstemp(
        dir=parent, prefix=f"{os.path.basename(dest)}.", suffix=".tmp"
    )
    os.close(fd)
    try:
        with open(tmp, "w") as fh:
            proc = subprocess.run(
                ["opencode", "export", session_id],
                stdout=fh, stderr=subprocess.PIPE, text=True, timeout=300,
            )
        if proc.returncode != 0:
            raise RuntimeError(
                f"opencode export failed: {proc.stderr.strip()[-300:]}"
            )
        # Validate before accepting: must be JSON with the session id inside.
        with open(tmp) as fh:
            payload = json.load(fh)
        info = payload.get("info", {})
        if info.get("id") != session_id:
            raise RuntimeError("export payload session id mismatch")
        os.replace(tmp, dest)
    finally:
        try:
            os.remove(tmp)
        except FileNotFoundError:
            pass


def manifest_path(root: str) -> str:
    return os.path.join(root, MANIFEST_NAME)


def load_manifest(root: str) -> dict:
    path = manifest_path(root)
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {
        session_id: relative
        for session_id, relative in data.items()
        if isinstance(session_id, str) and isinstance(relative, str)
    }


def save_manifest(root: str, manifest: dict) -> None:
    path = manifest_path(root)
    fd, tmp = tempfile.mkstemp(
        dir=root, prefix=f"{MANIFEST_NAME}.", suffix=".tmp"
    )
    os.close(fd)
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, indent=2, sort_keys=True)
            fh.write("\n")
        os.replace(tmp, path)
    finally:
        try:
            os.remove(tmp)
        except FileNotFoundError:
            pass


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

    requested_db = (
        os.path.abspath(os.path.expanduser(args.db))
        if args.db
        else resolve_db(None)
    )
    live_db = resolve_db(None)
    # `opencode export` reads OpenCode's active store. An alternate database
    # can be inventoried here but cannot be exported by that command.
    if requested_db != live_db:
        print(
            "error: --db inventory does not match OpenCode's active database; "
            "alternate-store export is unsupported",
            file=sys.stderr,
        )
        return 2
    db_path = requested_db
    if not os.path.isfile(db_path):
        print(f"error: database not found: {db_path}", file=sys.stderr)
        return 2
    root = os.path.abspath(os.path.expanduser(args.root))

    sessions = list_sessions(db_path)
    if not sessions:
        print("no sessions found; nothing to back up.")
        return 0

    planned = []
    repo_labels = {}
    for s in sessions:
        directory = s.get("directory", "")
        if directory not in repo_labels:
            repo_labels[directory] = repo_name(directory)
        repo = repo_labels[directory]
        fname = f"{s.get('slug') or s['id']}__{sanitize(s.get('title', ''))}.json"
        planned.append((s, os.path.join(root, repo, fname)))

    print(f"sessions: {len(sessions)}  root: {root}")
    for s, dest in planned:
        print(f"  [{repo_labels[s.get('directory', '')]}] "
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
    previous_manifest = load_manifest(root)
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

    if failed:
        print(f"done: {ok} exported, {len(failed)} failed.")
        print("pruning and manifest update skipped because one or more exports failed.")
        return 1

    manifest = {
        s["id"]: os.path.relpath(dest, root)
        for s, dest in planned
    }
    save_manifest(root, manifest)

    if args.prune_deleted:
        live_ids = {s["id"] for s, _ in planned}
        pruned = 0
        for session_id, relative in previous_manifest.items():
            if session_id in live_ids:
                continue
            full = os.path.join(root, relative)
            if os.path.isfile(full):
                print(f"  pruning deleted-session backup {full}")
                os.remove(full)
                pruned += 1
        for s, dest in planned:
            previous = previous_manifest.get(s["id"])
            if previous:
                old_full = os.path.join(root, previous)
                if old_full != dest and os.path.isfile(old_full):
                    print(f"  pruning renamed backup {old_full}")
                    os.remove(old_full)
                    pruned += 1
        print(f"pruned {pruned} stale backup(s).")

    print(f"done: {ok} exported, {len(failed)} failed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
