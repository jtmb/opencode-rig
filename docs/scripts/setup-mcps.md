# Canonical `setup-mcps.sh`

The Ubuntu computer-use `scripts/setup-mcps.sh` provisions and verifies the
profile-aware Basic Memory and GitHub runtimes. The repository-owned ChatGPT
connector uses the same profile's pinned Node.js and OpenCode's active OAuth
connection without a separate server download or API-key fallback. The WSL2
script delegates to this generic provisioning entry point with
`OPENCODE_MCP_PROFILE=wsl2` and the WSL pilot root.

```bash
platforms/linux/ubuntu/computer-use/scripts/setup-mcps.sh \
  --profile wsl2 --profile-root "$HOME/.opencode-wsl2-pilot" --verify-only
platforms/linux/ubuntu/computer-use/scripts/setup-mcps.sh \
  --profile wsl2 --profile-root "$HOME/.opencode-wsl2-pilot" --apply
```

`--verify-only` checks the canonical marker, Basic Memory project registration,
exact package versions, profile-owned Node.js `22.22.2`, the pinned GitHub
binary, and the existing `gh` login without
provisioning or changing profile files. `--apply`:

1. creates the selected private directories;
2. downloads and checksum-verifies the pinned Node archive when needed;
3. provisions `basic-memory==0.23.2` with prerelease dependencies enabled and
   registers the local `computer-assistant` project;
4. downloads, checksum-verifies, safely extracts, and version-checks GitHub MCP
   Server `1.12.1` below the selected profile;
5. verifies authentication through the existing `gh` session without printing
   or persisting its token; and
6. writes the exact marker atomically only after all runtime checks pass.

The portable project and native/WSL global configs use exactly
`basic-memory`, `github`, and `chatgpt`. Playwright MCP and Chrome-for-Testing
provisioning have been removed. WSL browser actions use the Windows-default-
browser connector with Playwright-like tools in place of that project-only MCP;
live browser capability remains unverified until bounded probes pass.

The native path never changes the repository `opencode.json`; that portable
project config is verified separately and byte-preservation is covered by the
disposable setup self-test. ChatGPT OAuth remains in OpenCode's connection
store; there is no API-key fallback. GitHub token/control environment overrides
are rejected, and authentication comes only from `gh auth token` at process
start.
