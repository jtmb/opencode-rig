#!/usr/bin/env python3
"""Verify isolated built-in web search configuration and optional TLS access."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import ssl
import urllib.request

import configure


PROBE_URL = "https://opencode.ai/v2/docs/websearch/"


def verify_config(config_dir: Path) -> None:
    """Verify exact random-provider and ask-permission configuration."""
    server_path, _ = configure.config_paths(config_dir)
    server = configure.load_json(server_path)
    if server.get("websearch") != {"provider": "random"}:
        raise configure.ConfigError("websearch must be exactly configured with provider=random")
    rules = [
        rule
        for rule in server.get("permissions", [])
        if isinstance(rule, dict)
        and rule.get("action") == "websearch"
    ]
    if rules != [{"action": "websearch", "resource": "*", "effect": "ask"}]:
        raise configure.ConfigError("websearch requires one authoritative resource=* ask rule")
    print(f"OK: built-in websearch is configured for random provider with ask permission: {server_path}")


def verify_network() -> None:
    """Verify DNS/proxy/CA/TLS access without provider credentials."""
    request = urllib.request.Request(PROBE_URL, headers={"User-Agent": "Open-Rig-WSL2-Verification/1"})
    context = ssl.create_default_context()
    with urllib.request.urlopen(request, timeout=10, context=context) as response:
        if response.status != 200:
            raise configure.ConfigError(f"websearch network probe returned HTTP {response.status}")
        response.read(1024)
    proxy = any(os.environ.get(name) for name in ("HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"))
    custom_ca = any(os.environ.get(name) for name in ("SSL_CERT_FILE", "SSL_CERT_DIR"))
    print(f"OK: TLS web access passed (proxy_configured={str(proxy).lower()}, custom_ca_configured={str(custom_ca).lower()})")
    print("NOTE: provider authentication and a real search still require an approved OpenCode websearch call in the live TUI.")


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--config-dir", type=Path, required=True)
    parser.add_argument("--network", action="store_true")
    return parser.parse_args()


def main() -> int:
    """Run selected web search checks."""
    args = parse_args()
    try:
        verify_config(args.config_dir)
        if args.network:
            verify_network()
    except (configure.ConfigError, OSError) as error:
        print(f"ERROR: {error}", file=os.sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
