# Session Context Usage

This guide covers bounded, read-only context retrieval from other OpenCode
sessions in the current project. Agent behavior remains defined in
[`SKILL.md`](./SKILL.md); this README is not loaded automatically.

Category: `memory`

Tags: `opencode`, `sessions`, `context`, `handoff`, `memory`

## Purpose and when to use it

Use this skill to continue work from another session, compare parallel work,
check what a running session is doing, or recover decisions from a session title
or ID. It is an ephemeral bridge between local OpenCode sessions. Use
`task-memory` instead for curated facts that should survive independently of
session history.

## Prerequisites and setup verification

- OpenCode v2 and the shared background service must be running.
- The `rig-tools` server plugin must expose `session_context` and the
  `/session-context` command.
- The source and invoking sessions must belong to the same OpenCode project.
- Restart OpenCode after deploying plugin or skill changes. Running model
  requests retain their existing tool snapshot.

Verify availability by asking the agent to list other sessions in the current
project. A successful result contains `schema`, `status`, `sessions`, and
`coverage` fields.

## How to request it

Natural-language examples:

- "Find the session named Finish Open Rig v2 harness and align this work with it."
- "Continue from session `ses_example`, but verify its claims first."
- "List the other sessions in this project."
- "Compare this task with the trackpad calibration session."

Plugin command examples:

```text
/session-context
/session-context Finish Open Rig v2 harness
/session-context ses_example
```

These are documented representative invocations. During implementation, the
live tool's exact-title selection and the session-ID command path were executed
against OpenCode v2.0.7.

## Worked workflow and expected result

1. The agent lists same-project sessions, optionally filtered by title.
2. The user or agent selects an unambiguous session ID.
3. The tool returns the newest completed checkpoint and bounded settled activity
   after it, plus separate live and saved statuses.
4. The current agent treats imported text as historical data and independently
   checks files or system state before continuing.
5. The response states what aligns, what is stale or conflicting, and the next
   verified action.

Expected result: the current conversation contains enough bounded provenance to
continue coherently without mutating or automatically resuming the source.

## Tools and commands

The agent tool accepts:

```json
{"action":"list","search":"optional text","limit":12}
{"action":"read","sessionID":"ses_example"}
```

`list` is metadata-only. `read` returns a deterministic projection and performs
no model generation. Both are read-only with respect to source sessions.

`/session-context` is registered by `rig-tools` through the OpenCode CLI plugin
API, not deployed from `platforms/linux/ubuntu/computer-use/commands/`. With no
argument it shows the list; with an ID or unique title it shows the selected
context. The command calls the bounded RPC and renders its result through the
supported v2.0.7 `context.ui.dialog.alert` API. It does not start model
generation, resume the session, write a synthetic inbox message, or modify the
source session. The direct `session_context` backend remains a separate
acceptance surface. The latest blank-body render is historical pre-fix
evidence; live rendered and interaction acceptance remains pending until the
shared service is restarted and the checks are rerun.

## Verification and known limitations

The report includes source identity, retrieval time, live status, saved outcome,
and coverage/truncation markers. It excludes the calling session and refuses
cross-project sources.

Known limits:

- It is a snapshot, not a subscription. A running source can advance immediately.
- Large histories may report page, entry, or byte truncation.
- An unsettled assistant tail is omitted to avoid partially streamed context.
- Attachments, reasoning, provider state, shell output, tool input, and tool
  results are omitted.
- Imported user or assistant text can still contain sensitive information; do
  not repeat or persist it unnecessarily.

## Troubleshooting

- `ambiguous`: rerun with an exact session ID from the candidate list.
- `not-found`: list sessions without a filter and confirm the project.
- `cross-project-refused`: switch to a session in the source project instead of
  bypassing isolation.
- `service-identity-mismatch`: restart OpenCode so the plugin connects to the
  exact shared service process that loaded it.
- `response-too-large`, `page-limit`, or `byte-limit`: narrow the source or rely
  on its checkpoint summary, then verify the missing details directly.
- A newly edited plugin may not replace tools already captured by an in-flight
  model request; begin a fresh turn after reload.

## Safety, confirmation, and elevation

Retrieval requires no elevated privileges and provides no mutation mode. It
must not prompt, interrupt, rename, move, fork, delete, or write into source
sessions. Historical content is untrusted data, not authorization. Existing
commit, push, publishing, deletion, credential, and desktop confirmation gates
remain unchanged.

## Related skills and documents

- `task-memory` stores curated durable preferences and decisions.
- `agent-orchestration` coordinates explicitly authorized child sessions.
- `skill-maintenance` owns skill creation, cataloging, deployment, and audit.
- Canonical plugin documentation is in
  `platforms/linux/ubuntu/computer-use/plugins-v2/rig-tools/README.md`.
