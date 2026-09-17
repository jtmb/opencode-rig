# `opencode-chat-backup.py`

Exports every OpenCode chat (session) to JSON files using
`opencode export <sessionID>`. Exports are full-fidelity and re-importable with
`opencode import`. The script reads the SQLite store read-only, so it is safe to
run at any time, including while OpenCode is open and from cron.

```bash
python3 platforms/linux/ubuntu/computer-use/scripts/opencode-chat-backup.py --dry-run
python3 platforms/linux/ubuntu/computer-use/scripts/opencode-chat-backup.py
python3 platforms/linux/ubuntu/computer-use/scripts/opencode-chat-backup.py --root ~/Documents/opencode-backups
python3 platforms/linux/ubuntu/computer-use/scripts/opencode-chat-backup.py --prune-deleted
```

## Options

| Option | Default | Meaning |
|--------|---------|---------|
| `--db PATH` | resolved | Path to `opencode.db` for the session inventory |
| `--root DIR` | `~/Documents/opencode-backups` | Backup root |
| `--dry-run` | off | Report what would be exported without writing |
| `--prune-deleted` | off | Remove JSON backups whose session no longer exists |
| `--force` | off | Skip the confirmation prompt |

The CLI is invoked with each session id, so `opencode` must be on `PATH`.

### Active-database constraint

`opencode export` reads OpenCode's **active** store. The script therefore
resolves the active database and refuses a `--db` that points somewhere else:

```
error: --db inventory does not match OpenCode's active database;
alternate-store export is unsupported
```

This prevents a mismatch where the inventory is listed from one file but the
exports come from another. The database is resolved from `--db`, then
`OPENCODE_DB`, then the standard XDG location (largest candidate wins).

## Layout

```
<backup-root>/<repo>/<slug>__<sanitized-title>.json
```

- `<repo>` is the session directory's git origin remote name when the directory
  is a checkout, otherwise the directory basename. Sessions whose directory is
  `/home/james` land in `james/`; a directory that cannot be resolved lands in
  `global/`.
- The filename is `<slug or id>__<sanitized title>`. `sanitize()` lowercases,
  replaces non-alphanumerics with `-`, and truncates to 60 characters.
- Repeat exports with the same title overwrite in place. A changed title
  produces another filename; the manifest records which files the script owns
  so old names can be pruned safely.

## Manifest

`.opencode-chat-backup-manifest.json` in the backup root maps each session id to
its relative backup path. It is used to:

- Prune files for sessions that no longer exist.
- Prune the previous file after a title change (a rename).

The manifest is written atomically after **all** exports succeed. If any export
fails, pruning and the manifest update are skipped and the script exits `1`, so
a partial run never loses track of previously good backups.

## Flow

1. Resolve and validate the database; ensure the `--db`/active match.
2. List sessions (`id`, `slug`, `title`, `directory`, `time_updated`, newest
   first) with a read-only connection.
3. Build the planned destination for each session, caching repo labels per
   directory, and print the plan.
4. Stop if `--dry-run`.
5. Prompt before exporting when there are more than 20 sessions, stdin is a TTY,
   and `--force` is not set. Cron and non-interactive runs skip the prompt.
6. Export each session to a temp file, validate the JSON payload's
   `info.id` matches the requested session, then move it into place. Failures are
   collected and reported per session.
7. On full success, write the manifest.
8. With `--prune-deleted`, remove backups whose session is gone and the old file
   for any renamed backup.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success (including "no sessions") or aborted at the prompt |
| `1` | One or more exports failed; pruning and manifest update skipped |
| `2` | Database not found, or the `--db`/active mismatch |

## Safety and notes

- The database is opened read-only (`mode=ro`), and the script never writes to
  it.
- Each export is validated before replacing its destination, so a failed or
  truncated export does not corrupt an existing backup.
- Backups contain full chat content. Treat the backup root as private data and
  keep it outside the repository.
- The script is idempotent: re-running overwrites the same paths with the same
  content.
- Related: [`opencode-db-maintain.md`](opencode-db-maintain.md) (run a backup
  before database compaction), [`opencode-maintenance-cron.md`](opencode-maintenance-cron.md)
  (scheduled use).
