# `mcp_runtime.py`

`mcp_runtime.py` is the canonical generic MCP policy and isolated-runtime
boundary for native Ubuntu and Ubuntu-on-WSL2. It owns the single checked-in
version policy at
`platforms/linux/ubuntu/computer-use/config/mcp-versions.json`:

- Basic Memory `0.23.2`;
- the pinned Playwright MCP and browser revision; and
- GitHub's hosted OAuth endpoint
  `https://api.githubcopilot.com/mcp/`.

WSL imports this module only to delegate generic declarations and runtime
verification. It passes its pilot root, so Basic Memory home/notes/uv cache and
Playwright home/output/npm/browser cache remain isolated from native Ubuntu.

## Commands

```bash
python3 platforms/linux/ubuntu/computer-use/scripts/mcp_runtime.py \
  mcp-runtime --profile wsl2 --profile-root "$HOME/.opencode-wsl2-pilot"
python3 platforms/linux/ubuntu/computer-use/scripts/mcp_runtime.py \
  prepare --profile wsl2 --profile-root "$HOME/.opencode-wsl2-pilot" --apply
```

Verification is read-only. Applying creates only private profile directories
and the exact provisioning marker after both local runtimes and the pinned
browser are found. Marker, package, browser, regular-file, and symlink checks
fail closed.

Trusted `uvx`, `npx`, and Node runners must be absolute regular executables
owned by root or the current user and must not be group/world writable. WSL's
thin `setup-mcps.sh` delegates provisioning to this canonical boundary.
