#!/usr/bin/env python3
"""opencode-db-maintain: safe maintenance for OpenCode's SQLite store.

Addresses the known unbounded-growth issue from multiple upstream reports:
  - freelist bloat: auto_vacuum=OFF so deleted rows never return disk space
    (#16777, #16729, #31526; fix PRs #16730/#31528).
  - live event-log bloat: `event` table keeps a full snapshot per
    `message.updated.1` / `message.part.updated.1` streaming update forever,
    amplified by full `summary.diffs` patch text (#33356 13GB, #41175 39GB,
    #32005, #42748, #46138). VACUUM alone cannot help there because
    freelist is ~0%% -- superseded rows must be deleted first, then VACUUM.

What this script does (stdlib only, no deps):
  stats (default, read-only) : PRAGMA health + per-table / per-event-type sizes
  prune --dry-run (default)  : report orphaned + superseded event rows
  prune --apply              : backup -> batched delete -> VACUUM -> harden
                               (auto_vacuum=INCREMENTAL, journal_mode=WAL)

Safety (borrowed from ocdbc / opencode-db-prune practice):
  - read-only by default; writes require --apply
  - refuses --apply while another process holds the DB (fuser//proc scan)
    unless --skip-lock-check is passed explicitly
  - WAL checkpoint before backup so the backup holds committed data
  - PRAGMA integrity_check before AND after; backup integrity verified
  - projection check: never delete the newest snapshot per message/part,
    never touch aggregates with a sync/workspace owner, never touch the
    newest --keep sessions; skips rows whose message/part is missing from
    the projection tables (message/part) instead of guessing
  - batched deletes (default 2000) so 50GB+ DBs don't overflow the journal
  - deletes from `event` only; `event_sequence` numbering is left intact

Usage:
  python3 opencode-db-maintain.py --stats
  python3 opencode-db-maintain.py --dry-run
  python3 opencode-db-maintain.py --apply
  python3 opencode-db-maintain.py --apply --keep 20 --batch 5000
  python3 opencode-db-maintain.py --apply --vacuum-only   # no row deletes
  python3 opencode-db-maintain.py --apply --no-backup     # not recommended

For periodic prevention on a new build, run --apply from cron/systemd
(e.g. weekly) instead of daemon mode.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from urllib.request import pathname2url

VERSION = "1.0.0"

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def fmt_bytes(n) -> str:
    if n is None:
        return "0 B"
    n = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.2f} {unit}" if unit != "B" else f"{int(n)} B"
        n /= 1024


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
        os.path.expanduser("~/Library/Application Support/opencode/opencode.db"),
    ]
    existing = [(p, os.path.getsize(p)) for p in candidates if os.path.isfile(p)]
    if not existing:
        return candidates[1]
    existing.sort(key=lambda t: t[1], reverse=True)
    return existing[0][0]


def table_exists(con: sqlite3.Connection, name: str) -> bool:
    row = con.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone()
    return row is not None


def readonly_uri(db_path: str) -> str:
    return f"file:{pathname2url(os.path.abspath(db_path))}?mode=ro"


def integrity_ok(db_path: str) -> tuple[bool, str]:
    try:
        con = sqlite3.connect(readonly_uri(db_path), uri=True, timeout=30)
        try:
            row = con.execute("PRAGMA integrity_check").fetchone()
            ok = row is not None and str(row[0]).lower() == "ok"
            return ok, str(row[0]) if row else "empty"
        finally:
            con.close()
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)


def db_holder(db_path: str) -> str | None:
    """Return a description of a process holding the DB, or None.

    Prefers `fuser` when available, else scans /proc cmdlines for opencode.
    Checks the exact path being modified so copies in /tmp don't inherit
    the live DB's lock status.
    """
    db = os.path.abspath(db_path)
    fuser = shutil.which("fuser")
    if fuser:
        import subprocess  # stdlib, local-only use

        try:
            proc = subprocess.run(
                [fuser, db], capture_output=True, text=True, timeout=10
            )
            pids = [token for token in (proc.stdout or "").split() if token.isdigit()]
            if pids:
                return f"fuser reports PID(s) {', '.join(pids)} holding {db}"
        except Exception:  # noqa: BLE001
            pass
    # /proc fallback (Linux): only meaningful for the live DB path, since a
    # copy in /tmp is never held open by opencode. Checking it against any
    # running opencode process would be a false positive.
    try:
        live = os.path.abspath(resolve_db(None))
    except Exception:  # noqa: BLE001
        live = None
    if live is not None and os.path.abspath(db) != live:
        return None
    # /proc fallback (Linux)
    try:
        for pid in os.listdir("/proc"):
            if not pid.isdigit():
                continue
            try:
                with open(f"/proc/{pid}/comm", encoding="utf-8") as fh:
                    process_name = fh.read().strip()
                if process_name != "opencode":
                    continue
                with open(f"/proc/{pid}/cmdline", "rb") as fh:
                    cmd = fh.read().replace(b"\0", b" ").decode("utf8", "ignore")
                # Exclude this repository's maintenance processes. Their paths
                # contain "opencode", but they are not the OpenCode application.
                if "opencode-db-maintain" in cmd or "opencode-maintenance-cron" in cmd:
                    continue
                return f"PID {pid} ({cmd[:120].strip()}) looks like opencode"
            except (FileNotFoundError, PermissionError):
                continue
    except FileNotFoundError:
        pass
    return None


def collect_stats(db_path: str) -> dict:
    con = sqlite3.connect(readonly_uri(db_path), uri=True, timeout=30)
    try:
        page_size = con.execute("PRAGMA page_size").fetchone()[0]
        page_count = con.execute("PRAGMA page_count").fetchone()[0]
        freelist = con.execute("PRAGMA freelist_count").fetchone()[0]
        journal = con.execute("PRAGMA journal_mode").fetchone()[0]
        auto_vac = con.execute("PRAGMA auto_vacuum").fetchone()[0]
        file_size = os.path.getsize(db_path)

        tables = {}
        for t in ("event", "message", "part", "session", "event_sequence"):
            if not table_exists(con, t):
                continue
            try:
                n = con.execute(f'SELECT count(*) FROM "{t}"').fetchone()[0]
            except sqlite3.Error:
                n = 0
            try:
                size = con.execute(
                    f'SELECT sum(length(data)) FROM "{t}"'
                ).fetchone()[0]
            except sqlite3.Error:
                size = None  # e.g. event_sequence has no data column
            tables[t] = {"rows": n, "bytes": size or 0}

        by_type = []
        if table_exists(con, "event"):
            for typ, n, size in con.execute(
                "SELECT type, count(*), sum(length(data)) FROM event "
                "GROUP BY type ORDER BY sum(length(data)) DESC"
            ):
                by_type.append({"type": typ, "rows": n, "bytes": size or 0})

        sessions = tables.get("session", {}).get("rows", 0)
        return {
            "path": db_path,
            "file_size": file_size,
            "page_size": page_size,
            "page_count": page_count,
            "freelist_count": freelist,
            "freelist_bytes": freelist * page_size,
            "live_bytes": (page_count - freelist) * page_size,
            "journal_mode": journal,
            "auto_vacuum": auto_vacuum_label(auto_vac),
            "tables": tables,
            "by_type": by_type,
            "sessions": sessions,
        }
    finally:
        con.close()


def auto_vacuum_label(v: int) -> str:
    return {0: "OFF (NONE)", 1: "FULL", 2: "INCREMENTAL"}.get(int(v), str(v))


def print_stats(s: dict) -> None:
    print("=" * 60)
    print(" opencode-db-maintain  stats")
    print("=" * 60)
    print(f"  database : {s['path']}")
    print(f"  size     : {fmt_bytes(s['file_size'])}")
    print()
    print("  Storage")
    print("  --------------------------------------------------------")
    print(f"  page_size     : {s['page_size']}")
    print(f"  page_count    : {s['page_count']}")
    print(f"  journal_mode  : {s['journal_mode']}")
    print(f"  auto_vacuum   : {s['auto_vacuum']}")
    fl = s["freelist_bytes"]
    pct = (s["freelist_count"] / s["page_count"] * 100) if s["page_count"] else 0
    print(f"  live data     : {fmt_bytes(s['live_bytes'])}")
    print(f"  freelist      : {fmt_bytes(fl)} ({pct:.1f}% of file)")
    if fl > 0:
        print(f"  -> VACUUM alone would reclaim ~{fmt_bytes(fl)}")
    print()
    print("  Tables (sum(length(data)))")
    print("  --------------------------------------------------------")
    for name, t in s["tables"].items():
        print(f"  {name:<15} {t['rows']:>9,} rows  {fmt_bytes(t['bytes']):>10}")
    if s["by_type"]:
        print()
        print("  Event breakdown")
        print("  --------------------------------------------------------")
        total = sum(e["bytes"] for e in s["by_type"]) or 1
        for e in s["by_type"]:
            share = e["bytes"] / total * 100
            print(
                f"  {e['type']:<28} {e['rows']:>8,} rows  "
                f"{fmt_bytes(e['bytes']):>10}  ({share:.1f}%)"
            )
    print()
    if s["file_size"] > 1024**3:
        print("  WARNING: database exceeds 1 GB -- maintenance recommended.")
    if s["auto_vacuum"] == "OFF (NONE)" and s["freelist_bytes"] > 0:
        print("  NOTE: auto_vacuum is OFF; freed pages stay in the file until VACUUM.")


def newest_session_ids(con: sqlite3.Connection, keep: int) -> set[str]:
    if keep <= 0 or not table_exists(con, "session"):
        return set()
    rows = con.execute(
        'SELECT id FROM session ORDER BY time_updated DESC LIMIT ?', (keep,)
    ).fetchall()
    return {r[0] for r in rows}


def owned_aggregates(con: sqlite3.Connection) -> set[str]:
    """Aggregates with a sync/workspace owner must not be compacted (#36710)."""
    if not table_exists(con, "event_sequence"):
        return set()
    cols = [d[1] for d in con.execute('PRAGMA table_info("event_sequence")')]
    if "owner_id" not in cols:
        return set()
    return {
        r[0]
        for r in con.execute(
            "SELECT aggregate_id FROM event_sequence "
            "WHERE owner_id IS NOT NULL AND owner_id != ''"
        )
    }


def orphan_event_ids(con: sqlite3.Connection) -> list[str]:
    """Events whose aggregate (session) no longer exists. Mirrors #43456."""
    if not table_exists(con, "event") or not table_exists(con, "session"):
        return []
    owned = owned_aggregates(con)
    return [
        event_id
        for event_id, aggregate_id in con.execute(
            "SELECT e.id, e.aggregate_id FROM event e LEFT JOIN session s "
            "ON s.id = e.aggregate_id WHERE s.id IS NULL"
        )
        if aggregate_id not in owned
    ]


def event_node_id(payload: object, key: str) -> str | None:
    """Return a message/part identifier from a compactable event payload."""
    if not isinstance(payload, dict):
        return None
    node = payload.get(key)
    if not isinstance(node, dict):
        return None
    value = node.get("id")
    if isinstance(value, bool):
        return None
    if isinstance(value, (str, int)):
        text = str(value).strip()
        return text or None
    return None


def superseded_event_ids(
    con: sqlite3.Connection, keep_sessions: set[str], skip_owned: bool = True
) -> list[str]:
    """IDs of older full-snapshot events superseded by a newer one.

    - message.updated.1 payload: {"info": {"id": <messageID>, ...}}
    - message.part.updated.1 payload: {"part": {"id": <partID>, ...}}
    Keeps the single newest (max seq) row per message/part id.
    Skips owned aggregates, --keep sessions, and ids whose projection row
    is missing (safer to keep than to guess).
    """
    if not table_exists(con, "event"):
        return []
    owned = owned_aggregates(con) if skip_owned else set()
    victims: list[str] = []
    for typ, key in (
        ("message.updated.1", "info"),
        ("message.part.updated.1", "part"),
    ):
        groups: dict[str, list[tuple[int, str, str]]] = {}
        try:
            rows = con.execute(
                "SELECT id, aggregate_id, seq, data FROM event WHERE type=?", (typ,)
            )
        except sqlite3.Error:
            continue
        for eid, agg, seq, data in rows:
            if agg in owned or agg in keep_sessions:
                continue
            try:
                payload = json.loads(data)
            except (ValueError, TypeError):
                continue  # malformed: skip (matches #41711 conservatism)
            node_id = event_node_id(payload, key)
            if node_id is None:
                continue
            groups.setdefault(node_id, []).append((seq, eid, agg))
        for items in groups.values():
            if len(items) < 2:
                continue
            items.sort()  # ascending seq; last = newest, retained
            for _seq, eid, _agg in items[:-1]:
                victims.append(eid)
    if not victims:
        return []
    # Projection check: only delete if the message/part still exists live.
    victims = _filter_to_live_projections(con, victims)
    return victims


def _filter_to_live_projections(
    con: sqlite3.Connection, event_ids: list[str]
) -> list[str]:
    """Drop candidates whose live message/part row is gone (keep them)."""
    if not event_ids:
        return []
    has_message = table_exists(con, "message")
    has_part = table_exists(con, "part")
    if not has_message and not has_part:
        return []
    live: list[str] = []
    chunk = 500
    for i in range(0, len(event_ids), chunk):
        batch = event_ids[i : i + chunk]
        q = ",".join("?" for _ in batch)
        for eid, typ, data in con.execute(
            f"SELECT id, type, data FROM event WHERE id IN ({q})", batch
        ):
            try:
                payload = json.loads(data)
            except (ValueError, TypeError):
                continue
            if typ == "message.updated.1" and has_message:
                mid = event_node_id(payload, "info")
                if mid and con.execute(
                    "SELECT 1 FROM message WHERE id=?", (mid,)
                ).fetchone():
                    live.append(eid)
            elif typ == "message.part.updated.1" and has_part:
                pid = event_node_id(payload, "part")
                if pid and con.execute(
                    "SELECT 1 FROM part WHERE id=?", (pid,)
                ).fetchone():
                    live.append(eid)
    return live


def batched_delete(db_path: str, ids: list[str], batch: int) -> int:
    if not ids:
        return 0
    con = sqlite3.connect(db_path, timeout=120)
    try:
        con.execute("PRAGMA journal_mode=WAL")
        deleted = 0
        for i in range(0, len(ids), batch):
            chunk = ids[i : i + batch]
            q = ",".join("?" for _ in chunk)
            with con:  # one immediate transaction per batch
                cur = con.execute(f"DELETE FROM event WHERE id IN ({q})", chunk)
                deleted += cur.rowcount or 0
            print(f"  deleted {deleted:,}/{len(ids):,} rows...", flush=True)
        return deleted
    finally:
        con.close()


def create_online_backup(db_path: str, backup_path: str) -> None:
    """Create a transactionally consistent backup, including committed WAL data."""
    source = sqlite3.connect(readonly_uri(db_path), uri=True, timeout=120)
    target = sqlite3.connect(backup_path, timeout=120)
    try:
        source.backup(target, pages=100, sleep=0.050)
    except Exception:
        try:
            os.remove(backup_path)
        except OSError:
            pass
        raise
    finally:
        target.close()
        source.close()


def run_vacuum_sequence(db_path: str) -> None:
    # auto_vacuum change only takes effect after VACUUM rebuilds the file.
    con = sqlite3.connect(db_path, timeout=300)
    try:
        con.execute("PRAGMA auto_vacuum=INCREMENTAL")
        con.commit()
        con.execute("VACUUM")
        con.execute("PRAGMA journal_mode=WAL")  # VACUUM can reset journal mode
        con.commit()
    finally:
        con.close()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        description="Safe maintenance for OpenCode's SQLite store "
        "(diagnose event-log + freelist bloat, prune, vacuum).",
        epilog="Examples: "
        "%(prog)s --stats | %(prog)s --dry-run | "
        "%(prog)s --apply --keep 20 | %(prog)s --apply --vacuum-only",
    )
    ap.add_argument("--version", action="version", version=f"%(prog)s {VERSION}")
    ap.add_argument("--db", default=None, help="path to opencode.db")
    ap.add_argument("--stats", action="store_true", help="read-only health report")
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="report prune candidates without changing anything (default)",
    )
    ap.add_argument("--apply", action="store_true", help="perform writes")
    ap.add_argument(
        "--vacuum-only",
        action="store_true",
        help="skip row deletes; only checkpoint+vacuum+harden",
    )
    ap.add_argument("--keep", type=int, default=10,
                    help="newest N sessions exempt from compaction (default 10)")
    ap.add_argument("--batch", type=int, default=2000,
                    help="delete batch size (default 2000)")
    ap.add_argument("--no-backup", action="store_true", help="skip backup (risky)")
    ap.add_argument("--skip-lock-check", action="store_true",
                    help="apply even if another process may hold the DB")
    ap.add_argument("--force", action="store_true",
                    help="skip confirmation prompt with --apply")
    return ap.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    if args.apply and args.dry_run:
        print("error: --dry-run cannot be combined with --apply", file=sys.stderr)
        return 2
    if args.apply and args.stats:
        print("error: --stats cannot be combined with --apply", file=sys.stderr)
        return 2
    if args.keep < 0:
        print("error: --keep must be zero or greater", file=sys.stderr)
        return 2
    if args.batch < 1:
        print("error: --batch must be one or greater", file=sys.stderr)
        return 2
    db_path = resolve_db(args.db)

    if not os.path.isfile(db_path):
        print(f"error: database not found: {db_path}", file=sys.stderr)
        return 2

    stats = collect_stats(db_path)
    print_stats(stats)

    dry = args.dry_run or not args.apply
    if args.stats or (dry and not args.apply):
        if not args.stats:
            print("dry-run: no changes made (pass --apply to prune/vacuum).")
        # fall through to candidate report
    if args.stats and not args.dry_run and not args.apply:
        return 0

    # ---- candidate analysis (read-only) ----
    con = sqlite3.connect(readonly_uri(db_path), uri=True, timeout=30)
    try:
        keep_ids = newest_session_ids(con, args.keep)
        orphans = [] if args.vacuum_only else orphan_event_ids(con)
        superseded = (
            []
            if args.vacuum_only
            else superseded_event_ids(con, keep_ids)
        )
    finally:
        con.close()

    orphan_bytes = superseded_bytes = 0
    if orphans or superseded:
        con2 = sqlite3.connect(readonly_uri(db_path), uri=True, timeout=30)
        try:
            for label, ids in (("orphan", orphans), ("superseded", superseded)):
                if not ids:
                    continue
                total = 0
                for i in range(0, len(ids), 500):
                    chunk = ids[i : i + 500]
                    q = ",".join("?" for _ in chunk)
                    v = con2.execute(
                        f"SELECT sum(length(id)+length(data)) FROM event "
                        f"WHERE id IN ({q})",
                        chunk,
                    ).fetchone()[0]
                    total += v or 0
                if label == "orphan":
                    orphan_bytes = total
                else:
                    superseded_bytes = total
        finally:
            con2.close()

    print()
    print("  Prune candidates")
    print("  --------------------------------------------------------")
    print(f"  orphaned events (session gone) : {len(orphans):>9,} rows  "
          f"{fmt_bytes(orphan_bytes):>10}")
    print(f"  superseded snapshots (oldest)  : {len(superseded):>9,} rows  "
          f"{fmt_bytes(superseded_bytes):>10}")
    print(f"  exempt newest sessions         : {args.keep}")
    print(f"  estimated file after prune+vac : "
          f"~{fmt_bytes(max(stats['file_size'] - orphan_bytes - superseded_bytes - stats['freelist_bytes'], 0))}")

    if dry and not args.apply:
        print()
        print("dry-run: no changes made (pass --apply to prune/vacuum).")
        return 0

    # ---- --apply path ----
    holder = db_holder(db_path)
    if holder and not args.skip_lock_check:
        print(f"error: refusing --apply: {holder}.", file=sys.stderr)
        print("Close OpenCode first, or pass --skip-lock-check to override.",
              file=sys.stderr)
        return 3

    ok, msg = integrity_ok(db_path)
    if not ok:
        print(f"error: pre-check integrity_check failed: {msg}", file=sys.stderr)
        return 4

    before = os.path.getsize(db_path)
    if not args.force and sys.stdin.isatty():
        answer = input(
            f"Proceed on {db_path}? before={fmt_bytes(before)} "
            f"prune={len(orphans)+len(superseded):,} rows [y/N] "
        ).strip().lower()
        if answer not in ("y", "yes"):
            print("aborted.")
            return 0

    backup_path = None
    if not args.no_backup:
        stamp = time.strftime("%Y%m%dT%H%M%S")
        backup_path = f"{db_path}.backup.{stamp}"
        print(f"backing up to {backup_path}...")
        create_online_backup(db_path, backup_path)
        ok, msg = integrity_ok(backup_path)
        if not ok:
            print(f"error: backup integrity check failed: {msg}", file=sys.stderr)
            return 5
        print("backup integrity verified.")

    do_delete = not args.vacuum_only and (orphans or superseded)
    if do_delete:
        print(f"deleting {len(orphans)+len(superseded):,} event rows in batches "
              f"of {args.batch}...")
        deleted = batched_delete(db_path, orphans + superseded, args.batch)
        print(f"deleted {deleted:,} rows.")
    elif args.vacuum_only:
        print("vacuum-only: skipping row deletes.")

    print("running VACUUM + hardening (auto_vacuum=INCREMENTAL, journal_mode=WAL)...")
    run_vacuum_sequence(db_path)

    ok, msg = integrity_ok(db_path)
    if not ok:
        print(f"error: post-check integrity_check failed: {msg}", file=sys.stderr)
        if backup_path:
            print(f"restore with: cp {backup_path} {db_path}", file=sys.stderr)
        return 6

    after = os.path.getsize(db_path)
    print()
    print("  Results")
    print("  --------------------------------------------------------")
    print(f"  before    : {fmt_bytes(before)}")
    print(f"  after     : {fmt_bytes(after)}")
    print(f"  reclaimed : {fmt_bytes(max(before - after, 0))}")
    if backup_path:
        print(f"  backup    : {backup_path} (keep until OpenCode verified)")
    print("integrity_check: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
