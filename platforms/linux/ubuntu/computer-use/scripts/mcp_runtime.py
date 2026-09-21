#!/usr/bin/env python3
"""Canonical MCP policy, profile state, and runtime verification helpers."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from typing import Any
from urllib.request import urlopen


CANONICAL_ROOT = Path(__file__).resolve().parent.parent
POLICY_PATH = CANONICAL_ROOT / "config" / "mcp-versions.json"
SCRIPT_ROOT = CANONICAL_ROOT / "scripts"
MCP_NAMES = ("basic-memory", "github", "playwright")
MCP_PROFILES = ("native", "wsl2")
MAX_POLICY_BYTES = 64 * 1024
MAX_CONFIG_BYTES = 1024 * 1024
MAX_NODE_ARCHIVE_BYTES = 256 * 1024 * 1024
NATIVE_NOTES = Path.home() / "Documents" / "computer-assistant" / "basic-memory"
NATIVE_ROOT = Path.home() / ".local" / "share" / "opencode" / "mcp"
NATIVE_BROWSER_CACHE = Path.home() / ".cache" / "ms-playwright"
NATIVE_BASIC_COMMAND = "./platforms/linux/ubuntu/computer-use/scripts/basic-memory-mcp.sh"
NATIVE_PLAYWRIGHT_COMMAND = "./platforms/linux/ubuntu/computer-use/scripts/playwright-mcp.sh"


class McpRuntimeError(RuntimeError):
    """Raised when the canonical MCP policy or runtime is unsafe."""


def validate_profile(profile: str) -> None:
    """Reject profile names that could accidentally select another state root."""
    if profile not in MCP_PROFILES:
        raise McpRuntimeError(f"unsupported MCP profile: {profile}")


def _pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise McpRuntimeError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _absolute(path: Path) -> Path:
    return Path(os.path.abspath(path.expanduser()))


def ensure_safe_path(path: Path, *, allow_missing: bool = True) -> Path:
    """Reject mounted/repository paths and symlinked ancestors."""
    absolute = _absolute(path)
    if absolute == Path("/mnt") or Path("/mnt") in absolute.parents:
        raise McpRuntimeError(f"refusing Windows-mounted MCP state: {absolute}")
    repository = _absolute(CANONICAL_ROOT.parents[3])
    if absolute == repository or repository in absolute.parents:
        raise McpRuntimeError(f"refusing MCP state beneath the repository workspace: {absolute}")
    current = Path("/")
    for index, part in enumerate(absolute.parts[1:]):
        current /= part
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            if not allow_missing:
                raise McpRuntimeError(f"required MCP path is missing: {current}") from None
            return absolute
        if stat.S_ISLNK(metadata.st_mode):
            raise McpRuntimeError(f"refusing symlinked MCP path or ancestor: {current}")
        if index < len(absolute.parts) - 2 and not stat.S_ISDIR(metadata.st_mode):
            raise McpRuntimeError(f"MCP path ancestor is not a directory: {current}")
    return absolute


def _read_regular(path: Path, *, limit: int = MAX_POLICY_BYTES) -> bytes:
    absolute = _absolute(path)
    try:
        metadata = absolute.lstat()
    except FileNotFoundError as error:
        raise McpRuntimeError(f"missing canonical MCP file: {absolute}") from error
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise McpRuntimeError(f"canonical MCP file is not a regular file: {absolute}")
    if metadata.st_size > limit:
        raise McpRuntimeError(f"canonical MCP file exceeds {limit} bytes: {absolute}")
    try:
        return absolute.read_bytes()
    except OSError as error:
        raise McpRuntimeError(f"cannot read canonical MCP file: {absolute}: {error}") from error


def load_policy() -> dict[str, Any]:
    """Load the one checked-in MCP version and endpoint policy."""
    try:
        value = json.loads(_read_regular(POLICY_PATH).decode("utf-8"), object_pairs_hook=_pairs)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise McpRuntimeError(f"cannot parse canonical MCP policy: {error}") from error
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        raise McpRuntimeError("unsupported canonical MCP policy")
    if not isinstance(value.get("basicMemory"), str) or not isinstance(value.get("playwright"), str):
        raise McpRuntimeError("canonical MCP policy has invalid package versions")
    if value.get("githubRemote") != "https://api.githubcopilot.com/mcp/":
        raise McpRuntimeError("canonical GitHub MCP endpoint is not the hosted OAuth endpoint")
    if value.get("playwrightBrowser") != "chrome-for-testing" or not isinstance(
        value.get("playwrightBrowserRevision"), int
    ):
        raise McpRuntimeError("canonical Playwright browser pin is invalid")
    node_version = value.get("nodeVersion")
    node_archive = value.get("nodeArchive")
    node_sha256 = value.get("nodeSha256")
    node_url = value.get("nodeUrl")
    if (
        not isinstance(node_version, str)
        or not isinstance(node_archive, str)
        or not isinstance(node_sha256, str)
        or len(node_sha256) != 64
        or any(character not in "0123456789abcdef" for character in node_sha256.lower())
        or not isinstance(node_url, str)
        or not node_url.startswith("https://nodejs.org/dist/")
    ):
        raise McpRuntimeError("canonical Node.js runtime pin is invalid")
    expected_archive = f"node-v{node_version}-linux-x64.tar.xz"
    expected_url = f"https://nodejs.org/dist/v{node_version}/{expected_archive}"
    if node_archive != expected_archive or node_url != expected_url:
        raise McpRuntimeError("canonical Node.js archive and URL do not match the pinned version")
    return value


def expected_marker(profile: str) -> dict[str, Any]:
    """Return the exact marker payload for one isolated runtime profile."""
    validate_profile(profile)
    policy = load_policy()
    return {
        "schemaVersion": 1,
        "profile": profile,
        "basicMemory": policy["basicMemory"],
        "playwright": policy["playwright"],
        "playwrightBrowser": policy["playwrightBrowser"],
        "playwrightBrowserRevision": policy["playwrightBrowserRevision"],
        "githubRemote": policy["githubRemote"],
        "nodeVersion": policy["nodeVersion"],
    }


def profile_paths(profile_root: Path) -> dict[str, Path]:
    """Return private state paths for a profile without creating them."""
    root = ensure_safe_path(profile_root)
    policy = load_policy()
    return {
        "root": root,
        "basic": root / "mcp" / "basic-memory",
        "basic_home": root / "mcp" / "basic-memory" / "home",
        "basic_notes": root / "mcp" / "basic-memory" / "notes",
        "playwright": root / "mcp" / "playwright",
        "playwright_home": root / "mcp" / "playwright" / "home",
        "playwright_output": root / "mcp" / "playwright" / "output",
        "node_root": root / "mcp" / "node" / f"node-v{policy['nodeVersion']}-linux-x64",
        "uv_cache": root / "cache" / "uv",
        "uv_environments": root / "cache" / "uv" / "environments-v2",
        "uv_archive": root / "cache" / "uv" / "archive-v0",
        "npm_cache": root / "cache" / "npm",
        "npx_cache": root / "cache" / "npm" / "_npx",
        "browser_cache": root / "cache" / "ms-playwright",
        "marker": root / "mcp" / "provisioned.json",
    }


def native_paths() -> dict[str, Path]:
    """Return native user-local MCP state without borrowing WSL profile state."""
    root = ensure_safe_path(Path(os.environ.get("OPENCODE_MCP_NATIVE_ROOT", str(NATIVE_ROOT))))
    notes = ensure_safe_path(Path(os.environ.get("BASIC_MEMORY_HOME", str(NATIVE_NOTES))))
    browser_cache = ensure_safe_path(
        Path(os.environ.get("OPENCODE_MCP_NATIVE_BROWSER_CACHE", str(NATIVE_BROWSER_CACHE)))
    )
    policy = load_policy()
    node_root = root / "node" / f"node-v{policy['nodeVersion']}-linux-x64"
    return {
        "root": root,
        "basic": root / "basic-memory",
        "basic_config": root / "basic-memory" / "config",
        "basic_notes": notes,
        "playwright": root / "playwright",
        "playwright_output": root / "playwright" / "output",
        "browser_cache": browser_cache,
        "node_root": node_root,
        "marker": root / "provisioned.json",
    }


def prepare_profile(profile_root: Path, *, apply: bool) -> None:
    """Create or validate only the private directories owned by a profile."""
    paths = profile_paths(profile_root)
    directories = (
        paths["root"],
        paths["root"] / "workspace",
        paths["root"] / "config",
        paths["root"] / "xdg" / "opencode",
        paths["root"] / "data",
        paths["root"] / "state",
        paths["root"] / "cache",
        paths["basic"],
        paths["basic_home"],
        paths["basic_notes"],
        paths["playwright"],
        paths["playwright_home"],
        paths["playwright_output"],
        paths["node_root"].parent,
        paths["uv_cache"],
        paths["uv_environments"],
        paths["uv_archive"],
        paths["npm_cache"],
        paths["npx_cache"],
        paths["browser_cache"],
    )
    for directory in directories:
        ensure_safe_path(directory)
        if not apply:
            if not directory.is_dir() or directory.is_symlink():
                raise McpRuntimeError(f"missing MCP profile directory: {directory}")
            continue
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        metadata = directory.lstat()
        if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
            raise McpRuntimeError(f"MCP profile path is not a real directory: {directory}")
        directory.chmod(0o700)


def prepare_native(*, apply: bool) -> None:
    """Create or validate native user-local state and the Basic Memory notes root."""
    paths = native_paths()
    directories = (
        paths["root"],
        paths["basic"],
        paths["basic_config"],
        paths["playwright"],
        paths["playwright_output"],
        paths["basic_notes"],
    )
    for directory in directories:
        ensure_safe_path(directory)
        if not apply:
            if not directory.is_dir() or directory.is_symlink():
                raise McpRuntimeError(f"missing native MCP directory: {directory}")
            continue
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        metadata = directory.lstat()
        if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
            raise McpRuntimeError(f"native MCP path is not a real directory: {directory}")
        directory.chmod(0o700)


def _children(path: Path, *, allow_symlinks: bool = False) -> list[Path]:
    """Return direct children only when the parent is a real directory."""
    try:
        metadata = path.lstat()
        if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
            return []
        return [entry for entry in path.iterdir() if allow_symlinks or not entry.is_symlink()]
    except (FileNotFoundError, NotADirectoryError, OSError):
        return []


def _has_basic_memory_runtime(profile_root: Path, version: str) -> bool:
    """Find the pinned Basic Memory package in the profile's uv cache."""
    paths = profile_paths(profile_root)
    for scope in _children(paths["uv_environments"]):
        for entry in _children(scope, allow_symlinks=True):
            try:
                metadata = entry.lstat()
                if stat.S_ISLNK(metadata.st_mode):
                    environment = entry.resolve(strict=True)
                    if environment.parent != paths["uv_archive"]:
                        continue
                elif stat.S_ISDIR(metadata.st_mode):
                    environment = entry
                else:
                    continue
                ensure_safe_path(environment, allow_missing=False)
                executable = environment / "bin" / "basic-memory"
                executable_metadata = executable.lstat()
                if not stat.S_ISREG(executable_metadata.st_mode) or not os.access(executable, os.X_OK):
                    continue
                for library in _children(environment / "lib"):
                    package = library / "site-packages" / f"basic_memory-{version}.dist-info"
                    if package.is_dir() and not package.is_symlink():
                        return True
            except (FileNotFoundError, OSError, RuntimeError):
                continue
    return False


def _native_command_environment(paths: dict[str, Path]) -> dict[str, str]:
    """Build the bounded native Basic Memory environment used by uvx checks."""
    uvx = resolve_runner("uvx", os.environ.get("OPENCODE_MCP_UVX_BIN"))
    environment = os.environ.copy()
    environment.update(
        {
            "BASIC_MEMORY_HOME": str(paths["basic_notes"]),
            "BASIC_MEMORY_CONFIG_DIR": str(paths["basic_config"]),
            "BASIC_MEMORY_DEFAULT_PROJECT": "computer-assistant",
            "BASIC_MEMORY_NO_PROMOS": "1",
            "PATH": f"{uvx.parent}:{environment.get('PATH', '/usr/local/bin:/usr/bin:/bin')}",
        }
    )
    return environment


def _has_native_basic_memory_runtime(version: str) -> bool:
    """Check the pinned Basic Memory package through the trusted uvx cache."""
    paths = native_paths()
    try:
        result = subprocess.run(
            [
                str(resolve_runner("uvx", os.environ.get("OPENCODE_MCP_UVX_BIN"))),
                "--offline",
                "--prerelease=allow",
                "--from",
                f"basic-memory=={version}",
                "basic-memory",
                "--version",
            ],
            check=False,
            capture_output=True,
            text=True,
            env=_native_command_environment(paths),
            timeout=45,
        )
    except (McpRuntimeError, OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0 and version in f"{result.stdout}\n{result.stderr}"


def _has_playwright_runtime(profile_root: Path, version: str) -> bool:
    """Find the pinned Playwright MCP package in the profile's npx cache."""
    paths = profile_paths(profile_root)
    for run in _children(paths["npx_cache"]):
        package = run / "node_modules" / "@playwright" / "mcp" / "package.json"
        try:
            if package.is_symlink() or not package.is_file():
                continue
            value = json.loads(package.read_text(encoding="utf-8"))
            if isinstance(value, dict) and value.get("version") == version:
                return True
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            continue
    return False


def _has_node_runtime(version: str, *, profile: str, profile_root: Path | None = None) -> bool:
    """Require the selected profile's trusted Node and npm at the pinned version."""
    try:
        node = resolve_runner(
            "node", os.environ.get("OPENCODE_MCP_NODE_BIN"), profile=profile, profile_root=profile_root
        )
        npm = resolve_runner(
            "npm", os.environ.get("OPENCODE_MCP_NPM_BIN"), profile=profile, profile_root=profile_root
        )
        environment = os.environ.copy()
        environment["PATH"] = f"{node.parent}:{environment.get('PATH', '')}"
        node_result = subprocess.run(
            [str(node), "--version"], check=False, capture_output=True, text=True, env=environment, timeout=10
        )
        npm_result = subprocess.run(
            [str(npm), "--version"], check=False, capture_output=True, text=True, env=environment, timeout=10
        )
    except (McpRuntimeError, OSError, subprocess.TimeoutExpired):
        return False
    return node_result.returncode == 0 and node_result.stdout.strip() == f"v{version}" and npm_result.returncode == 0


def _has_native_playwright_runtime(version: str) -> bool:
    """Check the locked repository Playwright package and trusted Node runtime."""
    project = CANONICAL_ROOT.parent / "browser-tools"
    package = project / "node_modules" / "@playwright" / "mcp" / "package.json"
    launcher = project / "node_modules" / ".bin" / "playwright-mcp"
    browser = project / "node_modules" / ".bin" / "playwright"
    try:
        value = json.loads(_read_regular(package, limit=256 * 1024).decode("utf-8"))
        package_version = value.get("version") if isinstance(value, dict) else None
        launcher_metadata = launcher.resolve(strict=True).lstat()
        browser_metadata = browser.resolve(strict=True).lstat()
    except (McpRuntimeError, UnicodeDecodeError, json.JSONDecodeError, OSError, RuntimeError):
        return False
    return (
        package_version == version
        and stat.S_ISREG(launcher_metadata.st_mode)
        and os.access(launcher, os.X_OK)
        and stat.S_ISREG(browser_metadata.st_mode)
        and os.access(browser, os.X_OK)
        and _has_node_runtime(str(load_policy()["nodeVersion"]), profile="native")
    )


def _has_browser(profile_root: Path | None, revision: int, *, profile: str) -> bool:
    browser_root = profile_paths(profile_root)["browser_cache"] if profile == "wsl2" and profile_root else native_paths()["browser_cache"]
    browser = browser_root / f"chromium-{revision}" / "chrome-linux64" / "chrome"
    try:
        metadata = browser.lstat()
    except FileNotFoundError:
        return False
    return stat.S_ISREG(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode) and os.access(browser, os.X_OK)


def _load_marker(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(_read_regular(path).decode("utf-8"), object_pairs_hook=_pairs)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise McpRuntimeError(f"cannot parse MCP provisioning marker: {error}") from error
    if not isinstance(value, dict):
        raise McpRuntimeError("MCP provisioning marker is not an object")
    return value


def _write_marker(path: Path, value: dict[str, Any]) -> None:
    ensure_safe_path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.exists() or path.is_symlink():
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
            raise McpRuntimeError(f"MCP marker is not a regular file: {path}")
        mode = stat.S_IMODE(metadata.st_mode)
    else:
        mode = 0o600
    temporary = path.parent / f".{path.name}.{secrets.token_hex(12)}.tmp"
    try:
        with temporary.open("x", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2)
            handle.write("\n")
        temporary.chmod(mode)
        os.replace(temporary, path)
    except OSError as error:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        raise McpRuntimeError(f"cannot write MCP provisioning marker: {error}") from error


def mcp_provisioning(
    profile_root: Path | None = None,
    *,
    profile: str = "native",
    apply: bool,
    quiet: bool = False,
) -> None:
    """Verify or record the exact local runtimes for one selected profile."""
    validate_profile(profile)
    expected = expected_marker(profile)
    if profile == "native":
        paths = native_paths()
        if profile_root is not None:
            raise McpRuntimeError("native MCP provisioning does not accept an isolated profile root")
        if apply:
            prepare_native(apply=True)
        elif _load_marker(paths["marker"]) != expected:
            raise McpRuntimeError("native MCP provisioning marker is missing or stale; rerun setup-mcps.sh --apply")
        if not _has_native_basic_memory_runtime(str(expected["basicMemory"])):
            raise McpRuntimeError("Basic Memory's canonical pinned native runtime is missing")
        if not _has_node_runtime(str(expected["nodeVersion"]), profile="native"):
            raise McpRuntimeError("the canonical pinned native Node.js runtime is missing")
        if not _has_native_playwright_runtime(str(expected["playwright"])):
            raise McpRuntimeError("Playwright MCP's canonical pinned native runtime is missing")
        if not _has_browser(None, int(expected["playwrightBrowserRevision"]), profile="native"):
            raise McpRuntimeError("the canonical pinned native Playwright browser is missing")
    else:
        if profile_root is None:
            raise McpRuntimeError("wsl2 MCP provisioning requires an isolated profile root")
        paths = profile_paths(profile_root)
        if apply:
            prepare_profile(profile_root, apply=True)
        elif _load_marker(paths["marker"]) != expected:
            raise McpRuntimeError("WSL2 MCP provisioning marker is missing or stale; rerun setup-mcps.sh --apply")
        if not _has_basic_memory_runtime(profile_root, str(expected["basicMemory"])):
            raise McpRuntimeError("Basic Memory's canonical pinned WSL2 runtime is missing")
        if not _has_node_runtime(str(expected["nodeVersion"]), profile="wsl2", profile_root=profile_root):
            raise McpRuntimeError("the canonical pinned WSL2 Node.js runtime is missing")
        if not _has_playwright_runtime(profile_root, str(expected["playwright"])):
            raise McpRuntimeError("Playwright MCP's canonical pinned WSL2 runtime is missing")
        if not _has_browser(profile_root, int(expected["playwrightBrowserRevision"]), profile="wsl2"):
            raise McpRuntimeError("the canonical pinned WSL2 Playwright browser is missing")
    if apply:
        _write_marker(paths["marker"], expected)
    if not quiet:
        print(f"OK: canonical {profile} MCP runtimes are provisioned: {paths['marker']}")


def _wrapper(name: str) -> Path:
    path = SCRIPT_ROOT / name
    try:
        metadata = path.lstat()
    except FileNotFoundError as error:
        raise McpRuntimeError(f"missing canonical MCP launcher: {path}") from error
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode) or not os.access(path, os.X_OK):
        raise McpRuntimeError(f"canonical MCP launcher is not a regular executable: {path}")
    return path


def mcp_servers(profile: str = "native", profile_root: Path | None = None) -> dict[str, dict[str, Any]]:
    """Return the one shared MCP declaration set for a native or WSL profile."""
    validate_profile(profile)
    policy = load_policy()
    basic = _wrapper("basic-memory-mcp.sh")
    playwright = _wrapper("playwright-mcp.sh")
    timeout = {"startup": 30_000}
    entries: dict[str, dict[str, Any]] = {
        "basic-memory": {"type": "local", "command": [NATIVE_BASIC_COMMAND], "disabled": False, "timeout": timeout.copy()},
        "github": {"type": "remote", "url": policy["githubRemote"], "disabled": False, "timeout": timeout.copy()},
        "playwright": {"type": "local", "command": [NATIVE_PLAYWRIGHT_COMMAND], "disabled": False, "timeout": timeout.copy()},
    }
    if profile == "native":
        if profile_root is not None:
            raise McpRuntimeError("native MCP declarations do not accept an isolated profile root")
        _wrapper("basic-memory-mcp.sh")
        _wrapper("playwright-mcp.sh")
        return entries
    if profile != "wsl2" or profile_root is None:
        raise McpRuntimeError(f"unsupported MCP profile: {profile}")
    root = ensure_safe_path(profile_root)
    environment = {
        "OPENCODE_MCP_PROFILE": "wsl2",
        "OPENCODE_MCP_PROFILE_ROOT": str(root),
    }
    for name in ("basic-memory", "playwright"):
        entries[name]["command"] = [str(basic if name == "basic-memory" else playwright)]
        entries[name]["cwd"] = str(root / "workspace")
        entries[name]["environment"] = environment
    return entries


def ensure_mcp_servers(data: dict[str, Any], *, profile: str, profile_root: Path | None = None) -> None:
    """Merge only the canonical MCP entries into one server config."""
    mcp = data.setdefault("mcp", {})
    if not isinstance(mcp, dict):
        raise McpRuntimeError("mcp must be an object")
    timeout = mcp.setdefault("timeout", {})
    if not isinstance(timeout, dict):
        raise McpRuntimeError("mcp.timeout must be an object")
    timeout.update({"startup": 90_000, "catalog": 30_000, "execution": 600_000})
    servers = mcp.setdefault("servers", {})
    if not isinstance(servers, dict):
        raise McpRuntimeError("mcp.servers must be an object")
    servers.update(mcp_servers(profile, profile_root))


def verify_mcp_servers(data: dict[str, Any], *, profile: str, profile_root: Path | None = None) -> None:
    """Require the exact shared declarations and reject credential fields."""
    mcp = data.get("mcp")
    servers = mcp.get("servers") if isinstance(mcp, dict) else None
    if not isinstance(servers, dict):
        raise McpRuntimeError("mcp.servers must be configured")
    expected = mcp_servers(profile, profile_root)
    if set(servers) != set(MCP_NAMES):
        raise McpRuntimeError(f"MCP server set is not exactly canonical: {sorted(servers)}")
    for name in MCP_NAMES:
        if servers.get(name) != expected[name]:
            raise McpRuntimeError(f"MCP server {name} is not exactly canonical")
    serialized = json.dumps({name: servers[name] for name in MCP_NAMES}).lower()
    for marker in ("authorization", "personal_access_token", "api_key", "client_secret", "bearer", "token"):
        if marker in serialized:
            raise McpRuntimeError(f"credential field is forbidden in canonical MCP configuration: {marker}")


def global_mcp_servers() -> dict[str, dict[str, Any]]:
    """Return native global declarations without project-owned Playwright."""
    entries = mcp_servers("native")
    entries["basic-memory"]["command"] = [str(_wrapper("basic-memory-mcp.sh"))]
    return {name: entries[name] for name in ("basic-memory", "github")}


def ensure_global_mcp_servers(data: dict[str, Any]) -> None:
    """Normalize only shared native global MCP entries and preserve unrelated servers."""
    mcp = data.setdefault("mcp", {})
    if not isinstance(mcp, dict):
        raise McpRuntimeError("mcp must be an object")
    for name in MCP_NAMES:
        mcp.pop(name, None)
    servers = mcp.setdefault("servers", {})
    if not isinstance(servers, dict):
        raise McpRuntimeError("mcp.servers must be an object")
    servers.pop("playwright", None)
    servers.update(global_mcp_servers())


def verify_global_mcp_servers(data: dict[str, Any]) -> None:
    """Require canonical global Basic Memory/GitHub entries and no Playwright copy."""
    mcp = data.get("mcp")
    servers = mcp.get("servers") if isinstance(mcp, dict) else None
    if not isinstance(servers, dict):
        raise McpRuntimeError("mcp.servers must be configured")
    if "playwright" in servers:
        raise McpRuntimeError("global MCP configuration must not duplicate project Playwright")
    expected = global_mcp_servers()
    for name, entry in expected.items():
        if servers.get(name) != entry:
            raise McpRuntimeError(f"global MCP server {name} is not exactly canonical")
    if any(name in mcp for name in MCP_NAMES):
        raise McpRuntimeError("legacy flat MCP declarations remain in global configuration")
    serialized = json.dumps({name: servers[name] for name in expected}).lower()
    for marker in ("authorization", "personal_access_token", "api_key", "client_secret", "bearer", "token"):
        if marker in serialized:
            raise McpRuntimeError(f"credential field is forbidden in canonical MCP configuration: {marker}")


def _config_helper() -> Any:
    """Load the repository's strict JSONC parser without creating another parser."""
    helper_path = SCRIPT_ROOT / "setup-opencode-jsonc.py"
    spec = importlib.util.spec_from_file_location("mcp_runtime_jsonc", helper_path)
    if spec is None or spec.loader is None:
        raise McpRuntimeError("cannot load strict JSONC helper")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_config(path: Path) -> dict[str, Any]:
    """Load one bounded regular OpenCode JSON/JSONC configuration object."""
    try:
        text = _read_regular(path, limit=MAX_CONFIG_BYTES).decode("utf-8")
        value = _config_helper().parse_jsonc(text)
    except (UnicodeDecodeError, ValueError) as error:
        raise McpRuntimeError(f"cannot parse OpenCode configuration {path}: {error}") from error
    if not isinstance(value, dict):
        raise McpRuntimeError(f"OpenCode configuration is not an object: {path}")
    return value


def write_config(path: Path, value: dict[str, Any]) -> None:
    """Atomically write one existing regular config without following symlinks."""
    absolute = _absolute(path)
    parent = absolute.parent
    current = Path("/")
    for part in parent.parts[1:]:
        current /= part
        metadata = current.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise McpRuntimeError(f"refusing unsafe configuration path ancestor: {current}")
    metadata = absolute.lstat()
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise McpRuntimeError(f"configuration target is not a regular file: {absolute}")
    encoded = (json.dumps(value, indent=2) + "\n").encode("utf-8")
    if len(encoded) > MAX_CONFIG_BYTES:
        raise McpRuntimeError("canonical MCP configuration exceeds the bounded size")
    temporary = parent / f".{absolute.name}.{secrets.token_hex(12)}.tmp"
    try:
        with temporary.open("xb") as handle:
            handle.write(encoded)
        temporary.chmod(stat.S_IMODE(metadata.st_mode))
        os.replace(temporary, absolute)
    except OSError as error:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        raise McpRuntimeError(f"cannot write OpenCode configuration {absolute}: {error}") from error


def configure_mcp_file(path: Path, *, scope: str, apply: bool) -> None:
    """Verify or normalize one selected MCP configuration scope."""
    data = load_config(path)
    if scope == "project":
        if apply:
            raise McpRuntimeError("the portable project configuration is verification-only")
        verify_mcp_servers(data, profile="native")
        return
    if scope != "global":
        raise McpRuntimeError(f"unsupported MCP configuration scope: {scope}")
    if apply:
        ensure_global_mcp_servers(data)
        write_config(path, data)
    verify_global_mcp_servers(data)


def verify_basic_memory_project(config_path: Path, *, project: str, notes: Path) -> None:
    """Require one local Basic Memory project to resolve to the selected notes root."""
    if not project or project.strip() != project:
        raise McpRuntimeError("Basic Memory project name must be non-empty without surrounding whitespace")
    expected_notes = ensure_safe_path(notes, allow_missing=False)
    try:
        value = json.loads(
            _read_regular(config_path, limit=MAX_CONFIG_BYTES).decode("utf-8"),
            object_pairs_hook=_pairs,
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise McpRuntimeError(f"cannot parse Basic Memory configuration {config_path}: {error}") from error
    if not isinstance(value, dict):
        raise McpRuntimeError(f"Basic Memory configuration is not an object: {config_path}")
    projects = value.get("projects")
    entry = projects.get(project) if isinstance(projects, dict) else None
    if not isinstance(entry, dict):
        raise McpRuntimeError(f"Basic Memory project is not registered: {project}")
    configured_path = entry.get("path")
    if not isinstance(configured_path, str):
        raise McpRuntimeError(f"Basic Memory project path is invalid: {project}")
    if ensure_safe_path(Path(configured_path), allow_missing=False) != expected_notes:
        raise McpRuntimeError(f"Basic Memory project {project} does not use the canonical notes root")
    if entry.get("mode") != "local":
        raise McpRuntimeError(f"Basic Memory project {project} is not local")
    if value.get("default_project") != project:
        raise McpRuntimeError(f"Basic Memory project {project} is not the default")


def _runner_candidates(kind: str, *, profile: str, profile_root: Path | None = None) -> list[Path]:
    """Return runners owned by the selected profile without cross-profile fallback."""
    validate_profile(profile)
    home = Path.home()
    if profile == "native":
        node_bin = native_paths()["node_root"] / "bin"
    else:
        if profile_root is None:
            raise McpRuntimeError("WSL2 runner resolution requires an isolated profile root")
        node_bin = profile_paths(profile_root)["node_root"] / "bin"
    values = {
        "uvx": (home / ".local/bin/uvx", Path("/usr/local/bin/uvx"), Path("/usr/bin/uvx")),
        "npx": (node_bin / "npx",),
        "npm": (node_bin / "npm",),
        "node": (node_bin / "node",),
    }
    if kind not in values:
        raise McpRuntimeError(f"unsupported trusted MCP runner: {kind}")
    return list(values[kind])


def resolve_runner(
    kind: str,
    override: str | None = None,
    *,
    profile: str = "native",
    profile_root: Path | None = None,
) -> Path:
    """Select an absolute executable owned by root/current user and not writable."""
    canonical = _runner_candidates(kind, profile=profile, profile_root=profile_root)
    candidates = [Path(override)] if override else canonical
    user_id = os.getuid()
    for candidate in candidates:
        if not candidate.is_absolute():
            continue
        try:
            resolved = candidate.resolve(strict=True)
            metadata = resolved.lstat()
        except (FileNotFoundError, OSError, RuntimeError):
            continue
        if not stat.S_ISREG(metadata.st_mode) or not os.access(resolved, os.X_OK):
            continue
        if metadata.st_uid not in (0, user_id) or stat.S_IMODE(metadata.st_mode) & 0o022:
            continue
        if kind in ("node", "npm", "npx"):
            try:
                expected = canonical[0].resolve(strict=False)
            except (OSError, RuntimeError):
                continue
            if resolved != expected:
                continue
        return resolved
    raise McpRuntimeError(f"{kind} is required at an absolute regular executable path owned by root or the current user")


def ensure_node(*, profile: str, profile_root: Path | None = None, apply: bool) -> Path:
    """Return or install the selected profile's checksum-pinned Node release."""
    validate_profile(profile)
    if profile == "native":
        if profile_root is not None:
            raise McpRuntimeError("native Node.js provisioning does not accept an isolated profile root")
        paths = native_paths()
    else:
        if profile_root is None:
            raise McpRuntimeError("WSL2 Node.js provisioning requires an isolated profile root")
        paths = profile_paths(profile_root)
    policy = load_policy()
    try:
        node = resolve_runner(
            "node",
            os.environ.get("OPENCODE_MCP_NODE_BIN"),
            profile=profile,
            profile_root=profile_root,
        )
        if _has_node_runtime(str(policy["nodeVersion"]), profile=profile, profile_root=profile_root):
            return node
    except McpRuntimeError:
        node = None
    if not apply:
        raise McpRuntimeError(
            f"trusted Node.js {policy['nodeVersion']} is unavailable; rerun setup-mcps.sh --apply"
        )
    root = paths["node_root"]
    ensure_safe_path(root)
    if root.exists() or root.is_symlink():
        raise McpRuntimeError(f"pinned Node.js target exists but is not usable: {root}")
    root.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    archive_name = str(policy["nodeArchive"])
    temporary_root = Path(tempfile.mkdtemp(prefix="node-runtime-", dir=str(root.parent)))
    archive_path = temporary_root / archive_name
    extract_root = temporary_root / "extract"
    try:
        with urlopen(str(policy["nodeUrl"]), timeout=90) as response, archive_path.open("wb") as handle:
            digest = hashlib.sha256()
            total = 0
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_NODE_ARCHIVE_BYTES:
                    raise McpRuntimeError("pinned Node.js archive exceeds the bounded download size")
                digest.update(chunk)
                handle.write(chunk)
        if digest.hexdigest() != str(policy["nodeSha256"]):
            raise McpRuntimeError("pinned Node.js archive checksum does not match the published policy")
        extract_root.mkdir(mode=0o700)
        with tarfile.open(archive_path, mode="r:*") as archive:
            members = archive.getmembers()
            for member in members:
                name = Path(member.name)
                if name.is_absolute() or ".." in name.parts:
                    raise McpRuntimeError("pinned Node.js archive contains an unsafe member")
            archive.extractall(extract_root, filter="data")
        extracted = extract_root / f"node-v{policy['nodeVersion']}-linux-x64"
        if not extracted.is_dir() or extracted.is_symlink():
            raise McpRuntimeError("pinned Node.js archive has an unexpected top-level directory")
        os.replace(extracted, root)
    except (OSError, EOFError, tarfile.TarError, ValueError) as error:
        raise McpRuntimeError(f"cannot install pinned Node.js {policy['nodeVersion']}: {error}") from error
    finally:
        shutil.rmtree(temporary_root, ignore_errors=True)
    node = resolve_runner(
        "node", str(root / "bin" / "node"), profile=profile, profile_root=profile_root
    )
    if not _has_node_runtime(str(policy["nodeVersion"]), profile=profile, profile_root=profile_root):
        raise McpRuntimeError("installed Node.js runtime failed its executable/version verification")
    return node


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "action",
        choices=("policy", "prepare", "mcp-runtime", "runner", "node-runtime", "config", "basic-project"),
    )
    parser.add_argument("--profile", default="native")
    parser.add_argument("--profile-root", type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--kind", choices=("uvx", "npx", "npm", "node"))
    parser.add_argument("--override")
    parser.add_argument("--config", type=Path)
    parser.add_argument("--scope", choices=("global", "project"))
    parser.add_argument("--notes", type=Path)
    parser.add_argument("--project")
    args = parser.parse_args()
    try:
        validate_profile(args.profile)
        if args.action == "policy":
            policy = load_policy()
            if args.kind:
                key = {"uvx": "basicMemory", "npx": "playwright", "npm": "nodeVersion", "node": "nodeVersion"}[args.kind]
                print(policy[key])
            else:
                print(json.dumps(policy, sort_keys=True))
        elif args.action == "runner":
            if args.kind is None:
                raise McpRuntimeError("--kind is required for runner resolution")
            print(
                resolve_runner(
                    args.kind,
                    args.override,
                    profile=args.profile,
                    profile_root=args.profile_root,
                )
            )
        elif args.action == "prepare":
            if args.profile == "native":
                if args.profile_root is not None:
                    raise McpRuntimeError("native MCP preparation does not accept an isolated profile root")
                prepare_native(apply=args.apply)
                target = native_paths()["root"]
            else:
                if args.profile_root is None:
                    raise McpRuntimeError("--profile-root is required for the WSL2 profile")
                prepare_profile(args.profile_root, apply=args.apply)
                target = _absolute(args.profile_root)
            if not args.quiet:
                print(f"OK: canonical {args.profile} MCP profile path is ready: {target}")
        elif args.action == "node-runtime":
            node = ensure_node(profile=args.profile, profile_root=args.profile_root, apply=args.apply)
            if not args.quiet:
                print(f"OK: trusted Node.js runtime: {node}")
        elif args.action == "config":
            if args.config is None or args.scope is None:
                raise McpRuntimeError("config requires --config and --scope")
            configure_mcp_file(args.config, scope=args.scope, apply=args.apply)
            if not args.quiet:
                print(f"OK: canonical {args.scope} MCP configuration: {_absolute(args.config)}")
        elif args.action == "basic-project":
            if args.config is None or args.notes is None or args.project is None:
                raise McpRuntimeError("basic-project requires --config, --notes, and --project")
            verify_basic_memory_project(args.config, project=args.project, notes=args.notes)
            if not args.quiet:
                print(f"OK: Basic Memory project {args.project}: {_absolute(args.notes)}")
        else:
            mcp_provisioning(
                args.profile_root,
                profile=args.profile,
                apply=args.apply,
                quiet=args.quiet,
            )
    except McpRuntimeError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
