# Canonical `setup-mcps.sh`

The Ubuntu computer-use `scripts/setup-mcps.sh` provisions and verifies the
profile-aware Basic Memory and Playwright runtimes. It is the only generic MCP
provisioning entry point; the WSL2 script delegates to it with
`OPENCODE_MCP_PROFILE=wsl2` and the WSL pilot root.

```bash
platforms/linux/ubuntu/computer-use/scripts/setup-mcps.sh \
  --profile wsl2 --profile-root "$HOME/.opencode-wsl2-pilot" --verify-only
platforms/linux/ubuntu/computer-use/scripts/setup-mcps.sh \
  --profile wsl2 --profile-root "$HOME/.opencode-wsl2-pilot" --apply
```

`--verify-only` checks the canonical marker, exact package versions, and pinned
browser without provisioning. `--apply` uses the canonical profile-aware
launchers with trusted user runners, then writes the marker atomically. GitHub
is remote OAuth and has no local provisioning phase; authenticate it through
OpenCode's `/mcps` screen.
