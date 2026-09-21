#!/usr/bin/env python3
"""Validate and normalize the OpenCode v2 plugin role catalog."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from typing import Any


ALLOWED_ROLES = ("server", "cli")
EXPECTED_CONFIG = {"server": "opencode.jsonc", "cli": "cli.json"}
NAME_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


class CatalogError(ValueError):
    """Raised when the catalog cannot be used safely."""


def _relative_path(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise CatalogError(f"{label} must be a non-empty string")
    if "\\" in value or "\t" in value or "\n" in value:
        raise CatalogError(f"{label} contains an unsafe character")
    if os.path.isabs(value):
        raise CatalogError(f"{label} must be relative")
    normalized = os.path.normpath(value)
    parts = normalized.split(os.sep)
    if normalized != value or not parts or any(part in ("", ".", "..") for part in parts):
        raise CatalogError(f"{label} is not a canonical relative path: {value!r}")
    return normalized


def _inside(path: str, directory: str) -> bool:
    try:
        return os.path.commonpath((path, directory)) == directory
    except ValueError:
        return False


def load_catalog(catalog_path: str, computer_use_root: str) -> dict[str, Any]:
    try:
        with open(catalog_path, encoding="utf-8") as handle:
            raw = json.load(handle)
    except (OSError, ValueError) as error:
        raise CatalogError(f"cannot read catalog {catalog_path}: {error}") from error

    if not isinstance(raw, dict) or raw.get("version") != 1:
        raise CatalogError("catalog must be an object with version 1")
    plugins = raw.get("plugins")
    if not isinstance(plugins, list) or not plugins:
        raise CatalogError("catalog plugins must be a non-empty list")

    root = os.path.realpath(computer_use_root)
    plugin_root = os.path.realpath(os.path.join(root, "plugins-v2"))
    names: set[str] = set()
    packages: set[str] = set()
    roles_seen: set[str] = set()
    normalized_plugins: list[dict[str, Any]] = []

    for index, item in enumerate(plugins):
        label = f"plugins[{index}]"
        if not isinstance(item, dict):
            raise CatalogError(f"{label} must be an object")
        name = item.get("name")
        if not isinstance(name, str) or not NAME_PATTERN.fullmatch(name):
            raise CatalogError(f"{label}.name is not a safe package name")
        if name in names:
            raise CatalogError(f"duplicate package name: {name}")
        names.add(name)

        relative_package = _relative_path(item.get("path"), f"{label}.path")
        if not relative_package.startswith("plugins-v2/"):
            raise CatalogError(f"{label}.path must be under plugins-v2/")
        package = os.path.realpath(os.path.join(root, relative_package))
        if not _inside(package, plugin_root) or os.path.basename(package) != name:
            raise CatalogError(f"{label}.path escapes plugins-v2 or does not match its name")
        if package in packages:
            raise CatalogError(f"duplicate package path: {package}")
        packages.add(package)
        if not os.path.isdir(package):
            raise CatalogError(f"package directory missing: {package}")

        roles = item.get("roles")
        if not isinstance(roles, dict) or not roles:
            raise CatalogError(f"{label}.roles must be a non-empty object")
        normalized_roles: dict[str, dict[str, str]] = {}
        for role, descriptor in roles.items():
            if role not in ALLOWED_ROLES:
                raise CatalogError(f"{label}.roles contains unsupported role: {role}")
            roles_seen.add(role)
            if not isinstance(descriptor, dict):
                raise CatalogError(f"{label}.roles.{role} must be an object")
            entrypoint = _relative_path(
                descriptor.get("entrypoint"), f"{label}.roles.{role}.entrypoint"
            )
            config = descriptor.get("config")
            if config != EXPECTED_CONFIG[role]:
                raise CatalogError(
                    f"{label}.roles.{role}.config must be {EXPECTED_CONFIG[role]!r}"
                )
            entrypoint_path = os.path.realpath(os.path.join(package, entrypoint))
            if not _inside(entrypoint_path, package) or not os.path.isfile(entrypoint_path):
                raise CatalogError(
                    f"role entrypoint missing or outside package: {package}/{entrypoint}"
                )
            normalized_roles[role] = {
                "entrypoint": entrypoint_path,
                "config": config,
            }

        normalized_plugins.append(
            {"name": name, "package": package, "roles": normalized_roles}
        )

    missing_roles = [role for role in ALLOWED_ROLES if role not in roles_seen]
    if missing_roles:
        raise CatalogError(f"catalog has no package for role: {', '.join(missing_roles)}")

    return {"version": 1, "plugins": normalized_plugins}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", required=True, help="catalog JSON path")
    parser.add_argument(
        "--root", required=True, help="computer-use root containing plugins-v2"
    )
    output = parser.add_mutually_exclusive_group()
    output.add_argument("--json", action="store_true", help="print normalized JSON")
    output.add_argument("--rows", action="store_true", help="print tab-separated role rows")
    args = parser.parse_args(argv)

    try:
        catalog = load_catalog(args.catalog, args.root)
    except CatalogError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1

    if args.rows:
        for plugin in catalog["plugins"]:
            for role, descriptor in plugin["roles"].items():
                print(
                    "\t".join(
                        (
                            plugin["name"],
                            role,
                            plugin["package"],
                            descriptor["entrypoint"],
                            descriptor["config"],
                        )
                    )
                )
    elif args.json:
        print(json.dumps(catalog, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
