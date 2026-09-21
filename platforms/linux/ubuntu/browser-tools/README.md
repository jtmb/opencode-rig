# Browser Tools for Linux Ubuntu

Pinned browser automation runtime used by OpenCode's live Playwright MCP and by
explicitly requested bounded headless tasks on Ubuntu. This component was
consolidated from the former `~/repos/opencode-browser-tools/` directory.

## Source

- `package.json` declares the private `@playwright/mcp` dependency.
- `package-lock.json` pins the complete npm dependency graph.
- `node_modules/` and `browsers/` are generated locally and ignored by Git.

There was no Git history or unique authored source in the former directory to
import beyond these manifests.

## Integration

The sibling computer-use integration uses this runtime in two isolated modes:

```text
../computer-use/scripts/playwright-mcp.sh  # visible live MCP window
playwright from node_modules              # bounded headless shell script
```

The live window is shared by the user and agent during an OpenCode session and
remains separate from the user's normal Firefox profile. Headless work is never
registered as a second MCP: the `browser-headless` skill runs a bounded Node
script against this package and closes its isolated context when finished.
Transient output stays under `/tmp/opencode/`.

Provision and verify it through the Ubuntu setup script rather than invoking
the generated MCP executable directly:

```bash
./platforms/linux/ubuntu/computer-use/scripts/setup-computer-assistant.sh --apply
./platforms/linux/ubuntu/computer-use/scripts/setup-computer-assistant.sh --verify-only
```

Version changes must update both npm manifests and `BROWSER_MCP_VERSION` in
`../computer-use/scripts/setup-computer-assistant.sh`, followed by a real
Firefox smoke test.
