#!/usr/bin/env python3
"""WSL2 profile setup with canonical Ubuntu MCP delegation."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import secrets
import stat
from typing import Any, Callable


PLATFORM_ROOT = Path(__file__).resolve().parent.parent
CONFIG_ROOT = PLATFORM_ROOT / "config"
CATALOG = CONFIG_ROOT / "wsl2-plugin-roles.json"
CANONICAL_ROOT = (PLATFORM_ROOT.parents[3] / "linux" / "ubuntu" / "computer-use").resolve()
CANONICAL_MCP = CANONICAL_ROOT / "scripts" / "mcp_runtime.py"
MAX_CONFIG_BYTES = 1_048_576
SERVER_PERMISSIONS = (
    "websearch",
    "wsl_powershell_command",
    "wsl_powershell_raw",
    "wsl_windows_act",
    "basic-memory_*",
    "github_*",
    "playwright_*",
)


class ConfigError(RuntimeError):
    """Raised when a configuration boundary is unsafe or malformed."""


def canonical_mcp_module() -> Any:
    """Load the one generic MCP implementation owned by native Ubuntu."""
    try:
        metadata = CANONICAL_MCP.lstat()
    except FileNotFoundError as error:
        raise ConfigError(f"canonical MCP implementation is missing: {CANONICAL_MCP}") from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise ConfigError(f"canonical MCP implementation is not a regular file: {CANONICAL_MCP}")
    spec = importlib.util.spec_from_file_location("open_rig_canonical_mcp", CANONICAL_MCP)
    if spec is None or spec.loader is None:
        raise ConfigError(f"cannot load canonical MCP implementation: {CANONICAL_MCP}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MCP = canonical_mcp_module()
MCP_NAMES = tuple(MCP.MCP_NAMES)


def object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    """Build a JSON object while rejecting duplicate keys."""
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ConfigError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def strip_jsonc(text: str) -> str:
    """Remove JSONC comments and trailing commas without changing strings."""
    output: list[str] = []
    index = 0
    in_string = False
    escaped = False
    while index < len(text):
        char = text[index]
        next_char = text[index + 1] if index + 1 < len(text) else ""
        if in_string:
            output.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            index += 1
            continue
        if char == '"':
            in_string = True
            output.append(char)
            index += 1
            continue
        if char == "/" and next_char == "/":
            index += 2
            while index < len(text) and text[index] not in "\r\n":
                index += 1
            continue
        if char == "/" and next_char == "*":
            index += 2
            while index + 1 < len(text) and text[index : index + 2] != "*/":
                index += 1
            if index + 1 >= len(text):
                raise ConfigError("unterminated JSONC block comment")
            index += 2
            continue
        output.append(char)
        index += 1
    if in_string:
        raise ConfigError("unterminated JSON string")
    source = "".join(output)
    output = []
    index = 0
    in_string = False
    escaped = False
    while index < len(source):
        char = source[index]
        if in_string:
            output.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            index += 1
            continue
        if char == '"':
            in_string = True
            output.append(char)
            index += 1
            continue
        if char == ",":
            probe = index + 1
            while probe < len(source) and source[probe].isspace():
                probe += 1
            if probe < len(source) and source[probe] in "}]":
                index += 1
                continue
        output.append(char)
        index += 1
    return "".join(output)


def _absolute(path: Path) -> Path:
    return Path(os.path.abspath(path.expanduser()))


def ensure_safe_path(path: Path, *, allow_missing: bool = True) -> None:
    """Reject shared, mounted, symlinked, and non-directory target ancestors."""
    absolute = _absolute(path)
    if absolute == Path("/mnt") or Path("/mnt") in absolute.parents:
        raise ConfigError(f"refusing Windows-mounted target: {absolute}")
    repository_root = _absolute(Path.home() / "repos")
    if absolute == repository_root or repository_root in absolute.parents:
        raise ConfigError(f"refusing configuration beneath the repository workspace: {absolute}")
    current = Path("/")
    parts = absolute.parts[1:]
    for index, part in enumerate(parts):
        current /= part
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            if not allow_missing:
                raise ConfigError(f"required path is missing: {current}") from None
            return
        if stat.S_ISLNK(metadata.st_mode):
            raise ConfigError(f"refusing symlinked path or ancestor: {current}")
        if index < len(parts) - 1 and not stat.S_ISDIR(metadata.st_mode):
            raise ConfigError(f"existing ancestor is not a directory: {current}")


def pilot_root(config_dir: Path) -> Path:
    """Return the pilot root for the required `<pilot>/config` layout."""
    absolute = _absolute(config_dir)
    if absolute.name != "config" or absolute.parent == absolute:
        raise ConfigError("the isolated server config directory must be <pilot>/config")
    ensure_safe_path(absolute)
    return absolute.parent


def _open_directory(path: Path, *, create: bool) -> int:
    """Open a directory through no-follow descriptors, optionally creating it."""
    absolute = _absolute(path)
    descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in absolute.parts[1:]:
            if create:
                try:
                    os.mkdir(part, mode=0o700, dir_fd=descriptor)
                except FileExistsError:
                    pass
            next_descriptor = os.open(
                part,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=descriptor,
            )
            os.close(descriptor)
            descriptor = next_descriptor
        return descriptor
    except (OSError, NotADirectoryError) as error:
        os.close(descriptor)
        raise ConfigError(f"unsafe or unavailable directory {absolute}: {error}") from error


def _file_metadata(path: Path) -> os.stat_result | None:
    """Read final-component metadata without following links."""
    try:
        parent = _open_directory(path.parent, create=False)
    except ConfigError as error:
        if isinstance(error.__cause__, FileNotFoundError):
            return None
        raise
    try:
        try:
            metadata = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            return None
    finally:
        os.close(parent)
    if not stat.S_ISREG(metadata.st_mode):
        raise ConfigError(f"configuration target is not a regular file: {path}")
    return metadata


def _read_regular_bytes(path: Path) -> bytes:
    """Read one bounded regular file without following its final component."""
    parent = _open_directory(path.parent, create=False)
    try:
        descriptor = os.open(
            path.name,
            os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
            dir_fd=parent,
        )
    except OSError as error:
        os.close(parent)
        raise ConfigError(f"cannot open regular configuration file {path}: {error}") from error
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise ConfigError(f"configuration target is not a regular file: {path}")
        if metadata.st_size > MAX_CONFIG_BYTES:
            raise ConfigError(f"configuration exceeds {MAX_CONFIG_BYTES} bytes: {path}")
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = os.read(descriptor, min(65_536, MAX_CONFIG_BYTES + 1 - total))
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_CONFIG_BYTES:
                raise ConfigError(f"configuration exceeds {MAX_CONFIG_BYTES} bytes: {path}")
            chunks.append(chunk)
        return b"".join(chunks)
    finally:
        os.close(descriptor)
        os.close(parent)


def load_json(path: Path) -> dict[str, Any]:
    """Load bounded UTF-8 JSON or JSONC from a regular no-follow file."""
    try:
        text = _read_regular_bytes(path).decode("utf-8", errors="strict")
        value = json.loads(strip_jsonc(text), object_pairs_hook=object_pairs)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ConfigError(f"cannot parse {path}: {error}") from error
    if not isinstance(value, dict):
        raise ConfigError(f"configuration is not an object: {path}")
    return value


def _payload(value: dict[str, Any]) -> bytes:
    encoded = (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    if len(encoded) > MAX_CONFIG_BYTES:
        raise ConfigError(f"generated configuration exceeds {MAX_CONFIG_BYTES} bytes")
    return encoded


def _stage_bytes(parent: int, name: str, payload: bytes, mode: int) -> str:
    temporary = f".{name}.{secrets.token_hex(16)}.tmp"
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        mode,
        dir_fd=parent,
    )
    try:
        view = memoryview(payload)
        while view:
            written = os.write(descriptor, view)
            view = view[written:]
        os.fchmod(descriptor, mode)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return temporary


def replace_entry(source: str, target: str, parent: int) -> None:
    """Replace one same-directory entry; kept separate for rollback tests."""
    os.replace(source, target, src_dir_fd=parent, dst_dir_fd=parent)


def write_transaction(
    updates: dict[Path, dict[str, Any]],
    *,
    replacer: Callable[[str, str, int], None] = replace_entry,
) -> None:
    """Stage every file, then compensate earlier replacements on failure."""
    if not updates:
        return
    staged: list[dict[str, object]] = []
    committed: list[dict[str, object]] = []
    try:
        for raw_path, value in updates.items():
            path = _absolute(raw_path)
            ensure_safe_path(path)
            metadata = _file_metadata(path)
            backup = _read_regular_bytes(path) if metadata is not None else None
            mode = stat.S_IMODE(metadata.st_mode) if metadata is not None else 0o600
            parent = _open_directory(path.parent, create=True)
            temporary = _stage_bytes(parent, path.name, _payload(value), mode)
            staged.append({
                "path": path,
                "parent": parent,
                "temporary": temporary,
                "backup": backup,
                "mode": mode,
            })
        for record in staged:
            replacer(str(record["temporary"]), Path(record["path"]).name, int(record["parent"]))
            record["temporary"] = ""
            os.fsync(int(record["parent"]))
            committed.append(record)
    except Exception as error:
        rollback_failures: list[str] = []
        for record in reversed(committed):
            parent = int(record["parent"])
            target = Path(record["path"]).name
            try:
                backup = record["backup"]
                if backup is None:
                    os.unlink(target, dir_fd=parent)
                else:
                    restored = _stage_bytes(parent, target, bytes(backup), int(record["mode"]))
                    os.replace(restored, target, src_dir_fd=parent, dst_dir_fd=parent)
                os.fsync(parent)
            except OSError as rollback_error:
                rollback_failures.append(f"{record['path']}: {rollback_error}")
        detail = f"; rollback failed for {', '.join(rollback_failures)}" if rollback_failures else ""
        raise ConfigError(f"configuration transaction failed: {error}{detail}") from error
    finally:
        for record in staged:
            temporary = str(record["temporary"])
            parent = int(record["parent"])
            if temporary:
                try:
                    os.unlink(temporary, dir_fd=parent)
                except FileNotFoundError:
                    pass
            os.close(parent)


def atomic_write(path: Path, value: dict[str, Any]) -> None:
    """Atomically write one configuration file through the transaction path."""
    write_transaction({path: value})


def config_paths(config_dir: Path) -> tuple[Path, Path]:
    """Return server and global CLI paths in the isolated pilot layout."""
    pilot = pilot_root(config_dir)
    direct = _absolute(config_dir) / "opencode.json"
    comments = _absolute(config_dir) / "opencode.jsonc"
    direct_exists = _file_metadata(direct) is not None
    comments_exists = _file_metadata(comments) is not None
    if direct_exists and comments_exists:
        raise ConfigError(f"both {direct} and {comments} exist; consolidate them first")
    return (direct if direct_exists else comments), pilot / "xdg" / "opencode" / "cli.json"


def validate_catalog() -> list[dict[str, Any]]:
    """Validate the independent WSL2 dual-role package catalog."""
    catalog = load_json(CATALOG)
    if catalog.get("version") != 1 or not isinstance(catalog.get("plugins"), list):
        raise ConfigError("unsupported WSL2 role catalog")
    seen: set[str] = set()
    entries: list[dict[str, Any]] = []
    for raw in catalog["plugins"]:
        if not isinstance(raw, dict):
            raise ConfigError("plugin catalog entry is not an object")
        name, relative, roles = raw.get("name"), raw.get("path"), raw.get("roles")
        if not isinstance(name, str) or not name or name in seen:
            raise ConfigError(f"invalid or duplicate plugin name: {name}")
        if not isinstance(relative, str) or relative.startswith("/") or ".." in Path(relative).parts:
            raise ConfigError(f"unsafe plugin path for {name}: {relative}")
        package = (PLATFORM_ROOT / relative).resolve()
        expected_parent = (PLATFORM_ROOT / "plugins-v2").resolve()
        if package.parent != expected_parent or not package.is_dir() or package.is_symlink():
            raise ConfigError(f"plugin package is not a canonical direct child: {package}")
        if not isinstance(roles, dict) or not roles:
            raise ConfigError(f"plugin {name} has no roles")
        for role, definition in roles.items():
            if role not in {"server", "cli"} or not isinstance(definition, dict):
                raise ConfigError(f"unsupported role for {name}: {role}")
            entrypoint = definition.get("entrypoint")
            target = definition.get("config")
            if not isinstance(entrypoint, str) or Path(entrypoint).name != entrypoint:
                raise ConfigError(f"unsafe entrypoint for {name}/{role}")
            entrypoint_path = package / entrypoint
            if not entrypoint_path.is_file() or entrypoint_path.is_symlink():
                raise ConfigError(f"missing regular entrypoint: {entrypoint_path}")
            expected_config = "opencode.jsonc" if role == "server" else "cli.json"
            if target != expected_config:
                raise ConfigError(f"wrong config target for {name}/{role}: {target}")
        seen.add(name)
        entries.append({"name": name, "package": str(package), "roles": roles})
    return entries


def prepare_runtime(config_dir: Path, *, apply: bool) -> None:
    """Create the WSL profile and delegate generic MCP state to Ubuntu."""
    pilot = pilot_root(config_dir)
    try:
        MCP.prepare_profile(pilot, apply=apply)
    except MCP.McpRuntimeError as error:
        raise ConfigError(str(error)) from error


def mcp_provisioning(config_dir: Path, *, apply: bool, quiet: bool = False) -> None:
    """Record or verify the canonical MCP runtimes in the WSL profile."""
    pilot = pilot_root(config_dir)
    try:
        MCP.mcp_provisioning(pilot, profile="wsl2", apply=apply, quiet=quiet)
    except MCP.McpRuntimeError as error:
        raise ConfigError(str(error)) from error


def seed(config_dir: Path, *, apply: bool) -> None:
    """Seed missing server and isolated global CLI configuration together."""
    pilot_root(config_dir)
    server_path, cli_path = config_paths(config_dir)
    targets = (
        (CONFIG_ROOT / "opencode.example.jsonc", server_path),
        (CONFIG_ROOT / "cli.example.json", cli_path),
    )
    updates: dict[Path, dict[str, Any]] = {}
    for source, target in targets:
        if _file_metadata(target) is not None:
            load_json(target)
            print(f"OK: existing config valid: {target}")
        elif not apply:
            raise ConfigError(f"missing config: {target} (rerun with --apply)")
        else:
            updates[target] = load_json(source)
    if updates:
        prepare_runtime(config_dir, apply=True)
        write_transaction(updates)
        for target in updates:
            print(f"OK: seeded isolated WSL2 config: {target}")


def ensure_permission(data: dict[str, Any], action: str) -> None:
    """Make one final exact ask rule authoritative for an owned action."""
    permissions = data.setdefault("permissions", [])
    if not isinstance(permissions, list) or not all(isinstance(rule, dict) for rule in permissions):
        raise ConfigError("permissions must be an array of objects")
    retained = [rule for rule in permissions if rule.get("action") != action]
    retained.append({"action": action, "resource": "*", "effect": "ask"})
    data["permissions"] = retained


def plugin_object(package: str) -> dict[str, Any]:
    """Return the complete strict options owned by the WSL interop plugin."""
    return {
        "package": package,
        "options": {
            "enabled": True,
            "refreshMs": 5000,
            "powershell": {"preferred": "auto", "timeoutMs": 10000, "maxOutputBytes": 262144},
            "raw": {"enabled": True, "tokenTtlMs": 60000, "maxScriptBytes": 65536, "maxTokens": 128},
        },
    }


def configured_package(entry: object) -> str | None:
    """Return the package value from either supported plugin entry shape."""
    if isinstance(entry, str):
        return entry
    if isinstance(entry, dict) and isinstance(entry.get("package"), str):
        return entry["package"]
    return None


def ensure_plugin(data: dict[str, Any], package: str) -> None:
    """Normalize one owned plugin registration and reject aliases."""
    plugins = data.setdefault("plugins", [])
    if not isinstance(plugins, list):
        raise ConfigError("plugins must be an array")
    match_indexes = [index for index, entry in enumerate(plugins) if configured_package(entry) == package]
    aliases = [
        value
        for entry in plugins
        if (value := configured_package(entry)) is not None
        and value != package
        and Path(value.rstrip("/")).name == Path(package).name
    ]
    if aliases:
        raise ConfigError(f"non-canonical plugin registration for {package}: {aliases[0]}")
    if len(match_indexes) > 1:
        raise ConfigError(f"duplicate plugin registration: {package}")
    canonical = plugin_object(package)
    if match_indexes:
        plugins[match_indexes[0]] = canonical
    else:
        plugins.append(canonical)


def mcp_servers(config_dir: Path) -> dict[str, dict[str, Any]]:
    """Return declarations from the canonical Ubuntu MCP implementation."""
    try:
        return MCP.mcp_servers("wsl2", pilot_root(config_dir))
    except MCP.McpRuntimeError as error:
        raise ConfigError(str(error)) from error


def ensure_mcps(data: dict[str, Any], config_dir: Path) -> None:
    """Merge the canonical MCP declarations into the WSL server config."""
    try:
        MCP.ensure_mcp_servers(data, profile="wsl2", profile_root=pilot_root(config_dir))
    except MCP.McpRuntimeError as error:
        raise ConfigError(str(error)) from error


def selected_roles(selection: str) -> set[str]:
    """Translate a deployment selector to exact server and CLI roles."""
    if selection not in {"all", "server", "cli", "wsl-interop"}:
        raise ConfigError(f"unsupported plugin selection: {selection}")
    return {"server", "cli"} if selection in {"all", "wsl-interop"} else {selection}


def deploy(config_dir: Path, selection: str, *, apply: bool) -> None:
    """Deploy only selected roles and verify the same scope."""
    entries = validate_catalog()
    roles = selected_roles(selection)
    server_path, cli_path = config_paths(config_dir)
    documents: dict[str, tuple[Path, dict[str, Any]]] = {}
    for role, path in (("server", server_path), ("cli", cli_path)):
        if role not in roles:
            continue
        if _file_metadata(path) is None:
            raise ConfigError("run setup-opencode.sh --apply before plugin deployment")
        documents[role] = (path, load_json(path))
    originals = {role: json.loads(json.dumps(data)) for role, (_, data) in documents.items()}
    for entry in entries:
        for role in roles.intersection(entry["roles"]):
            ensure_plugin(documents[role][1], entry["package"])
    if "server" in documents:
        server = documents["server"][1]
        if server.get("websearch") is False:
            raise ConfigError("websearch is explicitly disabled in the isolated WSL2 config")
        server["websearch"] = {"provider": "random"}
        ensure_mcps(server, config_dir)
        for action in SERVER_PERMISSIONS:
            ensure_permission(server, action)
    if "cli" in documents:
        cli = documents["cli"][1]
        session = cli.setdefault("session", {})
        if not isinstance(session, dict):
            raise ConfigError("CLI session must be an object")
        session["permissions"] = "prompt"
    changed = [role for role, (_, data) in documents.items() if data != originals[role]]
    if changed and not apply:
        raise ConfigError(f"deployment changes required for: {', '.join(sorted(changed))} (rerun with --apply)")
    if apply:
        write_transaction({path: data for path, data in documents.values()})
    verify_deployment(config_dir, selection)


def _verify_permissions(server: dict[str, Any]) -> None:
    permissions = server.get("permissions")
    if not isinstance(permissions, list) or not all(isinstance(rule, dict) for rule in permissions):
        raise ConfigError("permissions must be an array of objects")
    for action in SERVER_PERMISSIONS:
        rules = [rule for rule in permissions if rule.get("action") == action]
        if rules != [{"action": action, "resource": "*", "effect": "ask"}]:
            raise ConfigError(f"missing authoritative exact ask permission: {action}")


def _verify_mcps(server: dict[str, Any], config_dir: Path) -> None:
    try:
        MCP.verify_mcp_servers(server, profile="wsl2", profile_root=pilot_root(config_dir))
    except MCP.McpRuntimeError as error:
        raise ConfigError(str(error)) from error


def verify_deployment(config_dir: Path, selection: str = "all") -> None:
    """Verify exactly the selected role surface."""
    entries = validate_catalog()
    roles = selected_roles(selection)
    server_path, cli_path = config_paths(config_dir)
    documents: dict[str, dict[str, Any]] = {}
    if "server" in roles:
        documents["server"] = load_json(server_path)
        server = documents["server"]
        if server.get("websearch") != {"provider": "random"}:
            raise ConfigError("isolated WSL2 config must set websearch exactly to provider=random")
        _verify_permissions(server)
        _verify_mcps(server, config_dir)
    if "cli" in roles:
        documents["cli"] = load_json(cli_path)
        cli = documents["cli"]
        if not isinstance(cli.get("session"), dict) or cli["session"].get("permissions") != "prompt":
            raise ConfigError("CLI session.permissions must be prompt")
    for entry in entries:
        for role in roles.intersection(entry["roles"]):
            data = documents[role]
            plugins = data.get("plugins", [])
            if not isinstance(plugins, list):
                raise ConfigError(f"{role} plugins must be an array")
            matches = [item for item in plugins if configured_package(item) == entry["package"]]
            aliases = [
                value
                for item in plugins
                if (value := configured_package(item)) is not None
                and value != entry["package"]
                and Path(value.rstrip("/")).name == Path(entry["package"]).name
            ]
            if aliases:
                raise ConfigError(f"non-canonical {entry['name']} {role} registration: {aliases[0]}")
            if matches != [plugin_object(entry["package"])]:
                raise ConfigError(f"{entry['name']} {role} role is not registered with exact enabled options")
    print(f"OK: WSL2 role deployment verified ({','.join(sorted(roles))}): {pilot_root(config_dir)}")


def parse_args() -> argparse.Namespace:
    """Parse the setup helper command line."""
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("setup", "deploy", "verify", "check-path", "runtime", "mcp-runtime"))
    parser.add_argument("--config-dir", type=Path, required=True)
    parser.add_argument("--plugins", default="all")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    return parser.parse_args()


def main() -> int:
    """Run one bounded configuration operation."""
    args = parse_args()
    try:
        if args.action == "setup":
            seed(args.config_dir, apply=args.apply)
        elif args.action == "deploy":
            deploy(args.config_dir, args.plugins, apply=args.apply)
        elif args.action == "verify":
            verify_deployment(args.config_dir, args.plugins)
        elif args.action == "runtime":
            prepare_runtime(args.config_dir, apply=args.apply)
        elif args.action == "mcp-runtime":
            mcp_provisioning(args.config_dir, apply=args.apply, quiet=args.quiet)
        else:
            root = pilot_root(args.config_dir)
            if not args.quiet:
                print(f"OK: safe isolated WSL2 pilot path: {root}")
    except (ConfigError, OSError) as error:
        print(f"ERROR: {error}", file=os.sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
