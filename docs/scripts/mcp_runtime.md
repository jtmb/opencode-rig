# `mcp_runtime.py`

`mcp_runtime.py` is the canonical generic MCP policy and isolated-runtime
boundary for native Ubuntu and Ubuntu-on-WSL2. It owns the single checked-in
version policy at
`platforms/linux/ubuntu/computer-use/config/mcp-versions.json`:

- Basic Memory `0.23.2`;
- GitHub MCP Server `1.12.1`, archive
  `github-mcp-server_Linux_x86_64.tar.gz`, and its published SHA-256; and
- checksum-verified profile-owned Node.js `22.22.2`, used by the repository's
  local ChatGPT MCP connector.

WSL imports this module only to delegate generic declarations and runtime
verification. It passes its pilot root, so Basic Memory home/notes/uv cache,
the GitHub binary, and the Node runtime remain isolated from native Ubuntu.

Both the portable project and native/WSL global profiles declare exactly
`basic-memory`, `github`, and `chatgpt`. ChatGPT resolves the active OpenAI OAuth
connection through OpenCode and has no API-key fallback. WSL browser actions use
the Windows-default-browser connector with Playwright-like tools instead of the
former project-only Playwright MCP or Chrome-for-Testing runtime; live browser
capability remains unverified until bounded probes pass.

## Commands

```bash
python3 platforms/linux/ubuntu/computer-use/scripts/mcp_runtime.py \
  mcp-runtime --profile wsl2 --profile-root "$HOME/.opencode-wsl2-pilot"
python3 platforms/linux/ubuntu/computer-use/scripts/mcp_runtime.py \
  prepare --profile wsl2 --profile-root "$HOME/.opencode-wsl2-pilot" --apply
python3 platforms/linux/ubuntu/computer-use/scripts/mcp_runtime.py \
  github-runtime --profile wsl2 --profile-root "$HOME/.opencode-wsl2-pilot" --apply
python3 platforms/linux/ubuntu/computer-use/scripts/mcp_runtime.py \
  basic-project --config "$HOME/.opencode-wsl2-pilot/mcp/basic-memory/home/config.json" \
  --notes "$HOME/.opencode-wsl2-pilot/mcp/basic-memory/notes" \
  --project computer-assistant
```

Verification is read-only. Applying creates only private profile directories
and the exact provisioning marker after the Basic Memory and GitHub runtimes and
profile-owned Node runtime are found. The ChatGPT wrapper uses that Node runtime
and the active OpenCode OAuth connection; it is not a downloaded MCP package.
The GitHub archive
is checksum-verified and extracted through an exact three-file allowlist; only
the bounded regular `github-mcp-server` member is installed at mode `0700`.
Executable ownership, write permissions, and the embedded version are rechecked
before use. The Basic Memory project check
also requires a local project at the exact selected notes root and, unless
`--allow-non-default` is used during repair detection, requires it to be the
default. Marker, package, project, regular-file, and symlink checks fail closed.

Trusted `uvx`, `gh`, and Node runners must be absolute regular executables
owned by root or the current user and must not be group/world writable. WSL's
thin `setup-mcps.sh` delegates provisioning to this canonical boundary.

Node installation downloads only the HTTPS URL declared in the policy, caps
the archive at 256 MiB, verifies its SHA-256 before extraction, rejects unsafe
archive paths, and installs under the selected profile. Runtime resolution has
no system-Node or cross-profile fallback.

`mcp-runtime-self-test.py` uses disposable archives and fake executables to
cover checksums, archive allowlisting, version rejection, symlink preservation,
native/WSL path isolation, `gh`-session authentication, and rejection of
inherited token/control variables without exposing a credential.
