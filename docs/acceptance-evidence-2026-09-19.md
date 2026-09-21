# Open Rig live acceptance evidence — 2026-09-19

These records came from the isolated OpenCode v2.0.7 pilot in this repository.
Rendered evidence is bounded `screen_terminal` text captured from the real TUI;
interaction evidence records the input and the observed post-action state.

## Visible commands

| Surface | Rendered result | Interaction result |
|---|---|---|
| `/session-context` | `status: "ok"`, current project ID, untrusted-history notice, and same-project child rows | Opened from the command palette after the shared-service restart; Escape returned to the session |
| `/learn` | `learn status: paused, 0 episodes retained (30d), structured summaries only` | Opened from the command palette; Escape returned to the session |
| `/subagents` | Fullscreen rows included resolved values such as `General · openai/gpt-5.6-luna#max` | Opened from the command palette; Escape returned to the session |
| `/tools` | Bounded Open Rig tool catalog dialog rendered in the restarted TUI | Opened from the command palette; Escape returned to the session |

## Fullscreen and sidebar surfaces

| Surface | Rendered result | Interaction result |
|---|---|---|
| System resources | Intel i5-6200U, 2 physical / 4 logical cores, RAM, swap, `/`, `/boot/efi`, and removable-storage rows | Opened `System resources`; Escape closed the fullscreen panel |
| Provider Usage | Codex `READY` with weekly remaining, DeepSeek `EMPTY`, OpenCode Go `OFFLINE` / not in catalog, OpenCode Zen `READY` / available | Expanded in the sidebar after restart; rows remained visible beside Source Control |
| Source Control diff | `Uncommitted · ...HEAD 0/402` with a rendered patch and file tree | Clicked `.githooks/pre-push`; the deployed `diffs.source: "working"` default opened Uncommitted directly; Escape returned to the session |
| Fullscreen repository Explorer | At 140×60, `/explorer` rendered the native-style two-pane layout with the complete safe repository tree and 410 working-tree changes. The initial all-changes view showed split patches; selecting clean `.gitignore` showed syntax-highlighted source, selecting modified `AGENTS.md` showed its split diff, and deleted `docs/migration/opencode-v2.md` automatically used the full content width | The sidebar and `/explorer` opened fullscreen. Mouse selection switched clean/diff content, `e` entered the preserved editor, Escape returned to viewing, and `d` opened the working-tree/main-branch/last-turn source selector. The clickable `[Diff: side by side]` header control changed the all-changes view to `[Diff: full width]`; `v` remains the keyboard equivalent |
| Integrated browser controller | After explicit installation approval, pinned Chromium 153.0.8010.12 revision 1243 opened a separate headed window at 1280×720. The tool returned a rendered JPEG and an ARIA snapshot containing the `Example Domain` heading and `Learn more` link. The fullscreen controller rendered `ready · 1 tab · tab-1`, `Example Domain`, enabled controls, and the same bounded snapshot | The tool launched `https://example.com/`, clicked `Learn more` by accessible role/name, and reached IANA's `Example Domains` page. The fullscreen controller independently launched Example Domain from its URL prompt, rendered the snapshot, confirmed close, returned to `stopped · 0 tabs`, and removed the Chrome application |
| Explorer-first sidebar without Context | After the corrected TUI restart, the 140×60 sidebar rendered Explorer first, no Context section, `- MCP` with connected Basic Memory/GitHub/Playwright rows, `Active subagents 1`, animated `running · General`, `Model · openai/gpt-5.6-luna#max`, and Todo. Earlier 99-column evidence retained the no-spinner fallback | Clicking Explorer opened the real fullscreen panel; clicking the active row opened the real child; Todo collapsed; the MCP header collapsed to `+ MCP (3 active)` and expanded again. Native `/mcps` remains the management surface |

## Runtime and package evidence

- Authenticated `/api/info`: OpenCode `2.0.7`; final verified restart PID
  `2776129`.
- Runtime status after deployment: 92 active plugins, zero failed; Basic Memory,
  GitHub, and Playwright MCPs connected.
- Focused checks: `rig-tools` 111 tests, `file-manager` 69 with three documented
  native-render skips, `rig-todo` 9, `repo-learning` 78,
  `integrated-browser` 13, `source-control` 21, `codex-usage` 16,
  `resource-monitor` 20, and `orchestration-policy` 27 after mandatory-task,
  correction-ledger, child-binding, replacement, and capacity regressions.
- Background fixtures were launched only after memory-capacity approval. Parent
  follow-up independently reviewed and accepted `ses_f44b15357ffee1f7Z2Q0hLm6gH`,
  `ses_f44aa8295ffefkliV5bUxEYhf2`, `ses_f44a6c0f3ffeJGj4giCfU8PQkc`, and
  live-row fixtures `ses_f4498a00dffeaUMUUZQnp8XoK8` and
  `ses_f446bf73fffes1He3Q114T6EXB`; corrected-layout fixtures
  `ses_f442c477effePbpyyAp4Bt6XTp` and `ses_f442b3acdffeB4Wxc61DpGVCq4`
  were likewise reviewed after completion.
- Mandatory delegation live acceptance bound replacement child
  `ses_f3f3d5ee2ffeMbGbZ6kVXTltKp`, persisted terminal state, and recorded an
  accepted parent follow-up only after canonical QA passed. Earlier unbound or
  `changes_required` children did not unlock the task. Shared-service restart
  retained the accepted child and all three correction-ledger acknowledgements;
  OpenCode 2.0.7 returned as PID `70902` with 92 active plugins and zero failed.
- Repository QA now emits visible `checking`, `running`, `verifying`, and
  `complete` status while retaining bounded evidence and the apply-time rerun.

## Browser boundary

The pinned Chromium runtime is isolated under the OpenCode pilot cache and uses
temporary per-session contexts. It remains a separate headed window because
OpenCode v2.0.7 exposes no supported native webview. It does not use the normal
browser profile, modify the system browser, replace the Firefox Playwright MCP,
or patch an installed OpenCode binary.
