#!/usr/bin/env python3
"""Small, private memory store for the local computer-assistant skills.

Reads are safe by default. Remember/forget/prune only write with --apply.
The JSON store is owner-only and rejects obvious credentials.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import tempfile
import uuid
from contextlib import contextmanager
from datetime import date, datetime, timezone
from pathlib import Path


DEFAULT_PATH = Path.home() / "Documents" / "computer-assistant" / "memory.json"
CATEGORIES = ("preference", "system", "workflow", "decision", "pending")
SOURCES = ("user", "observed", "verified")
SECRET_PATTERN = re.compile(
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----|"
    r"(?:password|passwd|api[_ -]?key|access[_ -]?token|secret)\s*[:=]\s*\S+|"
    r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,})\b",
    re.IGNORECASE,
)


def now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def memory_path() -> Path:
    return Path(os.environ.get("ASSISTANT_MEMORY_PATH", DEFAULT_PATH)).expanduser()


def empty_store() -> dict:
    return {"version": 1, "entries": []}


def validate_timestamp(value: object, index: int, field: str) -> None:
    if not isinstance(value, str):
        raise SystemExit(f"assistant-memory: invalid {field} at index {index}")
    try:
        datetime.fromisoformat(value)
    except ValueError as exc:
        raise SystemExit(f"assistant-memory: invalid {field} at index {index}") from exc


def validate_store(data: object) -> dict:
    if not isinstance(data, dict) or data.get("version") != 1:
        raise SystemExit("assistant-memory: unsupported or invalid store version")
    entries = data.get("entries")
    if not isinstance(entries, list):
        raise SystemExit("assistant-memory: entries must be a list")
    required = {"id", "category", "text", "source", "created_at", "updated_at", "expires"}
    seen = set()
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict) or not required.issubset(entry):
            raise SystemExit(f"assistant-memory: invalid entry at index {index}")
        if not isinstance(entry["id"], str) or not entry["id"].strip():
            raise SystemExit(f"assistant-memory: invalid id at index {index}")
        if entry["id"] in seen:
            raise SystemExit(f"assistant-memory: duplicate id {entry['id']}")
        seen.add(entry["id"])
        if entry["category"] not in CATEGORIES or entry["source"] not in SOURCES:
            raise SystemExit(f"assistant-memory: invalid category/source at index {index}")
        if not isinstance(entry["text"], str) or not entry["text"].strip():
            raise SystemExit(f"assistant-memory: empty text at index {index}")
        validate_timestamp(entry["created_at"], index, "created_at")
        validate_timestamp(entry["updated_at"], index, "updated_at")
        if entry["expires"] is not None:
            try:
                date.fromisoformat(entry["expires"])
            except (TypeError, ValueError) as exc:
                raise SystemExit(
                    f"assistant-memory: invalid expiry at index {index}"
                ) from exc
    return data


@contextmanager
def store_lock(*, exclusive: bool):
    """Serialize access through a process lock beside the memory store."""
    path = memory_path()
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    lock_path = path.with_name(".memory.lock")
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        os.fchmod(fd, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
        yield
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def load(*, create: bool = False) -> dict:
    path = memory_path()
    if not path.exists():
        if create:
            return empty_store()
        raise SystemExit(f"assistant-memory: store not initialized: {path} (run init)")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"assistant-memory: cannot read {path}: {exc}") from exc
    return validate_store(data)


def save(data: dict) -> None:
    validate_store(data)
    path = memory_path()
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    fd, tmp_name = tempfile.mkstemp(prefix=".memory.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp_name, 0o600)
        os.replace(tmp_name, path)
    finally:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass


def is_expired(entry: dict) -> bool:
    return entry["expires"] is not None and date.fromisoformat(entry["expires"]) < date.today()


def print_entries(entries: list[dict], as_json: bool) -> None:
    if as_json:
        print(json.dumps(entries, indent=2, ensure_ascii=False))
        return
    if not entries:
        print("No matching memories.")
        return
    for entry in entries:
        expiry = f" expires={entry['expires']}" if entry["expires"] else ""
        print(
            f"{entry['id']} [{entry['category']}/{entry['source']}]"
            f"{expiry} {entry['text']}"
        )


def filtered_entries(args) -> list[dict]:
    entries = load()["entries"]
    if not getattr(args, "all", False):
        entries = [entry for entry in entries if not is_expired(entry)]
    if getattr(args, "category", None):
        entries = [entry for entry in entries if entry["category"] == args.category]
    if getattr(args, "source", None):
        entries = [entry for entry in entries if entry["source"] == args.source]
    return entries


def command_init(_args) -> None:
    with store_lock(exclusive=True):
        path = memory_path()
        if path.exists():
            load()
            os.chmod(path, 0o600)
            os.chmod(path.parent, 0o700)
            print(f"Memory store already initialized: {path}")
            return
        save(empty_store())
        print(f"Initialized memory store: {path}")


def command_list(args) -> None:
    with store_lock(exclusive=False):
        print_entries(filtered_entries(args), args.json)


def command_search(args) -> None:
    with store_lock(exclusive=False):
        terms = args.query.casefold().split()
        entries = [
            entry
            for entry in filtered_entries(args)
            if all(term in entry["text"].casefold() for term in terms)
        ]
        print_entries(entries, args.json)


def validate_expiry(value: str | None) -> str | None:
    if value is None:
        return None
    try:
        date.fromisoformat(value)
    except ValueError as exc:
        raise SystemExit("assistant-memory: --expires must be YYYY-MM-DD") from exc
    return value


def command_remember(args) -> None:
    text = " ".join(args.text.split())
    if not text:
        raise SystemExit("assistant-memory: memory text cannot be empty")
    if SECRET_PATTERN.search(text):
        raise SystemExit("assistant-memory: refusing text that looks like a credential")
    expiry = validate_expiry(args.expires)
    with store_lock(exclusive=True):
        data = load(create=True)
        duplicate = next(
            (
                entry
                for entry in data["entries"]
                if entry["category"] == args.category
                and entry["text"].casefold() == text.casefold()
            ),
            None,
        )
        preview = {
            "category": args.category,
            "text": text,
            "source": args.source,
            "expires": expiry,
        }
        if not args.apply:
            print(json.dumps({"dry_run": True, "would_remember": preview}, indent=2))
            return
        if duplicate:
            print(json.dumps({"applied": False, "duplicate": duplicate}, indent=2))
            return
        timestamp = now()
        entry = {
            "id": f"mem-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}-{uuid.uuid4().hex[:8]}",
            **preview,
            "created_at": timestamp,
            "updated_at": timestamp,
        }
        data["entries"].append(entry)
        save(data)
        print(json.dumps({"applied": True, "entry": entry}, indent=2))


def command_forget(args) -> None:
    with store_lock(exclusive=True):
        data = load()
        matching = [entry for entry in data["entries"] if entry["id"] == args.id]
        if not matching:
            raise SystemExit(f"assistant-memory: id not found: {args.id}")
        if not args.apply:
            print(json.dumps({"dry_run": True, "would_forget": matching[0]}, indent=2))
            return
        data["entries"] = [entry for entry in data["entries"] if entry["id"] != args.id]
        save(data)
        print(json.dumps({"applied": True, "forgot": matching[0]}, indent=2))


def command_prune(args) -> None:
    with store_lock(exclusive=True):
        data = load()
        expired = [entry for entry in data["entries"] if is_expired(entry)]
        if not args.apply:
            print(json.dumps({"dry_run": True, "expired": expired}, indent=2))
            return
        expired_ids = {entry["id"] for entry in expired}
        data["entries"] = [entry for entry in data["entries"] if entry["id"] not in expired_ids]
        save(data)
        print(json.dumps({"applied": True, "pruned": len(expired)}, indent=2))


def command_validate(_args) -> None:
    with store_lock(exclusive=False):
        data = load()
        path = memory_path()
        file_stat = path.stat()
        parent_stat = path.parent.stat()
        if file_stat.st_mode & 0o777 != 0o600:
            raise SystemExit(
                f"assistant-memory: unsafe file mode {file_stat.st_mode & 0o777:o}; expected 600"
            )
        if parent_stat.st_mode & 0o777 != 0o700:
            raise SystemExit(
                f"assistant-memory: unsafe directory mode {parent_stat.st_mode & 0o777:o}; expected 700"
            )
        if file_stat.st_uid != os.geteuid() or parent_stat.st_uid != os.geteuid():
            raise SystemExit("assistant-memory: store must be owned by the current user")
        print(f"OK: {path} ({len(data['entries'])} entries, mode 600)")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="Private memory store for computer-assistant skills")
    sub = result.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init", help="create an empty owner-only store")
    init.set_defaults(func=command_init)

    listing = sub.add_parser("list", help="list active memories")
    listing.add_argument("--category", choices=CATEGORIES)
    listing.add_argument("--source", choices=SOURCES)
    listing.add_argument("--all", action="store_true", help="include expired entries")
    listing.add_argument("--json", action="store_true")
    listing.set_defaults(func=command_list)

    search = sub.add_parser("search", help="search memory text")
    search.add_argument("query")
    search.add_argument("--category", choices=CATEGORIES)
    search.add_argument("--source", choices=SOURCES)
    search.add_argument("--all", action="store_true", help="include expired entries")
    search.add_argument("--json", action="store_true")
    search.set_defaults(func=command_search)

    remember = sub.add_parser("remember", help="add a memory; dry-run unless --apply")
    remember.add_argument("text")
    remember.add_argument("--category", choices=CATEGORIES, required=True)
    remember.add_argument("--source", choices=SOURCES, required=True)
    remember.add_argument("--expires", help="optional YYYY-MM-DD expiry")
    remember.add_argument("--apply", action="store_true")
    remember.set_defaults(func=command_remember)

    forget = sub.add_parser("forget", help="remove a memory; dry-run unless --apply")
    forget.add_argument("id")
    forget.add_argument("--apply", action="store_true")
    forget.set_defaults(func=command_forget)

    prune = sub.add_parser("prune", help="remove expired memories; dry-run unless --apply")
    prune.add_argument("--apply", action="store_true")
    prune.set_defaults(func=command_prune)

    validate = sub.add_parser("validate", help="validate schema and permissions")
    validate.set_defaults(func=command_validate)
    return result


def main() -> int:
    args = parser().parse_args()
    args.func(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
