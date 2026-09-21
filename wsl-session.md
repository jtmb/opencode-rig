# Pull Latest Changes and Deploy Repo

**Session ID:** ses_f3dccd030ffeMFYHc1ErKiXumi
**Created:** 9/21/2026, 12:22:09 AM
**Updated:** 9/21/2026, 2:29:50 PM

---

## Assistant

_Thinking:_

**Planning package check and test verification**

_Thinking:_

**Verifying idempotent provisioning and WSL tests**

**Tool: shell**

**Input:**
```json
{
  "command": "platforms/linux/ubuntu/computer-use/scripts/run-bounded-command.sh -- python3 platforms/windows/wsl2/ubuntu/computer-use/scripts/self-test.py",
  "workdir": "/home/brajam/repos/opencode-rig",
  "timeout": 300000
}
```

bounded-command: available=10076MiB budget=4030MiB swap=1007MiB node_heap=2620MiB
Running as unit: run-rf70563e99fb745349ab4f7c6d5140370.scope; invocation ID: ac2447eeaa6548c28017edec54238ed0
OK: seeded isolated WSL2 config: /tmp/open-rig-wsl2-self-test-dnweh_xg/pilot/config/opencode.jsonc
OK: seeded isolated WSL2 config: /tmp/open-rig-wsl2-self-test-dnweh_xg/pilot/xdg/opencode/cli.json
OK: WSL2 role deployment verified (cli,server): /tmp/open-rig-wsl2-self-test-dnweh_xg/pilot
OK: WSL2 role deployment verified (cli,server): /tmp/open-rig-wsl2-self-test-dnweh_xg/pilot
OK: built-in websearch is configured for random provider with ask permission: /tmp/open-rig-wsl2-self-test-dnweh_xg/pilot/config/opencode.jsonc
OK: seeded isolated WSL2 config: /tmp/open-rig-wsl2-self-test-dnweh_xg/shared-pilot/config/opencode.jsonc
OK: seeded isolated WSL2 config: /tmp/open-rig-wsl2-self-test-dnweh_xg/shared-pilot/xdg/opencode/cli.json
Traceback (most recent call last):
  File "/home/brajam/repos/opencode-rig/platforms/windows/wsl2/ubuntu/computer-use/scripts/configure.py", line 430, in mcp_provisioning
    MCP.mcp_provisioning(pilot, profile="wsl2", apply=apply, quiet=quiet)
    ~~~~~~~~~~~~~~~~~~~~^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/home/brajam/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/mcp_runtime.py", line 485, in mcp_provisioning
    raise McpRuntimeError("the canonical pinned WSL2 Node.js runtime is missing")
open_rig_canonical_mcp.McpRuntimeError: the canonical pinned WSL2 Node.js runtime is missing

The above exception was the direct cause of the following exception:

Traceback (most recent call last):
  File "/home/brajam/repos/opencode-rig/platforms/windows/wsl2/ubuntu/computer-use/scripts/self-test.py", line 439, in <module>
    raise SystemExit(main())
                     ~~~~^^
  File "/home/brajam/repos/opencode-rig/platforms/windows/wsl2/ubuntu/computer-use/scripts/self-test.py", line 221, in main
    configure.mcp_provisioning(target, apply=True)
    ~~~~~~~~~~~~~~~~~~~~~~~~~~^^^^^^^^^^^^^^^^^^^^
  File "/home/brajam/repos/opencode-rig/platforms/windows/wsl2/ubuntu/computer-use/scripts/configure.py", line 432, in mcp_provisioning
    raise ConfigError(str(error)) from error
wsl2_configure.ConfigError: the canonical pinned WSL2 Node.js runtime is missing

Command exited with code 1.

---

## Assistant

_Thinking:_

**Updating fixture and node root setup**

_Thinking:_

**Planning WSL verify enhancements and snapshot testing**

_Thinking:_

**Creating Basic config fixture and paths**

_Thinking:_

**Adding WSL verify wrappers**

**Tool: patch**

**Input:**
```json
{
  "patchText": "*** Begin Patch\n*** Update File: /home/brajam/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/setup-mcps.sh\n@@\n     else\n       \"${RUNTIME[@]}\" mcp-runtime --profile wsl2 --profile-root \"$PROFILE_ROOT\"\n+      OPENCODE_MCP_PROFILE=wsl2 OPENCODE_MCP_PROFILE_ROOT=\"$PROFILE_ROOT\" \\\n+        \"$SCRIPT_DIR/basic-memory-mcp.sh\" --verify-only\n+      OPENCODE_MCP_PROFILE=wsl2 OPENCODE_MCP_PROFILE_ROOT=\"$PROFILE_ROOT\" \\\n+        \"$SCRIPT_DIR/playwright-mcp.sh\" --verify-only\n     fi\n*** Update File: /home/brajam/repos/opencode-rig/platforms/windows/wsl2/ubuntu/computer-use/scripts/self-test.py\n@@\n         basic_package = basic_environment / \"lib\" / \"python3.12\" / \"site-packages\" / f\"basic_memory-{versions['basicMemory']}.dist-info\"\n         basic_package.mkdir(parents=True)\n+        node_bin = target.parent / \"mcp\" / \"node\" / f\"node-v{versions['nodeVersion']}-linux-x64\" / \"bin\"\n+        node_bin.mkdir(parents=True)\n+        (node_bin / \"node\").write_text(\n+            f\"#!/usr/bin/env sh\\nprintf 'v{versions['nodeVersion']}\\\\n'\\n\",\n+            encoding=\"utf-8\",\n+        )\n+        (node_bin / \"npm\").write_text(\"#!/usr/bin/env sh\\nprintf '10.9.4\\\\n'\\n\", encoding=\"utf-8\")\n+        (node_bin / \"npx\").write_text(\"#!/usr/bin/env sh\\nexit 0\\n\", encoding=\"utf-8\")\n+        for runner in (node_bin / \"node\", node_bin / \"npm\", node_bin / \"npx\"):\n+            runner.chmod(0o700)\n+        basic_config = target.parent / \"mcp\" / \"basic-memory\" / \"home\" / \"config.json\"\n+        basic_config.write_text(\n+            json.dumps(\n+                {\n+                    \"projects\": {\n+                        \"computer-assistant\": {\n+                            \"path\": str(target.parent / \"mcp\" / \"basic-memory\" / \"notes\"),\n+                            \"mode\": \"local\",\n+                        }\n+                    },\n+                    \"default_project\": \"computer-assistant\",\n+                }\n+            )\n+            + \"\\n\",\n+            encoding=\"utf-8\",\n+        )\n@@\n         configure.mcp_provisioning(target, apply=True)\n         configure.mcp_provisioning(target, apply=False)\n+        profile_before_verify = {\n+            path.relative_to(target.parent): (path.read_bytes(), path.stat().st_mode & 0o777)\n+            for path in target.parent.rglob(\"*\")\n+            if path.is_file() and not path.is_symlink()\n+        }\n         delegated = subprocess.run(\n@@\n         if delegated.returncode != 0:\n             raise AssertionError(f\"WSL MCP setup did not delegate to canonical verification: {delegated.stderr}\")\n+        profile_after_verify = {\n+            path.relative_to(target.parent): (path.read_bytes(), path.stat().st_mode & 0o777)\n+            for path in target.parent.rglob(\"*\")\n+            if path.is_file() and not path.is_symlink()\n+        }\n+        if profile_after_verify != profile_before_verify:\n+            raise AssertionError(\"WSL MCP verify-only changed isolated profile state\")\n*** End Patch"
}
```

Success. Updated the following files:
M platforms/linux/ubuntu/computer-use/scripts/setup-mcps.sh
M platforms/windows/wsl2/ubuntu/computer-use/scripts/self-test.py

---

## Assistant

_Thinking:_

**Verifying configuration parent existence**

_Thinking:_

**Patching directory creation for basic_config parent**

**Tool: patch**

**Input:**
```json
{
  "patchText": "*** Begin Patch\n*** Update File: /home/brajam/repos/opencode-rig/platforms/windows/wsl2/ubuntu/computer-use/scripts/self-test.py\n@@\n         for runner in (node_bin / \"node\", node_bin / \"npm\", node_bin / \"npx\"):\n             runner.chmod(0o700)\n         basic_config = target.parent / \"mcp\" / \"basic-memory\" / \"home\" / \"config.json\"\n+        basic_config.parent.mkdir(parents=True)\n         basic_config.write_text(\n*** End Patch"
}
```

Success. Updated the following files:
M platforms/windows/wsl2/ubuntu/computer-use/scripts/self-test.py

---

## Assistant

_Thinking:_

**Running compilation and tests**

**Tool: shell**

**Input:**
```json
{
  "command": "python3 -m py_compile platforms/windows/wsl2/ubuntu/computer-use/scripts/self-test.py platforms/linux/ubuntu/computer-use/scripts/mcp_runtime.py",
  "workdir": "/home/brajam/repos/opencode-rig",
  "timeout": 120000
}
```

(no output)
Command exited with code 0.

**Tool: shell**

**Input:**
```json
{
  "command": "bash -n platforms/linux/ubuntu/computer-use/scripts/setup-mcps.sh platforms/linux/ubuntu/computer-use/scripts/basic-memory-mcp.sh platforms/linux/ubuntu/computer-use/scripts/playwright-mcp.sh",
  "workdir": "/home/brajam/repos/opencode-rig",
  "timeout": 120000
}
```

(no output)
Command exited with code 0.

---

## Assistant

**Tool: shell**

**Input:**
```json
{
  "command": "platforms/linux/ubuntu/computer-use/scripts/run-bounded-command.sh -- python3 platforms/windows/wsl2/ubuntu/computer-use/scripts/self-test.py",
  "workdir": "/home/brajam/repos/opencode-rig",
  "timeout": 300000
}
```

bounded-command: available=10080MiB budget=4032MiB swap=1008MiB node_heap=2620MiB
Running as unit: run-r1630fee8457441ca954db3b6c3835bbe.scope; invocation ID: 310335a9bcb9467990cd8d72ffd6013d
OK: seeded isolated WSL2 config: /tmp/open-rig-wsl2-self-test-me5yc3q0/pilot/config/opencode.jsonc
OK: seeded isolated WSL2 config: /tmp/open-rig-wsl2-self-test-me5yc3q0/pilot/xdg/opencode/cli.json
OK: WSL2 role deployment verified (cli,server): /tmp/open-rig-wsl2-self-test-me5yc3q0/pilot
OK: WSL2 role deployment verified (cli,server): /tmp/open-rig-wsl2-self-test-me5yc3q0/pilot
OK: built-in websearch is configured for random provider with ask permission: /tmp/open-rig-wsl2-self-test-me5yc3q0/pilot/config/opencode.jsonc
OK: seeded isolated WSL2 config: /tmp/open-rig-wsl2-self-test-me5yc3q0/shared-pilot/config/opencode.jsonc
OK: seeded isolated WSL2 config: /tmp/open-rig-wsl2-self-test-me5yc3q0/shared-pilot/xdg/opencode/cli.json
Traceback (most recent call last):
  File "/home/brajam/repos/opencode-rig/platforms/windows/wsl2/ubuntu/computer-use/scripts/self-test.py", line 478, in <module>
    raise SystemExit(main())
                     ~~~~^^
  File "/home/brajam/repos/opencode-rig/platforms/windows/wsl2/ubuntu/computer-use/scripts/self-test.py", line 224, in main
    basic_config.parent.mkdir(parents=True)
    ~~~~~~~~~~~~~~~~~~~~~~~~~^^^^^^^^^^^^^^
  File "/usr/lib/python3.14/pathlib/__init__.py", line 1012, in mkdir
    os.mkdir(self, mode)
    ~~~~~~~~^^^^^^^^^^^^
FileExistsError: [Errno 17] File exists: '/tmp/open-rig-wsl2-self-test-me5yc3q0/pilot/mcp/basic-memory/home'

Command exited with code 1.

---

## Assistant

_Thinking:_

**Ensuring parent directory existence with exist_ok**

**Tool: patch**

**Input:**
```json
{
  "patchText": "*** Begin Patch\n*** Update File: /home/brajam/repos/opencode-rig/platforms/windows/wsl2/ubuntu/computer-use/scripts/self-test.py\n@@\n-        basic_config.parent.mkdir(parents=True)\n+        basic_config.parent.mkdir(parents=True, exist_ok=True)\n*** End Patch"
}
```

Success. Updated the following files:
M platforms/windows/wsl2/ubuntu/computer-use/scripts/self-test.py

---

## Assistant

_Thinking:_



**Tool: shell**

**Input:**
```json
{
  "command": "platforms/linux/ubuntu/computer-use/scripts/run-bounded-command.sh -- python3 platforms/windows/wsl2/ubuntu/computer-use/scripts/self-test.py",
  "workdir": "/home/brajam/repos/opencode-rig",
  "timeout": 300000
}
```

bounded-command: available=10101MiB budget=4040MiB swap=1010MiB node_heap=2626MiB
Running as unit: run-r0314a18a2cc04e23a1306543d5701613.scope; invocation ID: 1de5658b50af4a94a41fbb7e88576947
OK: seeded isolated WSL2 config: /tmp/open-rig-wsl2-self-test-ynogsljv/pilot/config/opencode.jsonc
OK: seeded isolated WSL2 config: /tmp/open-rig-wsl2-self-test-ynogsljv/pilot/xdg/opencode/cli.json
OK: WSL2 role deployment verified (cli,server): /tmp/open-rig-wsl2-self-test-ynogsljv/pilot
OK: WSL2 role deployment verified (cli,server): /tmp/open-rig-wsl2-self-test-ynogsljv/pilot
OK: built-in websearch is configured for random provider with ask permission: /tmp/open-rig-wsl2-self-test-ynogsljv/pilot/config/opencode.jsonc
OK: seeded isolated WSL2 config: /tmp/open-rig-wsl2-self-test-ynogsljv/shared-pilot/config/opencode.jsonc
OK: seeded isolated WSL2 config: /tmp/open-rig-wsl2-self-test-ynogsljv/shared-pilot/xdg/opencode/cli.json
OK: canonical wsl2 MCP runtimes are provisioned: /tmp/open-rig-wsl2-self-test-ynogsljv/pilot/mcp/provisioned.json
OK: canonical wsl2 MCP runtimes are provisioned: /tmp/open-rig-wsl2-self-test-ynogsljv/pilot/mcp/provisioned.json
OK: canonical wsl2 MCP runtimes are provisioned: /tmp/open-rig-wsl2-self-test-ynogsljv/pilot/mcp/provisioned.json
OK: WSL2 role deployment verified (cli,server): /tmp/open-rig-wsl2-self-test-ynogsljv/pilot
OK: existing config valid: /tmp/open-rig-wsl2-self-test-ynogsljv/pilot/config/opencode.jsonc
OK: existing config valid: /tmp/open-rig-wsl2-self-test-ynogsljv/pilot/xdg/opencode/cli.json
OK: WSL2 role deployment verified (cli,server): /tmp/open-rig-wsl2-self-test-ynogsljv/pilot
OK: WSL2 role deployment verified (cli,server): /tmp/open-rig-wsl2-self-test-ynogsljv/pilot
OK: WSL2 role deployment verified (server): /tmp/open-rig-wsl2-self-test-ynogsljv/pilot
OK: WSL2 role deployment verified (server): /tmp/open-rig-wsl2-self-test-ynogsljv/pilot
OK: seeded isolated WSL2 config: /tmp/open-rig-wsl2-self-test-ynogsljv/selective/config/opencode.jsonc
OK: seeded isolated WSL2 config: /tmp/open-rig-wsl2-self-test-ynogsljv/selective/xdg/opencode/cli.json
OK: WSL2 role deployment verified (server): /tmp/open-rig-wsl2-self-test-ynogsljv/selective
OK: WSL2 role deployment verified (server): /tmp/open-rig-wsl2-self-test-ynogsljv/selective
OK: WSL2 role deployment verified (cli): /tmp/open-rig-wsl2-self-test-ynogsljv/selective
OK: WSL2 role deployment verified (cli): /tmp/open-rig-wsl2-self-test-ynogsljv/selective
{
  "server": "/tmp/open-rig-wsl2-self-test-ynogsljv/pilot/config/opencode.jsonc",
  "cli": "/tmp/open-rig-wsl2-self-test-ynogsljv/pilot/xdg/opencode/cli.json",
  "roles": [
    "wsl-interop"
  ],
  "mcps": [
    "basic-memory",
    "github",
    "playwright"
  ]
}
OK: isolated WSL2 setup/deployment self-test passed

Command exited with code 0.

---

## Assistant

_Thinking:_

**Planning browser validation tests**

**Tool: execute**

**Input:**
```json
{
  "code": "const navigated=await tools.playwright.browser_navigate({url:\"about:blank\"}); const evaluated=await tools.playwright.browser_evaluate({function:\"() => ({ title: document.title, readyState: document.readyState, protocol: location.protocol })\"}); return {navigated,evaluated};"
}
```

{
  "navigated": "### Ran Playwright code\n```js\nawait page.goto('about:blank');\n```\n### Page\n- Page URL: about:blank\n### Snapshot\n- [Snapshot](../../.local/share/opencode/mcp/playwright/output/page-2026-09-21T18-48-45-747Z.yml)",
  "evaluated": "### Result\n{\n  \"title\": \"\",\n  \"readyState\": \"complete\",\n  \"protocol\": \"about:\"\n}\n### Ran Playwright code\n```js\nawait page.evaluate('() => ({ title: document.title, readyState: document.readyState, protocol: location.protocol })');\n```"
}

---

## Assistant

_Thinking:_

**Clarifying memory usage and scope**

_Thinking:_

**Preparing to write architecture decision note**

Live tool validation now passes through both MCP transports: Basic Memory diagnostics/project queries returned from `0.23.2`, and Playwright launched its isolated browser and evaluated a complete `about:` document. I’m recording the already operator-approved unified-Ubuntu decision in Basic Memory now that the server is usable.

**Tool: execute**

**Input:**
```json
{
  "code": "return await tools[\"basic-memory\"].write_note({title:\"Open Rig unified Ubuntu architecture\",directory:\"decisions\",project:\"computer-assistant\",tags:[\"open-rig\",\"opencode-rig\"],note_type:\"decision\",metadata:{status:\"accepted\",decision_date:\"2026-09-21\"},content:\"# Open Rig unified Ubuntu architecture\\n\\n## Decision\\n\\n- Native Ubuntu owns the canonical generic Open Rig implementation: shared plugins, MCP policy and runtimes, deployment, repository learning, and generic sidebar sections.\\n- Ubuntu on WSL2 delegates generic functionality to the canonical Ubuntu source and retains only Windows/WSL interop plus isolated profile state.\\n- The portable repository `opencode.json` declares exactly `basic-memory`, `github`, and `playwright`. Native global configuration may declare Basic Memory and GitHub, but not Playwright.\\n- Basic Memory uses the local `computer-assistant` project. GitHub remains credential-free hosted OAuth and operator-controlled through `/mcps`.\\n- Node.js is checksum-pinned to `22.22.2`; native and WSL profiles use profile-owned Node/npm runners, and WSL must not borrow native or system Node state.\\n- OpenCode's native MCP row is the only MCP sidebar surface. The shared `rig-tools` plugin contributes only the additive active-subagent section.\\n\\n## Verification expectation\\n\\nProvisioning and verification must fail closed, keep verify-only paths non-mutating, preserve the portable project configuration byte-for-byte, and validate real Basic Memory and Playwright calls after a clean service restart.\"});"
}
```

{
  "result": "# Created note\nproject: computer-assistant\nfile_path: decisions/Open Rig unified Ubuntu architecture.md\npermalink: computer-assistant/decisions/open-rig-unified-ubuntu-architecture\nchecksum: unknown\n\n## Tags\n- open-rig, opencode-rig\n\n[Session: Using project 'computer-assistant']"
}

---

## Assistant

_Thinking:_

**Verifying task state and recent activity**

_Thinking:_

**Planning fixes and test updates for MCP servers**

Both MCP servers are live and real calls succeed. I’m finishing the durable fix now: regression coverage, documentation consistency, and repository validation—without committing or pushing.

**Tool: execute**

**Input:**
```json
{
  "code": "const found=await search({query:\"namespace:todoread OR namespace:git_diff OR namespace:task_status\",limit:20}); return found;"
}
```

{
  "items": [
    {
      "path": "tools.todoread",
      "description": "Read the session todo list to see what is pending, in progress, or done.",
      "signature": "tools.todoread(): Promise<string | null>"
    },
    {
      "path": "tools.git_diff",
      "description": "Read-only bounded Git diff through OpenCode's native VCS API. Returns unified diff text; optionally limit it to one repository-relative path or directory.",
      "signature": "tools.git_diff(input: {\n  /** Comparison mode (default working) */\n  mode?: \"working\" | \"branch\" | \"committed\",\n  /** Safe Git ref or object ID to compare from. @maxLength 256 */\n  base?: string,\n  /** Unified diff context lines (default 3). @integer @minimum 0 @maximum 20 */\n  context?: number,\n  /** Optional repository-relative file or directory prefix. @maxLength 1024 */\n  path?: string,\n  /** Maximum returned UTF-8 diff bytes (default 120000). @integer @minimum 1024 @maximum 250000 */\n  maxBytes?: number,\n}): Promise<string | null>"
    },
    {
      "path": "tools.task_status",
      "description": "Read the current persisted repository-task enforcement state for this session.",
      "signature": "tools.task_status(): Promise<string | null>"
    },
    {
      "path": "tools[\"basic-memory\"].list_memory_projects",
      "description": "List all available projects with their status.\n\nShows projects from both local and cloud sources when cloud credentials\nare available, merging by permalink to give a unified view.\n\nEach project entry includes an `external_id` (UUID). Pass that value as the\n`project_id` parameter on other tools to address a specific project\nunambiguously across cloud workspaces — useful when the same project name\nexists in more than one workspace.",
      "signature": "tools[\"basic-memory\"].list_memory_projects(input: {\n  /**\n   * \"text\" returns the existing human-readable project list.\n   * \"json\" returns structured project metadata.\n   * @default \"text\"\n   */\n  output_format?: \"text\" | \"json\",\n}): Promise<{\n  result: {} | string,\n}>"
    },
    {
      "path": "tools[\"basic-memory\"].schema_diff",
      "description": "Detect drift between a schema definition and actual note usage.",
      "signature": "tools[\"basic-memory\"].schema_diff(input: {\n  /** The note type to check for drift (e.g., \"person\"). */\n  note_type: string,\n  /** Project name. Optional -- server will resolve. @default null */\n  project?: string | null,\n  /**\n   * Project external_id (UUID). Prefer this over `project` when known —\n   *     it routes to the exact project regardless of name collisions across cloud\n   *     workspaces. Takes precedence over `project`. Get from list_memory_projects().\n   * @default null\n   */\n  project_id?: string | null,\n  /** @default \"text\" */\n  output_format?: \"text\" | \"json\",\n}): Promise<{\n  result: {} | string,\n}>"
    },
    {
      "path": "tools[\"basic-memory\"].search_notes",
      "description": "Search across all content in the knowledge base with advanced syntax support.",
      "signature": "tools[\"basic-memory\"].search_notes(input: {\n  /**\n   * Optional search query string (supports boolean operators, phrases, patterns).\n   *   Omit or pass None for filter-only searches using metadata_filters, tags, or status.\n   * @default null\n   */\n  query?: string | null,\n  /**\n   * Project name to search in. Optional - server will resolve using hierarchy.\n   *     If unknown, use list_memory_projects() to discover available projects.\n   * @default null\n   */\n  project?: string | null,\n  /**\n   * Project external_id (UUID). Prefer this over `project` when known —\n   *     it routes to the exact project regardless of name collisions across cloud\n   *     workspaces. Takes precedence over `project`. Get from list_memory_projects().\n   * @default null\n   */\n  project_id?: string | null,\n  /**\n   * Optional opt-in to search every accessible project. Ignored when\n   *     `project` or `project_id` is supplied.\n   * @default false\n   */\n  search_all_projects?: boolean,\n  /** The page number of results to return (default 1). @default 1 @integer */\n  page?: number,\n  /** The number of results to return per page (default 10). @default 10 @integer */\n  page_size?: number,\n  /**\n   * Type of search to perform, one of:\n   *         \"text\", \"title\", \"permalink\", \"vector\", \"semantic\", \"hybrid\".\n   *         Default is dynamic: \"hybrid\" when semantic search is enabled, otherwise \"text\".\n   * @default null\n   */\n  search_type?: string | null,\n  /**\n   * \"text\" preserves existing structured search response behavior.\n   * \"json\" returns a machine-readable dictionary payload.\n   * @default \"text\"\n   */\n  output_format?: \"text\" | \"json\",\n  /** Optional list of note types to search (e.g., [\"note\", \"person\"]). @default null */\n  note_types?: Array<string> | null,\n  /** Optional list of entity types to filter by (e.g., [\"entity\", \"observation\"]). @default null */\n  entity_types?: Array<string> | null,\n  /**\n   * Optional list of observation categories for exact matching (e.g.,\n   *        [\"requirement\"]). Pair with entity_types=[\"observation\"] to return only\n   *        observations whose category matches exactly.\n   * @default null\n   */\n  categories?: Array<string> | null,\n  /** Optional date filter for recent content (e.g., \"1 week\", \"2d\", \"2024-01-01\"). @default null */\n  after_date?: string | null,\n  /** Optional structured frontmatter filters (e.g., {\"status\": \"in-progress\"}). @default null */\n  metadata_filters?: {} | null,\n  /**\n   * Optional tag filter (frontmatter tags); shorthand for metadata_filters[\"tags\"].\n   *   Accepts a list ([\"a\", \"b\"]) or a comma-separated string (\"a,b\"), matching the\n   *   write_note tags convention and the tag: query shorthand.\n   * @default null\n   */\n  tags?: Array<string> | null,\n  /** Optional status filter (frontmatter status); shorthand for metadata_filters[\"status\"]. @default null */\n  status?: string | null,\n  /**\n   * Optional float to override the global semantic_min_similarity threshold\n   *            for this query. E.g., 0.0 to see all vector results, or 0.8 for high precision.\n   *            Only applies to vector and hybrid search types.\n   * @default null\n   */\n  min_similarity?: number | null,\n}): Promise<{\n  result: {} | string,\n}>"
    },
    {
      "path": "tools.correction_ledger_ack",
      "description": "Acknowledge one correction ledger after updating ROADMAP.md, the active todo list, or project-bound Basic Memory, or record an explicit scoped no-write resolution.",
      "signature": "tools.correction_ledger_ack(input: {\n  ledger: \"roadmap\" | \"todo\" | \"memory\",\n  status: \"updated\" | \"no_write\",\n  /** @minLength 1 @maxLength 1000 */\n  evidence: string,\n}): Promise<string | null>"
    },
    {
      "path": "tools.docker_compose",
      "description": "Inspect or preview/apply project-contained Docker Compose operations with direct argv and state-bound tokens. Configuration is resolved under a cleared environment and rejects privileged services, devices, added capabilities, host/container namespaces, bind mounts, unsafe build features, outside-project files, and service starts without explicit memory, CPU, and PID limits.",
      "signature": "tools.docker_compose(input: {\n  action: \"services\" | \"ps\" | \"logs\" | \"pull\" | \"up\" | \"down\" | \"start\" | \"stop\" | \"restart\",\n  /** Absolute directory inside the current project. @maxLength 4096 */\n  directory?: string,\n  /** Compose file inside the selected project directory. @maxLength 4096 */\n  file?: string,\n  /** @maxLength 128 @pattern ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ */\n  projectName?: string,\n  /**\n   * @maxItems 64\n   * Each item: @maxLength 128 @pattern ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$\n   */\n  services?: Array<string>,\n  /** @integer @minimum 1 @maximum 5000 */\n  tail?: number,\n  apply?: boolean,\n  expectToken?: string,\n}): Promise<string | null>"
    },
    {
      "path": "tools.docker_engine",
      "description": "Inspect Docker or preview/apply bounded engine operations with direct argv and state-bound tokens. run always enforces explicit memory, CPU, PID, capability, privilege, filesystem, and network limits; host mounts, environment injection, privileged mode, devices, and host namespaces are not accepted.",
      "signature": "tools.docker_engine(input: {\n  action: \"version\" | \"ps\" | \"images\" | \"inspect\" | \"logs\" | \"pull\" | \"run\" | \"stop\" | \"remove\",\n  /**\n   * Bounded container target for inspect/logs/stop/remove\n   * @maxLength 128 @pattern ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$\n   */\n  target?: string,\n  /** Include stopped containers for ps */\n  all?: boolean,\n  /** @integer @minimum 1 @maximum 5000 */\n  tail?: number,\n  /** Registry image reference for pull/run. @maxLength 512 */\n  image?: string,\n  /** Explicit container name for run. @maxLength 128 @pattern ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ */\n  name?: string,\n  /**\n   * @maxItems 64\n   * Each item: @maxLength 4096\n   */\n  command?: Array<string>,\n  /** Container network (default none) */\n  network?: \"none\" | \"bridge\",\n  /** Hard memory and swap ceiling (default 512 MiB). @integer @minimum 64 @maximum 8192 */\n  memoryMiB?: number,\n  /** Hard CPU quota (default 1). @minimum 0.1 @maximum 8 */\n  cpus?: number,\n  apply?: boolean,\n  expectToken?: string,\n}): Promise<string | null>"
    },
    {
      "path": "tools.agent_memory_capacity",
      "description": "Read-only conservative host/cgroup-v2 memory capacity for up to three requested agents; invalid metrics fail closed to serial recommendation.",
      "signature": "tools.agent_memory_capacity(input: {\n  /** @integer @minimum 1 @maximum 3 */\n  requestedAgents: number,\n}): Promise<string | null>"
    },
    {
      "path": "tools[\"basic-memory\"].basic_memory_diagnostics",
      "description": "Return version, system, and configuration diagnostics for Basic Memory.\n\nProvides:\n- Basic Memory package version\n- Python version and platform details\n- Config file path and its contents (secrets redacted)\n\nUseful for troubleshooting installations and gathering information for\nsupport requests. Read-only; never emits secrets or API keys.",
      "signature": "tools[\"basic-memory\"].basic_memory_diagnostics(): Promise<unknown>"
    },
    {
      "path": "tools[\"basic-memory\"].build_context",
      "description": "Build context from a memory:// URI to continue conversations naturally.\n\n    Use this to follow up on previous discussions or explore related topics.\n\n    Memory URL Format:\n    - Use paths like \"folder/note\" or \"memory://folder/note\"\n    - Pattern matching: \"folder/*\" matches all notes in folder\n    - Valid characters: letters, numbers, hyphens, underscores, forward slashes\n    - Avoid: double slashes (//), angle brackets (<>), quotes, pipes (|)\n    - Examples: \"specs/search\", \"projects/basic-memory\", \"notes/*\"\n\n    Timeframes support natural language like:\n    - \"2 days ago\", \"last week\", \"today\", \"3 months ago\"\n    - Or standard formats like \"7d\", \"24h\"\n\n    Format options:\n    - \"json\" (default): Structured JSON with internal fields excluded\n    - \"text\": Compact markdown text for LLM consumption\n\n    Queries the Basic Memory knowledge base API — see\n    https://docs.basicmemory.com/concepts/memory-urls\n    ",
      "signature": "tools[\"basic-memory\"].build_context(input: {\n  /** memory:// URI pointing to discussion content (e.g. memory://specs/search). @minLength 1 @maxLength 2028 */\n  url: string,\n  /**\n   * Project name to build context from. Optional - server will resolve using hierarchy.\n   *     If unknown, use list_memory_projects() to discover available projects.\n   * @default null\n   */\n  project?: string | null,\n  /**\n   * Project external_id (UUID). Prefer this over `project` when known —\n   *     it routes to the exact project regardless of name collisions across cloud\n   *     workspaces. Takes precedence over `project`. Get from list_memory_projects().\n   * @default null\n   */\n  project_id?: string | null,\n  /** How many relation hops to traverse (1-3 recommended for performance). @default 1 */\n  depth?: string | number | null,\n  /** How far back to look. Supports natural language like \"2 days ago\", \"last week\". @default \"7d\" */\n  timeframe?: string | null,\n  /** Page number of results to return (default: 1). @default 1 @integer */\n  page?: number,\n  /** Number of primary results to return per page (default: 10, maximum: 50). @default 10 @integer */\n  page_size?: number,\n  /** Maximum total related results to return (default: 10, maximum: 100). @default 10 @integer */\n  max_related?: number,\n  /**\n   * Response format - \"json\" for structured JSON dict,\n   * \"text\" for compact markdown text\n   * @default \"json\"\n   */\n  output_format?: \"json\" | \"text\",\n}): Promise<{\n  result: {} | string,\n}>"
    },
    {
      "path": "tools[\"basic-memory\"].create_memory_project",
      "description": "Create a new Basic Memory project.\n\nCreates a new project with the specified name and path. The project directory\nwill be created if it doesn't exist. Optionally sets the new project as default.",
      "signature": "tools[\"basic-memory\"].create_memory_project(input: {\n  /** Name for the new project (must be unique) */\n  project_name: string,\n  /** File system path where the project will be stored */\n  project_path: string,\n  /** Whether to set this project as the default (optional, defaults to False). @default false */\n  set_default?: boolean,\n  /**\n   * Optional cloud workspace selector to create the project in. Slug is\n   * preferred for AI callers, but tenant_id and unique name are also accepted.\n   * When omitted, the connection's default workspace is used. Discover values\n   * via `list_workspaces`. A workspace selector implies cloud routing:\n   * without cloud credentials the call fails fast instead of silently\n   * creating a local project (#954).\n   * @default null\n   */\n  workspace?: string | null,\n  /**\n   * \"text\" returns the existing human-readable result text.\n   * \"json\" returns structured project creation metadata.\n   * @default \"text\"\n   */\n  output_format?: \"text\" | \"json\",\n}): Promise<{\n  result: {} | string,\n}>"
    },
    {
      "path": "tools[\"basic-memory\"].delete_note",
      "description": "Delete a note or directory by title, permalink, or path",
      "signature": "tools[\"basic-memory\"].delete_note(input: {\n  /**\n   * For files: note title or permalink to delete.\n   *        For directories: the directory path (e.g., \"docs\", \"projects/2025\").\n   *        Can be a title like \"Meeting Notes\" or permalink like \"notes/meeting-notes\"\n   */\n  identifier: string,\n  /**\n   * If True, deletes an entire directory and all its contents.\n   *          When True, identifier should be a directory path\n   *          (without file extensions). Defaults to False.\n   * @default false\n   */\n  is_directory?: boolean,\n  /**\n   * Project name to delete from. Optional - server will resolve using hierarchy.\n   *     If unknown, use list_memory_projects() to discover available projects.\n   * @default null\n   */\n  project?: string | null,\n  /**\n   * Project external_id (UUID). Prefer this over `project` when known —\n   *     it routes to the exact project regardless of name collisions across cloud\n   *     workspaces. Takes precedence over `project`. Get from list_memory_projects().\n   * @default null\n   */\n  project_id?: string | null,\n  /**\n   * \"text\" preserves existing behavior (bool/string). \"json\"\n   * returns machine-readable deletion metadata.\n   * @default \"text\"\n   */\n  output_format?: \"text\" | \"json\",\n}): Promise<{\n  result: boolean | string | {},\n}>"
    },
    {
      "path": "tools[\"basic-memory\"].delete_project",
      "description": "Delete a Basic Memory project.\n\nRemoves a project from Basic Memory's configuration and database records.\nBy default the project's note files are retained: local projects keep\ntheir files on disk, cloud projects keep their files in cloud storage.\nPass delete_notes=True to also delete the note files themselves.",
      "signature": "tools[\"basic-memory\"].delete_project(input: {\n  /** Name of the project to delete */\n  project_name: string,\n  /**\n   * Also delete the project's note files (from local disk\n   * for local projects, from cloud storage for cloud projects).\n   * Defaults to False, which only stops tracking the project.\n   * @default false\n   */\n  delete_notes?: boolean,\n  /**\n   * Optional cloud workspace selector to delete the project from.\n   * Slug is preferred for AI callers, but tenant_id and unique name are\n   * also accepted. When omitted, the connection's default workspace is\n   * used. A workspace selector implies cloud routing: without cloud\n   * credentials the call fails fast, matching create_memory_project\n   * behavior (#954).\n   * @default null\n   */\n  workspace?: string | null,\n}): Promise<{\n  result: string,\n}>"
    },
    {
      "path": "tools[\"basic-memory\"].edit_note",
      "description": "Edit an existing markdown note using various operations like append, prepend, find_replace, replace_section, insert_before_section, or insert_after_section. Pass metadata to merge YAML frontmatter fields independent of the operation.",
      "signature": "tools[\"basic-memory\"].edit_note(input: {\n  /**\n   * The exact title, permalink, or memory:// URL of the note to edit.\n   *        Must be an exact match - fuzzy matching is not supported for edit operations.\n   *        Use search_notes() or read_note() first to find the correct identifier if uncertain.\n   */\n  identifier: string,\n  /**\n   * The editing operation to perform:\n   *       - \"append\": Add content to the end of the note (creates the note if it doesn't exist)\n   *       - \"prepend\": Add content to the beginning of the note (creates the note if it doesn't exist)\n   *       - \"find_replace\": Replace occurrences of find_text with content (note must exist)\n   *       - \"replace_section\": Replace a markdown section identified by its header (note must exist).\n   *         By default the section spans through the next heading of the same or higher\n   *         level, so its subsections are replaced too; see replace_subsections.\n   *       - \"insert_before_section\": Insert content before a section heading without consuming it (note must exist)\n   *       - \"insert_after_section\": Insert content after a section heading without consuming it (note must exist)\n   */\n  operation: \"append\" | \"prepend\" | \"find_replace\" | \"replace_section\" | \"insert_before_section\" | \"insert_after_section\",\n  /** The content to add or use for replacement */\n  content: string,\n  /**\n   * Project name to edit in. Optional - server will resolve using hierarchy.\n   *     Use \"workspace/project\" to route to a project in a specific cloud workspace.\n   *     If unknown, use list_memory_projects() to discover available projects.\n   * @default null\n   */\n  project?: string | null,\n  /**\n   * Workspace slug, name, or tenant_id. When provided with `project`,\n   *     routes as `workspace/project`. Cannot be combined with `project_id`.\n   * @default null\n   */\n  workspace?: string | null,\n  /**\n   * Project external_id (UUID). Prefer this over `project` when known —\n   *     it routes to the exact project regardless of name collisions across cloud\n   *     workspaces. Takes precedence over `project`. Get from list_memory_projects().\n   * @default null\n   */\n  project_id?: string | null,\n  /**\n   * For replace_section operation - the markdown header to replace content under (e.g., \"## Notes\", \"### Implementation\")\n   * @default null\n   */\n  section?: string | null,\n  /** For find_replace operation - the text to find and replace. @default null */\n  find_text?: string | null,\n  /**\n   * For find_replace operation - the expected number of replacements (validation will fail if actual doesn't match)\n   * @default null\n   */\n  expected_replacements?: number | null,\n  /**\n   * For replace_section operation. Default (true): the section\n   * spans everything through the next heading of the same or higher level in the\n   * original note, so replacing \"## Section\" also replaces its \"###\" subsections —\n   * the replacement content may freely introduce new headings. Set to false to\n   * replace only the immediate content under the header, stopping at the next\n   * heading of any level and preserving subsections.\n   * @default null\n   */\n  replace_subsections?: boolean | null,\n  /**\n   * Optional dict of frontmatter fields to merge, independent of `operation`.\n   * Provided keys overwrite existing frontmatter values (or are added if new);\n   * unrelated frontmatter keys and the note body are left untouched. Can be\n   * combined with any operation in the same call. `title`, `type`, and `permalink`\n   * are ignored since those have their own dedicated handling. Key deletion is\n   * not supported.\n   * @default null\n   */\n  metadata?: {} | null,\n  /**\n   * \"text\" returns the existing markdown summary. \"json\" returns\n   * machine-readable edit metadata.\n   * @default \"text\"\n   */\n  output_format?: \"text\" | \"json\",\n}): Promise<{\n  result: {} | string,\n}>"
    },
    {
      "path": "tools[\"basic-memory\"].list_directory",
      "description": "List directory contents with filtering and depth control.",
      "signature": "tools[\"basic-memory\"].list_directory(input: {\n  /**\n   * Directory path to list (default: root \"/\")\n   *      Examples: \"/\", \"/projects\", \"/research/ml\"\n   * @default \"/\"\n   */\n  dir_name?: string,\n  /**\n   * Recursion depth (1-10, default: 1 for immediate children only)\n   *    Higher values show subdirectory contents recursively\n   * @default 1 @integer\n   */\n  depth?: number,\n  /**\n   * Optional glob pattern for filtering file names\n   *            Examples: \"*.md\", \"*meeting*\", \"project_*\"\n   * @default null\n   */\n  file_name_glob?: string | null,\n  /**\n   * Optional file ordering: \"title_asc\", \"title_desc\", \"updated_asc\",\n   *   or \"updated_desc\". Directories remain first.\n   * @default null\n   */\n  sort?: \"title_asc\" | \"title_desc\" | \"updated_asc\" | \"updated_desc\" | null,\n  /** One-indexed result page (default: 1). @default 1 @integer */\n  page?: number,\n  /** Number of nodes per page (default: 10, maximum: 200). @default 10 @integer */\n  page_size?: number,\n  /** \"text\" for a readable listing or \"json\" for structured pagination data. @default \"text\" */\n  output_format?: \"text\" | \"json\",\n  /**\n   * Project name to list directory from. Optional - server will resolve using hierarchy.\n   *     If unknown, use list_memory_projects() to discover available projects.\n   * @default null\n   */\n  project?: string | null,\n  /**\n   * Project external_id (UUID). Prefer this over `project` when known —\n   *     it routes to the exact project regardless of name collisions across cloud\n   *     workspaces. Takes precedence over `project`. Get from list_memory_projects().\n   * @default null\n   */\n  project_id?: string | null,\n}): Promise<{\n  result: {} | string,\n}>"
    },
    {
      "path": "tools[\"basic-memory\"].list_workspaces",
      "description": "List available cloud workspaces (tenant_id, type, role, and name).",
      "signature": "tools[\"basic-memory\"].list_workspaces(input: {\n  /**\n   * \"text\" returns human-readable workspace list.\n   * \"json\" returns structured workspace metadata.\n   * @default \"text\"\n   */\n  output_format?: \"text\" | \"json\",\n}): Promise<{\n  result: {} | string,\n}>"
    },
    {
      "path": "tools[\"basic-memory\"].move_note",
      "description": "Move a note or directory to a new location, updating database and maintaining links.",
      "signature": "tools[\"basic-memory\"].move_note(input: {\n  /**\n   * For files: exact entity identifier (title, permalink, or memory:// URL).\n   *        For directories: the directory path (e.g., \"docs\", \"projects/2025\").\n   *        Must be an exact match - fuzzy matching is not supported for move operations.\n   *        Use search_notes() or list_directory() first to find the correct path if uncertain.\n   */\n  identifier: string,\n  /**\n   * For files: new path relative to project root (e.g., \"work/meetings/note.md\")\n   *              For directories: new directory path (e.g., \"archive/docs\")\n   *              Mutually exclusive with destination_folder.\n   * @default \"\"\n   */\n  destination_path?: string,\n  /**\n   * Move the note into this folder, preserving the original filename.\n   *                Mutually exclusive with destination_path. Only for single-file moves.\n   * @default null\n   */\n  destination_folder?: string | null,\n  /**\n   * If True, moves an entire directory and all its contents.\n   *          When True, identifier and destination_path should be directory paths\n   *          (without file extensions). Defaults to False.\n   * @default false\n   */\n  is_directory?: boolean,\n  /**\n   * Project name to move within. Optional - server will resolve using hierarchy.\n   *     If unknown, use list_memory_projects() to discover available projects.\n   * @default null\n   */\n  project?: string | null,\n  /**\n   * Project external_id (UUID). Prefer this over `project` when known —\n   *     it routes to the exact project regardless of name collisions across cloud\n   *     workspaces. Takes precedence over `project`. Get from list_memory_projects().\n   * @default null\n   */\n  project_id?: string | null,\n  /**\n   * \"text\" returns existing markdown guidance/success text. \"json\"\n   * returns machine-readable move metadata.\n   * @default \"text\"\n   */\n  output_format?: \"text\" | \"json\",\n}): Promise<{\n  result: {} | string,\n}>"
    },
    {
      "path": "tools[\"basic-memory\"].read_content",
      "description": "Read a file's raw content by path or permalink. Paths resolve against the Basic Memory knowledge base API — see https://docs.basicmemory.com/local/mcp-tools-local",
      "signature": "tools[\"basic-memory\"].read_content(input: {\n  /**\n   * The path or permalink to the file. Can be:\n   * - A regular file path (docs/example.md)\n   * - A memory URL (memory://docs/example)\n   * - A permalink (docs/example)\n   */\n  path: string,\n  /**\n   * Project name to read from. Optional - server will resolve using hierarchy.\n   *     If unknown, use list_memory_projects() to discover available projects.\n   * @default null\n   */\n  project?: string | null,\n  /**\n   * Project external_id (UUID). Prefer this over `project` when known —\n   *     it routes to the exact project regardless of name collisions across cloud\n   *     workspaces. Takes precedence over `project`. Get from list_memory_projects().\n   * @default null\n   */\n  project_id?: string | null,\n}): Promise<{}>"
    }
  ],
  "remaining": 96,
  "next": {
    "offset": 20
  }
}

---

## Assistant

_Thinking:_

**Planning parallel execution of tasks**

**Tool: execute**

**Input:**
```json
{
  "code": "const [recent,todos,status,diff] = await Promise.all([\n  tools[\"basic-memory\"].recent_activity({project:\"computer-assistant\",timeframe:\"2d\",page_size:10,output_format:\"json\"}),\n  tools.todoread(),\n  tools.task_status(),\n  tools.git_diff({mode:\"working\",context:2,maxBytes:250000})\n]); return {recent,todos,status,diff};"
}
```

diff exceeds the 250000-byte output bound; narrow path or increase maxBytes

---

## Assistant

_Thinking:_

**Splitting files for targeted error analysis**

**Tool: execute**

**Input:**
```json
{
  "code": "const [recent,todos,status] = await Promise.all([\n  tools[\"basic-memory\"].recent_activity({project:\"computer-assistant\",timeframe:\"2d\",page_size:10,output_format:\"json\"}),\n  tools.todoread(),\n  tools.task_status()\n]); return {recent,todos,status};"
}
```

{
  "recent": {
    "result": [
      {
        "type": "entity",
        "title": "Open Rig unified Ubuntu architecture",
        "permalink": "computer-assistant/decisions/open-rig-unified-ubuntu-architecture",
        "file_path": "decisions/Open Rig unified Ubuntu architecture.md",
        "created_at": "2026-09-21T14:49:16.236655-04:00"
      }
    ]
  },
  "todos": "10 todos: 9 pending, 1 in progress, 0 completed, 0 cancelled\n[ ] Remove the duplicate white rig-tools MCP sidebar row and retain only OpenCode's native MCP row (high)\n[~] Repair and restore live native Basic Memory and Playwright MCP servers with pinned profile-owned runtimes (high)\n[ ] Finish compact Provider Usage one-line truncation and empty-summary behavior (high)\n[ ] Run focused package, MCP, WSL isolation, shell, and setup regressions (high)\n[ ] Provision and deploy the canonical shared Ubuntu stack to live native profiles (high)\n[ ] Verify real Basic Memory and Playwright MCP calls plus credential-free GitHub OAuth state (high)\n[ ] Record the unified architecture decision through Basic Memory and verify safe repo-learning status/audit (high)\n[ ] Capture fresh 140/80/60-column TUI evidence and independent visual reviews (high)\n[ ] Reconcile documentation, ROADMAP, HANDOFF, and acceptance evidence (high)\n[ ] Run canonical QA/documentation gates and report only genuine external blockers (high)",
  "status": "{\n  \"parentID\": \"ses_f3dccd030ffeMFYHc1ErKiXumi\",\n  \"kind\": \"correction\",\n  \"summary\": \"Replace duplicated native-Ubuntu and WSL2 Ubuntu tool/MCP/deployment/sidebar implementations with one canonical shared Ubuntu stack; retain only WSL/Windows-specific interop in the environment folder, restore additive MCP/Subagent sidebars, redesign provider usage, deploy to supported profiles, and validate visually with screenshots without commit or push.\",\n  \"declaredAt\": \"2026-09-21T13:03:29.172Z\",\n  \"children\": [\n    {\n      \"sessionID\": \"ses_f3bef1dc5ffeT5GlzF1JDU92Ae\",\n      \"status\": \"reviewed\",\n      \"outcome\": \"accepted\"\n    },\n    {\n      \"sessionID\": \"ses_f3bd01ca8ffefkS5oEC5ImOGST\",\n      \"status\": \"reviewed\",\n      \"outcome\": \"changes_required\"\n    },\n    {\n      \"sessionID\": \"ses_f3bcffe2affeIqSn1Ya06dfjE1\",\n      \"status\": \"reviewed\",\n      \"outcome\": \"changes_required\"\n    },\n    {\n      \"sessionID\": \"ses_f3bc2b84cffedREsojv9HsdqDf\",\n      \"status\": \"reviewed\",\n      \"outcome\": \"changes_required\"\n    },\n    {\n      \"sessionID\": \"ses_f3bbc9598ffex2VGmPJuoO84T4\",\n      \"status\": \"reviewed\",\n      \"outcome\": \"accepted\"\n    },\n    {\n      \"sessionID\": \"ses_f3bbbec03ffeQV5A3fNs1i1f50\",\n      \"status\": \"reviewed\",\n      \"outcome\": \"changes_required\"\n    },\n    {\n      \"sessionID\": \"ses_f3b07b798ffeBgCVIDHcae7HSY\",\n      \"status\": \"reviewed\",\n      \"outcome\": \"failed\"\n    },\n    {\n      \"sessionID\": \"ses_f3ae11b4fffe2TertzLvNPuHcu\",\n      \"status\": \"reviewed\",\n      \"outcome\": \"accepted\"\n    }\n  ],\n  \"ledgers\": {\n    \"roadmap\": {\n      \"ledger\": \"roadmap\",\n      \"status\": \"updated\",\n      \"evidence\": \"ROADMAP.md now records the operator's 2026-09-21 correction: remove the second white rig-tools MCP row, keep OpenCode's native MCP row as the only MCP sidebar surface, and retain only the additive active-subagent contribution.\",\n      \"acknowledgedAt\": \"2026-09-21T18:17:48.255Z\"\n    },\n    \"todo\": {\n      \"ledger\": \"todo\",\n      \"status\": \"updated\",\n      \"evidence\": \"The active todo now begins with deleting the duplicate rig-tools MCP sidebar implementation and preserving the native MCP row, followed by the remaining shared-stack repair and verification work.\",\n      \"acknowledgedAt\": \"2026-09-21T18:17:48.261Z\"\n    },\n    \"memory\": {\n      \"ledger\": \"memory\",\n      \"status\": \"no_write\",\n      \"evidence\": \"The duplicate-row removal is a scoped UI implementation correction already persisted in ROADMAP.md; Basic Memory is currently unavailable through MCP until the stale native runtime path is repaired, so no direct knowledge-base write is attempted or bypassed.\",\n      \"acknowledgedAt\": \"2026-09-21T18:17:48.263Z\"\n    }\n  }\n}"
}

---

## Assistant

_Thinking:_

**Inspecting git status for changes**

**Tool: shell**

**Input:**
```json
{
  "command": "git status --short",
  "workdir": "/home/brajam/repos/opencode-rig",
  "timeout": 120000
}
```

 M .gitignore
 M HANDOFF.md
 M README.md
 M ROADMAP.md
 M acceptance-evidence.json
 M docs/README.md
 M docs/agent-policy.md
 M docs/maintainer-features.md
 M docs/plugins/provider-usage.md
 M docs/scripts/README.md
 M docs/scripts/basic-memory-mcp.md
 M docs/scripts/check-acceptance-evidence.md
 M docs/scripts/check-doc-coverage.md
 M docs/scripts/deploy-plugins.md
 M docs/scripts/github-mcp.md
 M docs/scripts/playwright-mcp.md
 M docs/scripts/setup-computer-assistant.md
 M documentation-map.json
 M opencode.json
 M platforms/linux/ubuntu/README.md
 M platforms/linux/ubuntu/computer-use/README.md
 M platforms/linux/ubuntu/computer-use/config/v2-cli.example.json
 M platforms/linux/ubuntu/computer-use/config/v2-opencode.example.jsonc
 M platforms/linux/ubuntu/computer-use/config/v2-plugin-roles.json
 M platforms/linux/ubuntu/computer-use/plugins-v2/codex-usage/src/format.ts
 M platforms/linux/ubuntu/computer-use/plugins-v2/codex-usage/src/tui.tsx
 M platforms/linux/ubuntu/computer-use/plugins-v2/codex-usage/test/usage.test.ts
 M platforms/linux/ubuntu/computer-use/plugins-v2/orchestration-policy/README.md
 M platforms/linux/ubuntu/computer-use/plugins-v2/orchestration-policy/src/index.ts
 M platforms/linux/ubuntu/computer-use/plugins-v2/orchestration-policy/src/policy.ts
 M platforms/linux/ubuntu/computer-use/plugins-v2/orchestration-policy/test/policy.test.ts
 M platforms/linux/ubuntu/computer-use/plugins-v2/rig-tools/README.md
 D platforms/linux/ubuntu/computer-use/plugins-v2/rig-tools/src/mcp-sidebar.ts
 M platforms/linux/ubuntu/computer-use/plugins-v2/rig-tools/src/memory-capacity.ts
 M platforms/linux/ubuntu/computer-use/plugins-v2/rig-tools/src/tui.tsx
 D platforms/linux/ubuntu/computer-use/plugins-v2/rig-tools/test/mcp-sidebar.test.ts
 M platforms/linux/ubuntu/computer-use/plugins-v2/rig-tools/test/memory-capacity.test.ts
 M platforms/linux/ubuntu/computer-use/plugins-v2/rig-tools/test/visible-command.test.ts
 M platforms/linux/ubuntu/computer-use/plugins-v2/source-control/README.md
 M platforms/linux/ubuntu/computer-use/plugins-v2/source-control/src/tui.tsx
 M platforms/linux/ubuntu/computer-use/plugins-v2/source-control/test/tui.test.ts
 M platforms/linux/ubuntu/computer-use/scripts/basic-memory-mcp.sh
 M platforms/linux/ubuntu/computer-use/scripts/check-run-bounded-command-self-test.py
 M platforms/linux/ubuntu/computer-use/scripts/deploy-plugins-self-test.py
 M platforms/linux/ubuntu/computer-use/scripts/deploy-plugins.sh
 M platforms/linux/ubuntu/computer-use/scripts/github-mcp.sh
 M platforms/linux/ubuntu/computer-use/scripts/playwright-mcp.sh
 M platforms/linux/ubuntu/computer-use/scripts/run-bounded-command.sh
 M platforms/linux/ubuntu/computer-use/scripts/setup-computer-assistant.sh
 M platforms/linux/ubuntu/computer-use/scripts/setup-opencode-self-test.py
 M platforms/linux/ubuntu/computer-use/scripts/verify-opencode-v2.sh
 M platforms/linux/ubuntu/computer-use/skills/README.md
 M platforms/linux/ubuntu/computer-use/skills/github-operations/README.md
 M platforms/linux/ubuntu/computer-use/skills/github-operations/SKILL.md
 M platforms/linux/ubuntu/github-tools/README.md
?? .github/workflows/verify-wsl2.yml
?? docs/scripts/mcp_runtime.md
?? docs/scripts/setup-mcps.md
?? docs/wsl2-acceptance-2026-09-21.md
?? platforms/linux/ubuntu/computer-use/config/mcp-versions.json
?? platforms/linux/ubuntu/computer-use/scripts/mcp_runtime.py
?? platforms/linux/ubuntu/computer-use/scripts/setup-mcps.sh
?? platforms/windows/

Command exited with code 0.

---

## Assistant

_Thinking:_

**Planning focused MCP runtime review**

**Tool: read**

**Input:**
```json
{
  "path": "/home/brajam/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/mcp_runtime.py",
  "offset": 1,
  "limit": 400
}
```

Read file /home/brajam/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/mcp_runtime.py, lines 1-400
1: #!/usr/bin/env python3
2: """Canonical MCP policy, profile state, and runtime verification helpers."""
3: 
4: from __future__ import annotations
5: 
6: import argparse
7: import hashlib
8: import importlib.util
9: import json
10: import os
11: from pathlib import Path
12: import secrets
13: import shutil
14: import stat
15: import subprocess
16: import sys
17: import tarfile
18: import tempfile
19: from typing import Any
20: from urllib.request import urlopen
21: 
22: 
23: CANONICAL_ROOT = Path(__file__).resolve().parent.parent
24: POLICY_PATH = CANONICAL_ROOT / "config" / "mcp-versions.json"
25: SCRIPT_ROOT = CANONICAL_ROOT / "scripts"
26: MCP_NAMES = ("basic-memory", "github", "playwright")
27: MCP_PROFILES = ("native", "wsl2")
28: MAX_POLICY_BYTES = 64 * 1024
29: MAX_CONFIG_BYTES = 1024 * 1024
30: MAX_NODE_ARCHIVE_BYTES = 256 * 1024 * 1024
31: NATIVE_NOTES = Path.home() / "Documents" / "computer-assistant" / "basic-memory"
32: NATIVE_ROOT = Path.home() / ".local" / "share" / "opencode" / "mcp"
33: NATIVE_BROWSER_CACHE = Path.home() / ".cache" / "ms-playwright"
34: NATIVE_BASIC_COMMAND = "./platforms/linux/ubuntu/computer-use/scripts/basic-memory-mcp.sh"
35: NATIVE_PLAYWRIGHT_COMMAND = "./platforms/linux/ubuntu/computer-use/scripts/playwright-mcp.sh"
36: 
37: 
38: class McpRuntimeError(RuntimeError):
39:     """Raised when the canonical MCP policy or runtime is unsafe."""
40: 
41: 
42: def validate_profile(profile: str) -> None:
43:     """Reject profile names that could accidentally select another state root."""
44:     if profile not in MCP_PROFILES:
45:         raise McpRuntimeError(f"unsupported MCP profile: {profile}")
46: 
47: 
48: def _pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
49:     result: dict[str, Any] = {}
50:     for key, value in pairs:
51:         if key in result:
52:             raise McpRuntimeError(f"duplicate JSON key: {key}")
53:         result[key] = value
54:     return result
55: 
56: 
57: def _absolute(path: Path) -> Path:
58:     return Path(os.path.abspath(path.expanduser()))
59: 
60: 
61: def ensure_safe_path(path: Path, *, allow_missing: bool = True) -> Path:
62:     """Reject mounted/repository paths and symlinked ancestors."""
63:     absolute = _absolute(path)
64:     if absolute == Path("/mnt") or Path("/mnt") in absolute.parents:
65:         raise McpRuntimeError(f"refusing Windows-mounted MCP state: {absolute}")
66:     repository = _absolute(CANONICAL_ROOT.parents[3])
67:     if absolute == repository or repository in absolute.parents:
68:         raise McpRuntimeError(f"refusing MCP state beneath the repository workspace: {absolute}")
69:     current = Path("/")
70:     for index, part in enumerate(absolute.parts[1:]):
71:         current /= part
72:         try:
73:             metadata = current.lstat()
74:         except FileNotFoundError:
75:             if not allow_missing:
76:                 raise McpRuntimeError(f"required MCP path is missing: {current}") from None
77:             return absolute
78:         if stat.S_ISLNK(metadata.st_mode):
79:             raise McpRuntimeError(f"refusing symlinked MCP path or ancestor: {current}")
80:         if index < len(absolute.parts) - 2 and not stat.S_ISDIR(metadata.st_mode):
81:             raise McpRuntimeError(f"MCP path ancestor is not a directory: {current}")
82:     return absolute
83: 
84: 
85: def _read_regular(path: Path, *, limit: int = MAX_POLICY_BYTES) -> bytes:
86:     absolute = _absolute(path)
87:     try:
88:         metadata = absolute.lstat()
89:     except FileNotFoundError as error:
90:         raise McpRuntimeError(f"missing canonical MCP file: {absolute}") from error
91:     if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
92:         raise McpRuntimeError(f"canonical MCP file is not a regular file: {absolute}")
93:     if metadata.st_size > limit:
94:         raise McpRuntimeError(f"canonical MCP file exceeds {limit} bytes: {absolute}")
95:     try:
96:         return absolute.read_bytes()
97:     except OSError as error:
98:         raise McpRuntimeError(f"cannot read canonical MCP file: {absolute}: {error}") from error
99: 
100: 
101: def load_policy() -> dict[str, Any]:
102:     """Load the one checked-in MCP version and endpoint policy."""
103:     try:
104:         value = json.loads(_read_regular(POLICY_PATH).decode("utf-8"), object_pairs_hook=_pairs)
105:     except (UnicodeDecodeError, json.JSONDecodeError) as error:
106:         raise McpRuntimeError(f"cannot parse canonical MCP policy: {error}") from error
107:     if not isinstance(value, dict) or value.get("schemaVersion") != 1:
108:         raise McpRuntimeError("unsupported canonical MCP policy")
109:     if not isinstance(value.get("basicMemory"), str) or not isinstance(value.get("playwright"), str):
110:         raise McpRuntimeError("canonical MCP policy has invalid package versions")
111:     if value.get("githubRemote") != "https://api.githubcopilot.com/mcp/":
112:         raise McpRuntimeError("canonical GitHub MCP endpoint is not the hosted OAuth endpoint")
113:     if value.get("playwrightBrowser") != "chrome-for-testing" or not isinstance(
114:         value.get("playwrightBrowserRevision"), int
115:     ):
116:         raise McpRuntimeError("canonical Playwright browser pin is invalid")
117:     node_version = value.get("nodeVersion")
118:     node_archive = value.get("nodeArchive")
119:     node_sha256 = value.get("nodeSha256")
120:     node_url = value.get("nodeUrl")
121:     if (
122:         not isinstance(node_version, str)
123:         or not isinstance(node_archive, str)
124:         or not isinstance(node_sha256, str)
125:         or len(node_sha256) != 64
126:         or any(character not in "0123456789abcdef" for character in node_sha256.lower())
127:         or not isinstance(node_url, str)
128:         or not node_url.startswith("https://nodejs.org/dist/")
129:     ):
130:         raise McpRuntimeError("canonical Node.js runtime pin is invalid")
131:     expected_archive = f"node-v{node_version}-linux-x64.tar.xz"
132:     expected_url = f"https://nodejs.org/dist/v{node_version}/{expected_archive}"
133:     if node_archive != expected_archive or node_url != expected_url:
134:         raise McpRuntimeError("canonical Node.js archive and URL do not match the pinned version")
135:     return value
136: 
137: 
138: def expected_marker(profile: str) -> dict[str, Any]:
139:     """Return the exact marker payload for one isolated runtime profile."""
140:     validate_profile(profile)
141:     policy = load_policy()
142:     return {
143:         "schemaVersion": 1,
144:         "profile": profile,
145:         "basicMemory": policy["basicMemory"],
146:         "playwright": policy["playwright"],
147:         "playwrightBrowser": policy["playwrightBrowser"],
148:         "playwrightBrowserRevision": policy["playwrightBrowserRevision"],
149:         "githubRemote": policy["githubRemote"],
150:         "nodeVersion": policy["nodeVersion"],
151:     }
152: 
153: 
154: def profile_paths(profile_root: Path) -> dict[str, Path]:
155:     """Return private state paths for a profile without creating them."""
156:     root = ensure_safe_path(profile_root)
157:     policy = load_policy()
158:     return {
159:         "root": root,
160:         "basic": root / "mcp" / "basic-memory",
161:         "basic_home": root / "mcp" / "basic-memory" / "home",
162:         "basic_notes": root / "mcp" / "basic-memory" / "notes",
163:         "playwright": root / "mcp" / "playwright",
164:         "playwright_home": root / "mcp" / "playwright" / "home",
165:         "playwright_output": root / "mcp" / "playwright" / "output",
166:         "node_root": root / "mcp" / "node" / f"node-v{policy['nodeVersion']}-linux-x64",
167:         "uv_cache": root / "cache" / "uv",
168:         "uv_environments": root / "cache" / "uv" / "environments-v2",
169:         "uv_archive": root / "cache" / "uv" / "archive-v0",
170:         "npm_cache": root / "cache" / "npm",
171:         "npx_cache": root / "cache" / "npm" / "_npx",
172:         "browser_cache": root / "cache" / "ms-playwright",
173:         "marker": root / "mcp" / "provisioned.json",
174:     }
175: 
176: 
177: def native_paths() -> dict[str, Path]:
178:     """Return native user-local MCP state without borrowing WSL profile state."""
179:     root = ensure_safe_path(Path(os.environ.get("OPENCODE_MCP_NATIVE_ROOT", str(NATIVE_ROOT))))
180:     notes = ensure_safe_path(Path(os.environ.get("BASIC_MEMORY_HOME", str(NATIVE_NOTES))))
181:     browser_cache = ensure_safe_path(
182:         Path(os.environ.get("OPENCODE_MCP_NATIVE_BROWSER_CACHE", str(NATIVE_BROWSER_CACHE)))
183:     )
184:     policy = load_policy()
185:     node_root = root / "node" / f"node-v{policy['nodeVersion']}-linux-x64"
186:     return {
187:         "root": root,
188:         "basic": root / "basic-memory",
189:         "basic_config": root / "basic-memory" / "config",
190:         "basic_notes": notes,
191:         "playwright": root / "playwright",
192:         "playwright_output": root / "playwright" / "output",
193:         "browser_cache": browser_cache,
194:         "node_root": node_root,
195:         "marker": root / "provisioned.json",
196:     }
197: 
198: 
199: def prepare_profile(profile_root: Path, *, apply: bool) -> None:
200:     """Create or validate only the private directories owned by a profile."""
201:     paths = profile_paths(profile_root)
202:     directories = (
203:         paths["root"],
204:         paths["root"] / "workspace",
205:         paths["root"] / "config",
206:         paths["root"] / "xdg" / "opencode",
207:         paths["root"] / "data",
208:         paths["root"] / "state",
209:         paths["root"] / "cache",
210:         paths["basic"],
211:         paths["basic_home"],
212:         paths["basic_notes"],
213:         paths["playwright"],
214:         paths["playwright_home"],
215:         paths["playwright_output"],
216:         paths["node_root"].parent,
217:         paths["uv_cache"],
218:         paths["uv_environments"],
219:         paths["uv_archive"],
220:         paths["npm_cache"],
221:         paths["npx_cache"],
222:         paths["browser_cache"],
223:     )
224:     for directory in directories:
225:         ensure_safe_path(directory)
226:         if not apply:
227:             if not directory.is_dir() or directory.is_symlink():
228:                 raise McpRuntimeError(f"missing MCP profile directory: {directory}")
229:             continue
230:         directory.mkdir(mode=0o700, parents=True, exist_ok=True)
231:         metadata = directory.lstat()
232:         if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
233:             raise McpRuntimeError(f"MCP profile path is not a real directory: {directory}")
234:         directory.chmod(0o700)
235: 
236: 
237: def prepare_native(*, apply: bool) -> None:
238:     """Create or validate native user-local state and the Basic Memory notes root."""
239:     paths = native_paths()
240:     directories = (
241:         paths["root"],
242:         paths["basic"],
243:         paths["basic_config"],
244:         paths["playwright"],
245:         paths["playwright_output"],
246:         paths["basic_notes"],
247:     )
248:     for directory in directories:
249:         ensure_safe_path(directory)
250:         if not apply:
251:             if not directory.is_dir() or directory.is_symlink():
252:                 raise McpRuntimeError(f"missing native MCP directory: {directory}")
253:             continue
254:         directory.mkdir(mode=0o700, parents=True, exist_ok=True)
255:         metadata = directory.lstat()
256:         if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
257:             raise McpRuntimeError(f"native MCP path is not a real directory: {directory}")
258:         directory.chmod(0o700)
259: 
260: 
261: def _children(path: Path, *, allow_symlinks: bool = False) -> list[Path]:
262:     """Return direct children only when the parent is a real directory."""
263:     try:
264:         metadata = path.lstat()
265:         if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
266:             return []
267:         return [entry for entry in path.iterdir() if allow_symlinks or not entry.is_symlink()]
268:     except (FileNotFoundError, NotADirectoryError, OSError):
269:         return []
270: 
271: 
272: def _has_basic_memory_runtime(profile_root: Path, version: str) -> bool:
273:     """Find the pinned Basic Memory package in the profile's uv cache."""
274:     paths = profile_paths(profile_root)
275:     for scope in _children(paths["uv_environments"]):
276:         for entry in _children(scope, allow_symlinks=True):
277:             try:
278:                 metadata = entry.lstat()
279:                 if stat.S_ISLNK(metadata.st_mode):
280:                     environment = entry.resolve(strict=True)
281:                     if environment.parent != paths["uv_archive"]:
282:                         continue
283:                 elif stat.S_ISDIR(metadata.st_mode):
284:                     environment = entry
285:                 else:
286:                     continue
287:                 ensure_safe_path(environment, allow_missing=False)
288:                 executable = environment / "bin" / "basic-memory"
289:                 executable_metadata = executable.lstat()
290:                 if not stat.S_ISREG(executable_metadata.st_mode) or not os.access(executable, os.X_OK):
291:                     continue
292:                 for library in _children(environment / "lib"):
293:                     package = library / "site-packages" / f"basic_memory-{version}.dist-info"
294:                     if package.is_dir() and not package.is_symlink():
295:                         return True
296:             except (FileNotFoundError, OSError, RuntimeError):
297:                 continue
298:     return False
299: 
300: 
301: def _native_command_environment(paths: dict[str, Path]) -> dict[str, str]:
302:     """Build the bounded native Basic Memory environment used by uvx checks."""
303:     uvx = resolve_runner("uvx", os.environ.get("OPENCODE_MCP_UVX_BIN"))
304:     environment = os.environ.copy()
305:     environment.update(
306:         {
307:             "BASIC_MEMORY_HOME": str(paths["basic_notes"]),
308:             "BASIC_MEMORY_CONFIG_DIR": str(paths["basic_config"]),
309:             "BASIC_MEMORY_DEFAULT_PROJECT": "computer-assistant",
310:             "BASIC_MEMORY_NO_PROMOS": "1",
311:             "PATH": f"{uvx.parent}:{environment.get('PATH', '/usr/local/bin:/usr/bin:/bin')}",
312:         }
313:     )
314:     return environment
315: 
316: 
317: def _has_native_basic_memory_runtime(version: str) -> bool:
318:     """Check the pinned Basic Memory package through the trusted uvx cache."""
319:     paths = native_paths()
320:     try:
321:         result = subprocess.run(
322:             [
323:                 str(resolve_runner("uvx", os.environ.get("OPENCODE_MCP_UVX_BIN"))),
324:                 "--offline",
325:                 "--prerelease=allow",
326:                 "--from",
327:                 f"basic-memory=={version}",
328:                 "basic-memory",
329:                 "--version",
330:             ],
331:             check=False,
332:             capture_output=True,
333:             text=True,
334:             env=_native_command_environment(paths),
335:             timeout=45,
336:         )
337:     except (McpRuntimeError, OSError, subprocess.TimeoutExpired):
338:         return False
339:     return result.returncode == 0 and version in f"{result.stdout}\n{result.stderr}"
340: 
341: 
342: def _has_playwright_runtime(profile_root: Path, version: str) -> bool:
343:     """Find the pinned Playwright MCP package in the profile's npx cache."""
344:     paths = profile_paths(profile_root)
345:     for run in _children(paths["npx_cache"]):
346:         package = run / "node_modules" / "@playwright" / "mcp" / "package.json"
347:         try:
348:             if package.is_symlink() or not package.is_file():
349:                 continue
350:             value = json.loads(package.read_text(encoding="utf-8"))
351:             if isinstance(value, dict) and value.get("version") == version:
352:                 return True
353:         except (OSError, UnicodeDecodeError, json.JSONDecodeError):
354:             continue
355:     return False
356: 
357: 
358: def _has_node_runtime(version: str, *, profile: str, profile_root: Path | None = None) -> bool:
359:     """Require the selected profile's trusted Node and npm at the pinned version."""
360:     try:
361:         node = resolve_runner(
362:             "node", os.environ.get("OPENCODE_MCP_NODE_BIN"), profile=profile, profile_root=profile_root
363:         )
364:         npm = resolve_runner(
365:             "npm", os.environ.get("OPENCODE_MCP_NPM_BIN"), profile=profile, profile_root=profile_root
366:         )
367:         environment = os.environ.copy()
368:         environment["PATH"] = f"{node.parent}:{environment.get('PATH', '')}"
369:         node_result = subprocess.run(
370:             [str(node), "--version"], check=False, capture_output=True, text=True, env=environment, timeout=10
371:         )
372:         npm_result = subprocess.run(
373:             [str(npm), "--version"], check=False, capture_output=True, text=True, env=environment, timeout=10
374:         )
375:     except (McpRuntimeError, OSError, subprocess.TimeoutExpired):
376:         return False
377:     return node_result.returncode == 0 and node_result.stdout.strip() == f"v{version}" and npm_result.returncode == 0
378: 
379: 
380: def _has_native_playwright_runtime(version: str) -> bool:
381:     """Check the locked repository Playwright package and trusted Node runtime."""
382:     project = CANONICAL_ROOT.parent / "browser-tools"
383:     package = project / "node_modules" / "@playwright" / "mcp" / "package.json"
384:     launcher = project / "node_modules" / ".bin" / "playwright-mcp"
385:     browser = project / "node_modules" / ".bin" / "playwright"
386:     try:
387:         value = json.loads(_read_regular(package, limit=256 * 1024).decode("utf-8"))
388:         package_version = value.get("version") if isinstance(value, dict) else None
389:         launcher_metadata = launcher.resolve(strict=True).lstat()
390:         browser_metadata = browser.resolve(strict=True).lstat()
391:     except (McpRuntimeError, UnicodeDecodeError, json.JSONDecodeError, OSError, RuntimeError):
392:         return False
393:     return (
394:         package_version == version
395:         and stat.S_ISREG(launcher_metadata.st_mode)
396:         and os.access(launcher, os.X_OK)
397:         and stat.S_ISREG(browser_metadata.st_mode)
398:         and os.access(browser, os.X_OK)
399:         and _has_node_runtime(str(load_policy()["nodeVersion"]), profile="native")
400:     )
[Output truncated. Continue reading with offset: 401]

**Tool: read**

**Input:**
```json
{
  "path": "/home/brajam/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/mcp_runtime.py",
  "offset": 401,
  "limit": 400
}
```

Read file /home/brajam/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/mcp_runtime.py, lines 401-800
401: 
402: 
403: def _has_browser(profile_root: Path | None, revision: int, *, profile: str) -> bool:
404:     browser_root = profile_paths(profile_root)["browser_cache"] if profile == "wsl2" and profile_root else native_paths()["browser_cache"]
405:     browser = browser_root / f"chromium-{revision}" / "chrome-linux64" / "chrome"
406:     try:
407:         metadata = browser.lstat()
408:     except FileNotFoundError:
409:         return False
410:     return stat.S_ISREG(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode) and os.access(browser, os.X_OK)
411: 
412: 
413: def _load_marker(path: Path) -> dict[str, Any]:
414:     try:
415:         value = json.loads(_read_regular(path).decode("utf-8"), object_pairs_hook=_pairs)
416:     except (UnicodeDecodeError, json.JSONDecodeError) as error:
417:         raise McpRuntimeError(f"cannot parse MCP provisioning marker: {error}") from error
418:     if not isinstance(value, dict):
419:         raise McpRuntimeError("MCP provisioning marker is not an object")
420:     return value
421: 
422: 
423: def _write_marker(path: Path, value: dict[str, Any]) -> None:
424:     ensure_safe_path(path)
425:     path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
426:     if path.exists() or path.is_symlink():
427:         metadata = path.lstat()
428:         if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
429:             raise McpRuntimeError(f"MCP marker is not a regular file: {path}")
430:         mode = stat.S_IMODE(metadata.st_mode)
431:     else:
432:         mode = 0o600
433:     temporary = path.parent / f".{path.name}.{secrets.token_hex(12)}.tmp"
434:     try:
435:         with temporary.open("x", encoding="utf-8") as handle:
436:             json.dump(value, handle, indent=2)
437:             handle.write("\n")
438:         temporary.chmod(mode)
439:         os.replace(temporary, path)
440:     except OSError as error:
441:         try:
442:             temporary.unlink()
443:         except FileNotFoundError:
444:             pass
445:         raise McpRuntimeError(f"cannot write MCP provisioning marker: {error}") from error
446: 
447: 
448: def mcp_provisioning(
449:     profile_root: Path | None = None,
450:     *,
451:     profile: str = "native",
452:     apply: bool,
453:     quiet: bool = False,
454: ) -> None:
455:     """Verify or record the exact local runtimes for one selected profile."""
456:     validate_profile(profile)
457:     expected = expected_marker(profile)
458:     if profile == "native":
459:         paths = native_paths()
460:         if profile_root is not None:
461:             raise McpRuntimeError("native MCP provisioning does not accept an isolated profile root")
462:         if apply:
463:             prepare_native(apply=True)
464:         elif _load_marker(paths["marker"]) != expected:
465:             raise McpRuntimeError("native MCP provisioning marker is missing or stale; rerun setup-mcps.sh --apply")
466:         if not _has_native_basic_memory_runtime(str(expected["basicMemory"])):
467:             raise McpRuntimeError("Basic Memory's canonical pinned native runtime is missing")
468:         if not _has_node_runtime(str(expected["nodeVersion"]), profile="native"):
469:             raise McpRuntimeError("the canonical pinned native Node.js runtime is missing")
470:         if not _has_native_playwright_runtime(str(expected["playwright"])):
471:             raise McpRuntimeError("Playwright MCP's canonical pinned native runtime is missing")
472:         if not _has_browser(None, int(expected["playwrightBrowserRevision"]), profile="native"):
473:             raise McpRuntimeError("the canonical pinned native Playwright browser is missing")
474:     else:
475:         if profile_root is None:
476:             raise McpRuntimeError("wsl2 MCP provisioning requires an isolated profile root")
477:         paths = profile_paths(profile_root)
478:         if apply:
479:             prepare_profile(profile_root, apply=True)
480:         elif _load_marker(paths["marker"]) != expected:
481:             raise McpRuntimeError("WSL2 MCP provisioning marker is missing or stale; rerun setup-mcps.sh --apply")
482:         if not _has_basic_memory_runtime(profile_root, str(expected["basicMemory"])):
483:             raise McpRuntimeError("Basic Memory's canonical pinned WSL2 runtime is missing")
484:         if not _has_node_runtime(str(expected["nodeVersion"]), profile="wsl2", profile_root=profile_root):
485:             raise McpRuntimeError("the canonical pinned WSL2 Node.js runtime is missing")
486:         if not _has_playwright_runtime(profile_root, str(expected["playwright"])):
487:             raise McpRuntimeError("Playwright MCP's canonical pinned WSL2 runtime is missing")
488:         if not _has_browser(profile_root, int(expected["playwrightBrowserRevision"]), profile="wsl2"):
489:             raise McpRuntimeError("the canonical pinned WSL2 Playwright browser is missing")
490:     if apply:
491:         _write_marker(paths["marker"], expected)
492:     if not quiet:
493:         print(f"OK: canonical {profile} MCP runtimes are provisioned: {paths['marker']}")
494: 
495: 
496: def _wrapper(name: str) -> Path:
497:     path = SCRIPT_ROOT / name
498:     try:
499:         metadata = path.lstat()
500:     except FileNotFoundError as error:
501:         raise McpRuntimeError(f"missing canonical MCP launcher: {path}") from error
502:     if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode) or not os.access(path, os.X_OK):
503:         raise McpRuntimeError(f"canonical MCP launcher is not a regular executable: {path}")
504:     return path
505: 
506: 
507: def mcp_servers(profile: str = "native", profile_root: Path | None = None) -> dict[str, dict[str, Any]]:
508:     """Return the one shared MCP declaration set for a native or WSL profile."""
509:     validate_profile(profile)
510:     policy = load_policy()
511:     basic = _wrapper("basic-memory-mcp.sh")
512:     playwright = _wrapper("playwright-mcp.sh")
513:     timeout = {"startup": 30_000}
514:     entries: dict[str, dict[str, Any]] = {
515:         "basic-memory": {"type": "local", "command": [NATIVE_BASIC_COMMAND], "disabled": False, "timeout": timeout.copy()},
516:         "github": {"type": "remote", "url": policy["githubRemote"], "disabled": False, "timeout": timeout.copy()},
517:         "playwright": {"type": "local", "command": [NATIVE_PLAYWRIGHT_COMMAND], "disabled": False, "timeout": timeout.copy()},
518:     }
519:     if profile == "native":
520:         if profile_root is not None:
521:             raise McpRuntimeError("native MCP declarations do not accept an isolated profile root")
522:         _wrapper("basic-memory-mcp.sh")
523:         _wrapper("playwright-mcp.sh")
524:         return entries
525:     if profile != "wsl2" or profile_root is None:
526:         raise McpRuntimeError(f"unsupported MCP profile: {profile}")
527:     root = ensure_safe_path(profile_root)
528:     environment = {
529:         "OPENCODE_MCP_PROFILE": "wsl2",
530:         "OPENCODE_MCP_PROFILE_ROOT": str(root),
531:     }
532:     for name in ("basic-memory", "playwright"):
533:         entries[name]["command"] = [str(basic if name == "basic-memory" else playwright)]
534:         entries[name]["cwd"] = str(root / "workspace")
535:         entries[name]["environment"] = environment
536:     return entries
537: 
538: 
539: def ensure_mcp_servers(data: dict[str, Any], *, profile: str, profile_root: Path | None = None) -> None:
540:     """Merge only the canonical MCP entries into one server config."""
541:     mcp = data.setdefault("mcp", {})
542:     if not isinstance(mcp, dict):
543:         raise McpRuntimeError("mcp must be an object")
544:     timeout = mcp.setdefault("timeout", {})
545:     if not isinstance(timeout, dict):
546:         raise McpRuntimeError("mcp.timeout must be an object")
547:     timeout.update({"startup": 90_000, "catalog": 30_000, "execution": 600_000})
548:     servers = mcp.setdefault("servers", {})
549:     if not isinstance(servers, dict):
550:         raise McpRuntimeError("mcp.servers must be an object")
551:     servers.update(mcp_servers(profile, profile_root))
552: 
553: 
554: def verify_mcp_servers(data: dict[str, Any], *, profile: str, profile_root: Path | None = None) -> None:
555:     """Require the exact shared declarations and reject credential fields."""
556:     mcp = data.get("mcp")
557:     servers = mcp.get("servers") if isinstance(mcp, dict) else None
558:     if not isinstance(servers, dict):
559:         raise McpRuntimeError("mcp.servers must be configured")
560:     expected = mcp_servers(profile, profile_root)
561:     if set(servers) != set(MCP_NAMES):
562:         raise McpRuntimeError(f"MCP server set is not exactly canonical: {sorted(servers)}")
563:     for name in MCP_NAMES:
564:         if servers.get(name) != expected[name]:
565:             raise McpRuntimeError(f"MCP server {name} is not exactly canonical")
566:     serialized = json.dumps({name: servers[name] for name in MCP_NAMES}).lower()
567:     for marker in ("authorization", "personal_access_token", "api_key", "client_secret", "bearer", "token"):
568:         if marker in serialized:
569:             raise McpRuntimeError(f"credential field is forbidden in canonical MCP configuration: {marker}")
570: 
571: 
572: def global_mcp_servers() -> dict[str, dict[str, Any]]:
573:     """Return native global declarations without project-owned Playwright."""
574:     entries = mcp_servers("native")
575:     entries["basic-memory"]["command"] = [str(_wrapper("basic-memory-mcp.sh"))]
576:     return {name: entries[name] for name in ("basic-memory", "github")}
577: 
578: 
579: def ensure_global_mcp_servers(data: dict[str, Any]) -> None:
580:     """Normalize only shared native global MCP entries and preserve unrelated servers."""
581:     mcp = data.setdefault("mcp", {})
582:     if not isinstance(mcp, dict):
583:         raise McpRuntimeError("mcp must be an object")
584:     for name in MCP_NAMES:
585:         mcp.pop(name, None)
586:     servers = mcp.setdefault("servers", {})
587:     if not isinstance(servers, dict):
588:         raise McpRuntimeError("mcp.servers must be an object")
589:     servers.pop("playwright", None)
590:     servers.update(global_mcp_servers())
591: 
592: 
593: def verify_global_mcp_servers(data: dict[str, Any]) -> None:
594:     """Require canonical global Basic Memory/GitHub entries and no Playwright copy."""
595:     mcp = data.get("mcp")
596:     servers = mcp.get("servers") if isinstance(mcp, dict) else None
597:     if not isinstance(servers, dict):
598:         raise McpRuntimeError("mcp.servers must be configured")
599:     if "playwright" in servers:
600:         raise McpRuntimeError("global MCP configuration must not duplicate project Playwright")
601:     expected = global_mcp_servers()
602:     for name, entry in expected.items():
603:         if servers.get(name) != entry:
604:             raise McpRuntimeError(f"global MCP server {name} is not exactly canonical")
605:     if any(name in mcp for name in MCP_NAMES):
606:         raise McpRuntimeError("legacy flat MCP declarations remain in global configuration")
607:     serialized = json.dumps({name: servers[name] for name in expected}).lower()
608:     for marker in ("authorization", "personal_access_token", "api_key", "client_secret", "bearer", "token"):
609:         if marker in serialized:
610:             raise McpRuntimeError(f"credential field is forbidden in canonical MCP configuration: {marker}")
611: 
612: 
613: def _config_helper() -> Any:
614:     """Load the repository's strict JSONC parser without creating another parser."""
615:     helper_path = SCRIPT_ROOT / "setup-opencode-jsonc.py"
616:     spec = importlib.util.spec_from_file_location("mcp_runtime_jsonc", helper_path)
617:     if spec is None or spec.loader is None:
618:         raise McpRuntimeError("cannot load strict JSONC helper")
619:     module = importlib.util.module_from_spec(spec)
620:     spec.loader.exec_module(module)
621:     return module
622: 
623: 
624: def load_config(path: Path) -> dict[str, Any]:
625:     """Load one bounded regular OpenCode JSON/JSONC configuration object."""
626:     try:
627:         text = _read_regular(path, limit=MAX_CONFIG_BYTES).decode("utf-8")
628:         value = _config_helper().parse_jsonc(text)
629:     except (UnicodeDecodeError, ValueError) as error:
630:         raise McpRuntimeError(f"cannot parse OpenCode configuration {path}: {error}") from error
631:     if not isinstance(value, dict):
632:         raise McpRuntimeError(f"OpenCode configuration is not an object: {path}")
633:     return value
634: 
635: 
636: def write_config(path: Path, value: dict[str, Any]) -> None:
637:     """Atomically write one existing regular config without following symlinks."""
638:     absolute = _absolute(path)
639:     parent = absolute.parent
640:     current = Path("/")
641:     for part in parent.parts[1:]:
642:         current /= part
643:         metadata = current.lstat()
644:         if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
645:             raise McpRuntimeError(f"refusing unsafe configuration path ancestor: {current}")
646:     metadata = absolute.lstat()
647:     if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
648:         raise McpRuntimeError(f"configuration target is not a regular file: {absolute}")
649:     encoded = (json.dumps(value, indent=2) + "\n").encode("utf-8")
650:     if len(encoded) > MAX_CONFIG_BYTES:
651:         raise McpRuntimeError("canonical MCP configuration exceeds the bounded size")
652:     temporary = parent / f".{absolute.name}.{secrets.token_hex(12)}.tmp"
653:     try:
654:         with temporary.open("xb") as handle:
655:             handle.write(encoded)
656:         temporary.chmod(stat.S_IMODE(metadata.st_mode))
657:         os.replace(temporary, absolute)
658:     except OSError as error:
659:         try:
660:             temporary.unlink()
661:         except FileNotFoundError:
662:             pass
663:         raise McpRuntimeError(f"cannot write OpenCode configuration {absolute}: {error}") from error
664: 
665: 
666: def configure_mcp_file(path: Path, *, scope: str, apply: bool) -> None:
667:     """Verify or normalize one selected MCP configuration scope."""
668:     data = load_config(path)
669:     if scope == "project":
670:         if apply:
671:             raise McpRuntimeError("the portable project configuration is verification-only")
672:         verify_mcp_servers(data, profile="native")
673:         return
674:     if scope != "global":
675:         raise McpRuntimeError(f"unsupported MCP configuration scope: {scope}")
676:     if apply:
677:         ensure_global_mcp_servers(data)
678:         write_config(path, data)
679:     verify_global_mcp_servers(data)
680: 
681: 
682: def verify_basic_memory_project(config_path: Path, *, project: str, notes: Path) -> None:
683:     """Require one local Basic Memory project to resolve to the selected notes root."""
684:     if not project or project.strip() != project:
685:         raise McpRuntimeError("Basic Memory project name must be non-empty without surrounding whitespace")
686:     expected_notes = ensure_safe_path(notes, allow_missing=False)
687:     try:
688:         value = json.loads(
689:             _read_regular(config_path, limit=MAX_CONFIG_BYTES).decode("utf-8"),
690:             object_pairs_hook=_pairs,
691:         )
692:     except (UnicodeDecodeError, json.JSONDecodeError) as error:
693:         raise McpRuntimeError(f"cannot parse Basic Memory configuration {config_path}: {error}") from error
694:     if not isinstance(value, dict):
695:         raise McpRuntimeError(f"Basic Memory configuration is not an object: {config_path}")
696:     projects = value.get("projects")
697:     entry = projects.get(project) if isinstance(projects, dict) else None
698:     if not isinstance(entry, dict):
699:         raise McpRuntimeError(f"Basic Memory project is not registered: {project}")
700:     configured_path = entry.get("path")
701:     if not isinstance(configured_path, str):
702:         raise McpRuntimeError(f"Basic Memory project path is invalid: {project}")
703:     if ensure_safe_path(Path(configured_path), allow_missing=False) != expected_notes:
704:         raise McpRuntimeError(f"Basic Memory project {project} does not use the canonical notes root")
705:     if entry.get("mode") != "local":
706:         raise McpRuntimeError(f"Basic Memory project {project} is not local")
707:     if value.get("default_project") != project:
708:         raise McpRuntimeError(f"Basic Memory project {project} is not the default")
709: 
710: 
711: def _runner_candidates(kind: str, *, profile: str, profile_root: Path | None = None) -> list[Path]:
712:     """Return runners owned by the selected profile without cross-profile fallback."""
713:     validate_profile(profile)
714:     home = Path.home()
715:     if profile == "native":
716:         node_bin = native_paths()["node_root"] / "bin"
717:     else:
718:         if profile_root is None:
719:             raise McpRuntimeError("WSL2 runner resolution requires an isolated profile root")
720:         node_bin = profile_paths(profile_root)["node_root"] / "bin"
721:     values = {
722:         "uvx": (home / ".local/bin/uvx", Path("/usr/local/bin/uvx"), Path("/usr/bin/uvx")),
723:         "npx": (node_bin / "npx",),
724:         "npm": (node_bin / "npm",),
725:         "node": (node_bin / "node",),
726:     }
727:     if kind not in values:
728:         raise McpRuntimeError(f"unsupported trusted MCP runner: {kind}")
729:     return list(values[kind])
730: 
731: 
732: def resolve_runner(
733:     kind: str,
734:     override: str | None = None,
735:     *,
736:     profile: str = "native",
737:     profile_root: Path | None = None,
738: ) -> Path:
739:     """Select an absolute executable owned by root/current user and not writable."""
740:     canonical = _runner_candidates(kind, profile=profile, profile_root=profile_root)
741:     candidates = [Path(override)] if override else canonical
742:     user_id = os.getuid()
743:     for candidate in candidates:
744:         if not candidate.is_absolute():
745:             continue
746:         try:
747:             resolved = candidate.resolve(strict=True)
748:             metadata = resolved.lstat()
749:         except (FileNotFoundError, OSError, RuntimeError):
750:             continue
751:         if not stat.S_ISREG(metadata.st_mode) or not os.access(resolved, os.X_OK):
752:             continue
753:         if metadata.st_uid not in (0, user_id) or stat.S_IMODE(metadata.st_mode) & 0o022:
754:             continue
755:         if kind in ("node", "npm", "npx"):
756:             try:
757:                 expected = canonical[0].resolve(strict=False)
758:             except (OSError, RuntimeError):
759:                 continue
760:             if resolved != expected:
761:                 continue
762:         return resolved
763:     raise McpRuntimeError(f"{kind} is required at an absolute regular executable path owned by root or the current user")
764: 
765: 
766: def ensure_node(*, profile: str, profile_root: Path | None = None, apply: bool) -> Path:
767:     """Return or install the selected profile's checksum-pinned Node release."""
768:     validate_profile(profile)
769:     if profile == "native":
770:         if profile_root is not None:
771:             raise McpRuntimeError("native Node.js provisioning does not accept an isolated profile root")
772:         paths = native_paths()
773:     else:
774:         if profile_root is None:
775:             raise McpRuntimeError("WSL2 Node.js provisioning requires an isolated profile root")
776:         paths = profile_paths(profile_root)
777:     policy = load_policy()
778:     try:
779:         node = resolve_runner(
780:             "node",
781:             os.environ.get("OPENCODE_MCP_NODE_BIN"),
782:             profile=profile,
783:             profile_root=profile_root,
784:         )
785:         if _has_node_runtime(str(policy["nodeVersion"]), profile=profile, profile_root=profile_root):
786:             return node
787:     except McpRuntimeError:
788:         node = None
789:     if not apply:
790:         raise McpRuntimeError(
791:             f"trusted Node.js {policy['nodeVersion']} is unavailable; rerun setup-mcps.sh --apply"
792:         )
793:     root = paths["node_root"]
794:     ensure_safe_path(root)
795:     if root.exists() or root.is_symlink():
796:         raise McpRuntimeError(f"pinned Node.js target exists but is not usable: {root}")
797:     root.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
798:     archive_name = str(policy["nodeArchive"])
799:     temporary_root = Path(tempfile.mkdtemp(prefix="node-runtime-", dir=str(root.parent)))
800:     archive_path = temporary_root / archive_name
[Output truncated. Continue reading with offset: 801]

**Tool: read**

**Input:**
```json
{
  "path": "/home/brajam/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/basic-memory-mcp.sh",
  "offset": 1,
  "limit": 320
}
```

Read file /home/brajam/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/basic-memory-mcp.sh, lines 1-256
1: #!/usr/bin/env bash
2: # Launch the canonical Basic Memory MCP with bounded memory and profile state.
3: set -euo pipefail
4: 
5: SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
6: RUNTIME="$SCRIPT_DIR/mcp_runtime.py"
7: PROFILE="${OPENCODE_MCP_PROFILE:-native}"
8: PROFILE_ROOT="${OPENCODE_MCP_PROFILE_ROOT:-${OPENCODE_WSL2_PILOT_DIR:-$HOME/.opencode-wsl2-pilot}}"
9: NATIVE_ROOT="${OPENCODE_MCP_NATIVE_ROOT:-$HOME/.local/share/opencode/mcp}"
10: NATIVE_NOTES="${BASIC_MEMORY_HOME:-$HOME/Documents/computer-assistant/basic-memory}"
11: NATIVE_CONFIG="$NATIVE_ROOT/basic-memory/config"
12: PROJECT="${BASIC_MEMORY_PROJECT:-computer-assistant}"
13: VERSION="$(python3 "$RUNTIME" policy --kind uvx)"
14: MEMORY_FRACTION=20
15: SWAP_FRACTION=25
16: MINIMUM_BUDGET_BYTES=$((64 * 1024 * 1024))
17: 
18: fail() {
19:   printf 'basic-memory-mcp: %s\n' "$*" >&2
20:   exit 2
21: }
22: 
23: usage() {
24:   cat <<'EOF'
25: Usage: basic-memory-mcp.sh [--verify-only|--provision]
26: 
27: Options:
28:   --verify-only   Print the resolved binary, project, limiter, and budget
29:   --provision     Populate the selected profile's pinned Basic Memory runtime
30:   -h, --help      Show this help
31: 
32: Environment:
33:   OPENCODE_MCP_PROFILE       native (default) or wsl2
34:   OPENCODE_MCP_PROFILE_ROOT  private WSL/profile state root
35:   BASIC_MEMORY_PROJECT       Basic Memory project (default: computer-assistant)
36:   BASIC_MEMORY_HOME          native notes/index root (default: ~/Documents/computer-assistant/basic-memory)
37:   OPENCODE_MCP_NATIVE_ROOT  native private runtime state root
38:   OPENCODE_MCP_UVX_BIN       trusted uvx override
39: EOF
40: }
41: 
42: VERIFY_ONLY=0
43: PROVISION=0
44: while [ "$#" -gt 0 ]; do
45:   case "$1" in
46:     --verify-only) VERIFY_ONLY=1; shift ;;
47:     --provision) PROVISION=1; shift ;;
48:     -h|--help) usage; exit 0 ;;
49:     *) usage >&2; exit 2 ;;
50:   esac
51: done
52: [ "$VERIFY_ONLY" -eq 0 ] || [ "$PROVISION" -eq 0 ] || fail "--verify-only and --provision are mutually exclusive"
53: case "$PROFILE" in
54:   native|wsl2) ;;
55:   *) fail "unsupported MCP profile: $PROFILE" ;;
56: esac
57: 
58: read_meminfo_kib() {
59:   local wanted="$1"
60:   local key value _unit
61:   [ -r /proc/meminfo ] || return 1
62:   while read -r key value _unit; do
63:     if [ "$key" = "$wanted:" ] && [[ "$value" =~ ^[0-9]+$ ]]; then
64:       printf '%s\n' "$value"
65:       return 0
66:     fi
67:   done < /proc/meminfo
68:   return 1
69: }
70: 
71: read_numeric_file() {
72:   local path="$1"
73:   local value
74:   [ -r "$path" ] || return 1
75:   read -r value < "$path" || return 1
76:   [[ "$value" =~ ^[0-9]+$ ]] || return 1
77:   printf '%s\n' "$value"
78: }
79: 
80: cgroup_path() {
81:   local _hierarchy controllers path
82:   [ -r /proc/self/cgroup ] || return 1
83:   while IFS=: read -r _hierarchy controllers path; do
84:     if [ -z "$controllers" ]; then
85:       printf '/sys/fs/cgroup%s\n' "$path"
86:       return 0
87:     fi
88:   done < /proc/self/cgroup
89:   return 1
90: }
91: 
92: effective_available_bytes() {
93:   local host_kib host_bytes group_dir group_max group_current group_bytes
94:   host_kib="$(read_meminfo_kib MemAvailable || true)"
95:   [ -n "$host_kib" ] || fail "cannot read MemAvailable from /proc/meminfo"
96:   host_bytes=$((host_kib * 1024))
97:   group_dir="$(cgroup_path || true)"
98:   if [ -n "$group_dir" ]; then
99:     group_max="$(read_numeric_file "$group_dir/memory.max" || true)"
100:     group_current="$(read_numeric_file "$group_dir/memory.current" || true)"
101:     if [ -n "$group_max" ] && [ -n "$group_current" ] && [ "$group_max" -gt "$group_current" ]; then
102:       group_bytes=$((group_max - group_current))
103:       if [ "$group_bytes" -lt "$host_bytes" ]; then host_bytes="$group_bytes"; fi
104:     fi
105:   fi
106:   printf '%s\n' "$host_bytes"
107: }
108: 
109: effective_swap_free_bytes() {
110:   local swap_kib swap_bytes group_dir group_max group_current group_bytes
111:   swap_kib="$(read_meminfo_kib SwapFree || true)"
112:   swap_bytes=0
113:   if [ -n "$swap_kib" ]; then swap_bytes=$((swap_kib * 1024)); fi
114:   group_dir="$(cgroup_path || true)"
115:   if [ -n "$group_dir" ]; then
116:     group_max="$(read_numeric_file "$group_dir/memory.swap.max" || true)"
117:     group_current="$(read_numeric_file "$group_dir/memory.swap.current" || true)"
118:     if [ -n "$group_max" ] && [ -n "$group_current" ] && [ "$group_max" -gt "$group_current" ]; then
119:       group_bytes=$((group_max - group_current))
120:       if [ "$group_bytes" -lt "$swap_bytes" ]; then swap_bytes="$group_bytes"; fi
121:     fi
122:   fi
123:   printf '%s\n' "$swap_bytes"
124: }
125: 
126: AVAILABLE_BYTES="$(effective_available_bytes)"
127: BUDGET_BYTES=$((AVAILABLE_BYTES * MEMORY_FRACTION / 100))
128: [ "$BUDGET_BYTES" -ge "$MINIMUM_BUDGET_BYTES" ] || fail "only ${AVAILABLE_BYTES} bytes are available; refusing to start without a usable budget"
129: SWAP_FREE_BYTES="$(effective_swap_free_bytes)"
130: SWAP_BUDGET_BYTES=$((SWAP_FREE_BYTES * SWAP_FRACTION / 100))
131: BUDGET_SWAP=$((BUDGET_BYTES * SWAP_FRACTION / 100))
132: if [ "$SWAP_BUDGET_BYTES" -gt "$BUDGET_SWAP" ]; then SWAP_BUDGET_BYTES="$BUDGET_SWAP"; fi
133: 
134: if [ "$PROFILE" = "wsl2" ]; then
135:   [[ "$PROFILE_ROOT" = /* ]] || fail "wsl2 MCP profile root must be absolute"
136:   if [ "$PROVISION" -eq 1 ]; then
137:     python3 "$RUNTIME" prepare --profile "$PROFILE" --profile-root "$PROFILE_ROOT" --apply --quiet
138:   fi
139:   UVX="$(python3 "$RUNTIME" runner --kind uvx --override "${OPENCODE_MCP_UVX_BIN:-}" 2>/dev/null || true)"
140:   [ -n "$UVX" ] || fail "no trusted uvx runner is available"
141:   MCP_ROOT="$PROFILE_ROOT/mcp/basic-memory"
142:   environment=(
143:     "HOME=$MCP_ROOT/home"
144:     "BASIC_MEMORY_HOME=$MCP_ROOT/notes"
145:     "BASIC_MEMORY_CONFIG_DIR=$MCP_ROOT/home"
146:     "BASIC_MEMORY_DEFAULT_PROJECT=$PROJECT"
147:     "BASIC_MEMORY_NO_PROMOS=1"
148:     "UV_CACHE_DIR=$PROFILE_ROOT/cache/uv"
149:     "PATH=$(dirname "$UVX"):/usr/local/bin:/usr/bin:/bin"
150:     "LANG=${LANG:-C.UTF-8}"
151:   )
152:   for name in HTTPS_PROXY https_proxy ALL_PROXY all_proxy NO_PROXY no_proxy SSL_CERT_FILE SSL_CERT_DIR; do
153:     if [[ -n "${!name:-}" ]]; then environment+=("$name=${!name}"); fi
154:   done
155:   SYSTEMD_RUN="$(command -v systemd-run || true)"
156:   SYSTEMCTL="$(command -v systemctl || true)"
157:   PRLIMIT="$(command -v prlimit || true)"
158:   user_systemd_available() { [ -n "$SYSTEMD_RUN" ] && [ -n "$SYSTEMCTL" ] && "$SYSTEMCTL" --user show-environment >/dev/null 2>&1; }
159:   if user_systemd_available; then
160:     LIMITER="systemd-run"
161:   elif [ -n "$PRLIMIT" ]; then
162:     LIMITER="prlimit"
163:   else
164:     fail "no memory limiter available (needs systemd-run --user with systemctl --user, or prlimit)"
165:   fi
166:   run_limited() {
167:     if [ "$LIMITER" = "systemd-run" ]; then
168:       "$SYSTEMD_RUN" --user --pipe --wait --collect --service-type=exec \
169:         "--working-directory=$PWD" "--property=MemoryMax=$BUDGET_BYTES" \
170:         "--property=MemorySwapMax=$SWAP_BUDGET_BYTES" -- \
171:         /usr/bin/env -i "${environment[@]}" "$@"
172:     fi
173:     /usr/bin/env -i "${environment[@]}" "$PRLIMIT" "--as=$BUDGET_BYTES" -- "$@"
174:   }
175:   if [ "$PROVISION" -eq 1 ]; then
176:     run_limited "$UVX" --prerelease=allow --from "basic-memory==$VERSION" basic-memory --version
177:     if ! python3 "$RUNTIME" basic-project --config "$MCP_ROOT/home/config.json" --notes "$MCP_ROOT/notes" --project "$PROJECT" --quiet; then
178:       run_limited "$UVX" --offline --prerelease=allow --from "basic-memory==$VERSION" \
179:         basic-memory project add "$PROJECT" "$MCP_ROOT/notes" --local --default
180:     fi
181:   fi
182:   if [ "$VERIFY_ONLY" -eq 1 ]; then
183:     python3 "$RUNTIME" mcp-runtime --profile "$PROFILE" --profile-root "$PROFILE_ROOT" --quiet
184:   elif [ "$PROVISION" -eq 0 ]; then
185:     python3 "$RUNTIME" mcp-runtime --profile "$PROFILE" --profile-root "$PROFILE_ROOT" --quiet
186:   fi
187:   python3 "$RUNTIME" basic-project --config "$MCP_ROOT/home/config.json" --notes "$MCP_ROOT/notes" --project "$PROJECT" --quiet
188:   if [ "$VERIFY_ONLY" -eq 1 ]; then
189:     printf 'binary=%s\n' "$UVX"
190:     printf 'project=%s\n' "$PROJECT"
191:     printf 'limiter=%s\n' "$LIMITER"
192:     printf 'available_bytes=%s\n' "$AVAILABLE_BYTES"
193:     printf 'memory_budget_bytes=%s\n' "$BUDGET_BYTES"
194:     printf 'swap_budget_bytes=%s\n' "$SWAP_BUDGET_BYTES"
195:     exit 0
196:   fi
197:   run_limited "$UVX" --offline --prerelease=allow --from "basic-memory==$VERSION" basic-memory mcp --project "$PROJECT"
198:   exit $?
199: fi
200: 
201: NATIVE_UVX="$(python3 "$RUNTIME" runner --kind uvx --override "${OPENCODE_MCP_UVX_BIN:-}" 2>/dev/null || true)"
202: [ -n "$NATIVE_UVX" ] || fail "no trusted uvx runner is available"
203: environment=(
204:   "HOME=$HOME"
205:   "BASIC_MEMORY_HOME=$NATIVE_NOTES"
206:   "BASIC_MEMORY_CONFIG_DIR=$NATIVE_CONFIG"
207:   "BASIC_MEMORY_DEFAULT_PROJECT=$PROJECT"
208:   "BASIC_MEMORY_NO_PROMOS=1"
209:   "PATH=$(dirname "$NATIVE_UVX"):/usr/local/bin:/usr/bin:/bin"
210:   "LANG=${LANG:-C.UTF-8}"
211: )
212: for name in HTTPS_PROXY https_proxy ALL_PROXY all_proxy NO_PROXY no_proxy SSL_CERT_FILE SSL_CERT_DIR; do
213:   if [[ -n "${!name:-}" ]]; then environment+=("$name=${!name}"); fi
214: done
215: if [ "$PROVISION" -eq 1 ]; then
216:   python3 "$RUNTIME" prepare --profile native --apply --quiet
217:   /usr/bin/env -i "${environment[@]}" "$NATIVE_UVX" --prerelease=allow --from "basic-memory==$VERSION" basic-memory --version
218:   if ! python3 "$RUNTIME" basic-project --config "$NATIVE_CONFIG/config.json" --notes "$NATIVE_NOTES" --project "$PROJECT" --quiet; then
219:     /usr/bin/env -i "${environment[@]}" "$NATIVE_UVX" --offline --prerelease=allow \
220:       --from "basic-memory==$VERSION" basic-memory project add "$PROJECT" "$NATIVE_NOTES" --local --default
221:   fi
222:   python3 "$RUNTIME" basic-project --config "$NATIVE_CONFIG/config.json" --notes "$NATIVE_NOTES" --project "$PROJECT" --quiet
223:   exit $?
224: fi
225: if [ "$VERIFY_ONLY" -eq 1 ]; then
226:   version_output="$(/usr/bin/env -i "${environment[@]}" "$NATIVE_UVX" --offline --prerelease=allow --from "basic-memory==$VERSION" basic-memory --version 2>&1 || true)"
227:   [[ "$version_output" == *"$VERSION"* ]] || fail "Basic Memory runtime is not pinned to $VERSION: ${version_output%%$'\n'*}"
228: else
229:   python3 "$RUNTIME" mcp-runtime --profile native --quiet
230: fi
231: python3 "$RUNTIME" basic-project --config "$NATIVE_CONFIG/config.json" --notes "$NATIVE_NOTES" --project "$PROJECT" --quiet
232: SYSTEMD_RUN="$(command -v systemd-run || true)"
233: SYSTEMCTL="$(command -v systemctl || true)"
234: PRLIMIT="$(command -v prlimit || true)"
235: user_systemd_available() { [ -n "$SYSTEMD_RUN" ] && [ -n "$SYSTEMCTL" ] && "$SYSTEMCTL" --user show-environment >/dev/null 2>&1; }
236: if user_systemd_available; then
237:   LIMITER="systemd-run"
238:   LIMITER_COMMAND=("$SYSTEMD_RUN" --user --pipe --wait --collect --service-type=exec "--working-directory=$PWD" "--property=MemoryMax=$BUDGET_BYTES" "--property=MemorySwapMax=$SWAP_BUDGET_BYTES" -- /usr/bin/env -i "${environment[@]}" "$NATIVE_UVX" --offline --prerelease=allow --from "basic-memory==$VERSION" basic-memory mcp --project "$PROJECT")
239: elif [ -n "$PRLIMIT" ]; then
240:   LIMITER="prlimit"
241:   LIMITER_COMMAND=(/usr/bin/env -i "${environment[@]}" "$PRLIMIT" "--as=$BUDGET_BYTES" -- "$NATIVE_UVX" --offline --prerelease=allow --from "basic-memory==$VERSION" basic-memory mcp --project "$PROJECT")
242: else
243:   fail "no memory limiter available (needs systemd-run --user with systemctl --user, or prlimit)"
244: fi
245: if [ "$VERIFY_ONLY" -eq 1 ]; then
246:   printf 'binary=%s\n' "$NATIVE_UVX"
247:   printf 'project=%s\n' "$PROJECT"
248:   printf 'version=%s\n' "$VERSION"
249:   printf 'notes=%s\n' "$NATIVE_NOTES"
250:   printf 'limiter=%s\n' "$LIMITER"
251:   printf 'available_bytes=%s\n' "$AVAILABLE_BYTES"
252:   printf 'memory_budget_bytes=%s\n' "$BUDGET_BYTES"
253:   printf 'swap_budget_bytes=%s\n' "$SWAP_BUDGET_BYTES"
254:   exit 0
255: fi
256: exec "${LIMITER_COMMAND[@]}"

**Tool: read**

**Input:**
```json
{
  "path": "/home/brajam/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/playwright-mcp.sh",
  "offset": 1,
  "limit": 220
}
```

Read file /home/brajam/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/playwright-mcp.sh, lines 1-126
1: #!/usr/bin/env bash
2: # Launch the canonical pinned Playwright MCP for the selected profile.
3: set -euo pipefail
4: umask 077
5: 
6: SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
7: COMPUTER_USE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
8: RUNTIME="$SCRIPT_DIR/mcp_runtime.py"
9: PROFILE="${OPENCODE_MCP_PROFILE:-native}"
10: PROFILE_ROOT="${OPENCODE_MCP_PROFILE_ROOT:-${OPENCODE_WSL2_PILOT_DIR:-$HOME/.opencode-wsl2-pilot}}"
11: VERSION="$(python3 "$RUNTIME" policy --kind npx)"
12: BROWSER_REVISION="$(python3 - "$RUNTIME" <<'PY'
13: import json
14: import sys
15: from pathlib import Path
16: policy_path = Path(sys.argv[1]).resolve().parent.parent / "config" / "mcp-versions.json"
17: policy = json.loads(policy_path.read_text(encoding="utf-8"))
18: print(policy["playwrightBrowserRevision"])
19: PY
20: )"
21: NATIVE_ROOT="${OPENCODE_MCP_NATIVE_ROOT:-$HOME/.local/share/opencode/mcp}"
22: NATIVE_BROWSER_CACHE="${OPENCODE_MCP_NATIVE_BROWSER_CACHE:-$HOME/.cache/ms-playwright}"
23: 
24: fail() {
25:   printf 'playwright-mcp: %s\n' "$*" >&2
26:   exit 1
27: }
28: 
29: PROVISION=0
30: VERIFY_ONLY=0
31: while [ "$#" -gt 0 ]; do
32:   case "$1" in
33:     --provision) PROVISION=1; shift ;;
34:     --verify-only) VERIFY_ONLY=1; shift ;;
35:     -h|--help)
36:       echo "Usage: $0 [--verify-only|--provision]"
37:       exit 0 ;;
38:     *) echo "Usage: $0 [--verify-only|--provision]" >&2; exit 2 ;;
39:   esac
40: done
41: [ "$VERIFY_ONLY" -eq 0 ] || [ "$PROVISION" -eq 0 ] || fail "--verify-only and --provision are mutually exclusive"
42: case "$PROFILE" in
43:   native|wsl2) ;;
44:   *) fail "unsupported MCP profile: $PROFILE" ;;
45: esac
46: 
47: if [ "$PROFILE" = "wsl2" ]; then
48:   [[ "$PROFILE_ROOT" = /* ]] || fail "wsl2 MCP profile root must be absolute"
49:   if [ "$PROVISION" -eq 1 ]; then
50:     python3 "$RUNTIME" prepare --profile "$PROFILE" --profile-root "$PROFILE_ROOT" --apply --quiet
51:   fi
52:   NPX="$(python3 "$RUNTIME" runner --profile "$PROFILE" --profile-root "$PROFILE_ROOT" --kind npx --override "${OPENCODE_MCP_NPX_BIN:-}" 2>/dev/null || true)"
53:   NODE="$(python3 "$RUNTIME" runner --profile "$PROFILE" --profile-root "$PROFILE_ROOT" --kind node --override "${OPENCODE_MCP_NODE_BIN:-}" 2>/dev/null || true)"
54:   [ -n "$NPX" ] || fail "no trusted npx runner is available"
55:   [ -n "$NODE" ] || fail "no trusted Node.js runner is available"
56:   MCP_ROOT="$PROFILE_ROOT/mcp/playwright"
57:   environment=(
58:     "HOME=$MCP_ROOT/home"
59:     "npm_config_cache=$PROFILE_ROOT/cache/npm"
60:     "PLAYWRIGHT_BROWSERS_PATH=$PROFILE_ROOT/cache/ms-playwright"
61:     "PATH=$(dirname "$NODE"):$(dirname "$NPX"):/usr/local/bin:/usr/bin:/bin"
62:     "LANG=${LANG:-C.UTF-8}"
63:   )
64:   for name in HTTPS_PROXY https_proxy ALL_PROXY all_proxy NO_PROXY no_proxy NODE_EXTRA_CA_CERTS SSL_CERT_FILE SSL_CERT_DIR; do
65:     if [[ -n "${!name:-}" ]]; then environment+=("$name=${!name}"); fi
66:   done
67:   if [ "$PROVISION" -eq 1 ]; then
68:     exec /usr/bin/env -i "${environment[@]}" "$NPX" --yes "@playwright/mcp@$VERSION" install-browser chrome-for-testing
69:   fi
70:   python3 "$RUNTIME" mcp-runtime --profile "$PROFILE" --profile-root "$PROFILE_ROOT" --quiet
71:   if [ "$VERIFY_ONLY" -eq 1 ]; then
72:     printf 'runner=%s\n' "$NPX"
73:     printf 'version=%s\n' "$VERSION"
74:     printf 'profile_root=%s\n' "$PROFILE_ROOT"
75:     exit 0
76:   fi
77:   exec /usr/bin/env -i "${environment[@]}" "$NPX" --offline --yes "@playwright/mcp@$VERSION" \
78:     --headless --isolated --no-webmcp --browser chromium \
79:     --output-dir "$MCP_ROOT/output" --output-max-size 52428800
80: fi
81: 
82: NODE_OVERRIDE="${OPENCODE_MCP_NODE_BIN:-}"
83: if [ -n "$NODE_OVERRIDE" ] && [ -d "$NODE_OVERRIDE" ]; then NODE_OVERRIDE="$NODE_OVERRIDE/node"; fi
84: NODE="$(python3 "$RUNTIME" runner --kind node --override "$NODE_OVERRIDE" 2>/dev/null || true)"
85: [ -n "$NODE" ] || fail "trusted Node.js is unavailable; run setup-mcps.sh --apply"
86: PROJECT="$(cd "$COMPUTER_USE_ROOT/../browser-tools" && pwd)"
87: MCP="$PROJECT/node_modules/.bin/playwright-mcp"
88: BROWSER_BIN="$PROJECT/node_modules/.bin/playwright"
89: OUTPUT="${OPENCODE_MCP_OUTPUT_DIR:-$NATIVE_ROOT/playwright/output}"
90: if [ "$PROVISION" -eq 1 ]; then
91:   NPM_OVERRIDE="${OPENCODE_MCP_NPM_BIN:-}"
92:   if [ -n "$NPM_OVERRIDE" ] && [ -d "$NPM_OVERRIDE" ]; then NPM_OVERRIDE="$NPM_OVERRIDE/npm"; fi
93:   NPM="$(python3 "$RUNTIME" runner --kind npm --override "$NPM_OVERRIDE" 2>/dev/null || true)"
94:   [ -n "$NPM" ] || fail "trusted npm is unavailable; run setup-mcps.sh --apply"
95:   [ -f "$PROJECT/package.json" ] || fail "canonical browser-tools package.json is missing: $PROJECT/package.json"
96:   [ -f "$PROJECT/package-lock.json" ] || fail "canonical browser-tools package-lock.json is missing: $PROJECT/package-lock.json"
97:   (cd "$PROJECT" && PATH="$(dirname "$NODE"):$PATH" "$NPM" ci --ignore-scripts --no-audit --no-fund)
98: fi
99: [ -x "$MCP" ] || fail "canonical Playwright MCP runtime is not installed: $MCP"
100: [ -x "$BROWSER_BIN" ] || fail "canonical Playwright runtime is not installed: $BROWSER_BIN"
101: installed="$(python3 - "$PROJECT/node_modules/@playwright/mcp/package.json" <<'PY'
102: import json
103: import sys
104: with open(sys.argv[1], encoding="utf-8") as handle:
105:     print(json.load(handle)["version"])
106: PY
107: )"
108: [ "$installed" = "$VERSION" ] || fail "Playwright MCP is $installed, expected pinned $VERSION"
109: if [ "$PROVISION" -eq 1 ]; then
110:   PATH="$(dirname "$NODE"):$PATH" PLAYWRIGHT_BROWSERS_PATH="$NATIVE_BROWSER_CACHE" "$BROWSER_BIN" install chrome-for-testing
111:   exit 0
112: fi
113: [ -x "$NATIVE_BROWSER_CACHE/chromium-$BROWSER_REVISION/chrome-linux64/chrome" ] || fail "pinned Chrome-for-Testing revision $BROWSER_REVISION is not installed: $NATIVE_BROWSER_CACHE"
114: if [ "$VERIFY_ONLY" -eq 1 ]; then
115:   printf 'runner=%s\n' "$NODE"
116:   printf 'runtime=%s\n' "$MCP"
117:   printf 'version=%s\n' "$VERSION"
118:   printf 'browser_root=%s\n' "$NATIVE_BROWSER_CACHE"
119:   exit 0
120: fi
121: mkdir -p "$OUTPUT"
122: chmod 700 "$OUTPUT"
123: export PATH="$(dirname "$NODE"):$PATH"
124: export PLAYWRIGHT_BROWSERS_PATH="$NATIVE_BROWSER_CACHE"
125: python3 "$RUNTIME" mcp-runtime --profile native --quiet
126: exec "$MCP" --browser chromium --isolated --image-responses omit --output-dir "$OUTPUT"

**Tool: read**

**Input:**
```json
{
  "path": "/home/brajam/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/setup-mcps.sh",
  "offset": 1,
  "limit": 220
}
```

Read file /home/brajam/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/setup-mcps.sh, lines 1-64
1: #!/usr/bin/env bash
2: set -euo pipefail
3: 
4: SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
5: PROFILE="${OPENCODE_MCP_PROFILE:-native}"
6: PROFILE_ROOT="${OPENCODE_MCP_PROFILE_ROOT:-${OPENCODE_WSL2_PILOT_DIR:-$HOME/.opencode-wsl2-pilot}}"
7: APPLY=0
8: 
9: while [[ "$#" -gt 0 ]]; do
10:   case "$1" in
11:     --profile) PROFILE="$2"; shift 2 ;;
12:     --profile-root|--pilot-dir) PROFILE_ROOT="$2"; shift 2 ;;
13:     --apply) APPLY=1; shift ;;
14:     --verify-only) APPLY=0; shift ;;
15:   --help|-h)
16:       echo "Usage: $0 [--profile native|wsl2] [--profile-root DIR] [--verify-only|--apply]"
17:       exit 0 ;;
18:     *)
19:       echo "Unsupported argument: $1" >&2
20:       exit 2 ;;
21:   esac
22: done
23: 
24: RUNTIME=(python3 "$SCRIPT_DIR/mcp_runtime.py")
25: case "$PROFILE" in
26:   native)
27:     if [[ -n "${OPENCODE_MCP_PROFILE_ROOT:-}" || "$PROFILE_ROOT" != "$HOME/.opencode-wsl2-pilot" ]]; then
28:       echo "ERROR: native MCP setup does not accept --profile-root or a WSL pilot root" >&2
29:       exit 2
30:     fi
31:     if [[ "$APPLY" -eq 1 ]]; then
32:       "${RUNTIME[@]}" prepare --profile native --apply --quiet
33:       "${RUNTIME[@]}" node-runtime --profile native --apply --quiet
34:       OPENCODE_MCP_PROFILE=native "$SCRIPT_DIR/basic-memory-mcp.sh" --provision
35:       OPENCODE_MCP_PROFILE=native "$SCRIPT_DIR/playwright-mcp.sh" --provision
36:       "${RUNTIME[@]}" mcp-runtime --profile native --apply
37:     else
38:       "${RUNTIME[@]}" mcp-runtime --profile native
39:       OPENCODE_MCP_PROFILE=native "$SCRIPT_DIR/basic-memory-mcp.sh" --verify-only
40:       OPENCODE_MCP_PROFILE=native "$SCRIPT_DIR/playwright-mcp.sh" --verify-only
41:     fi
42:     ;;
43:   wsl2)
44:     if [[ "$APPLY" -eq 1 ]]; then
45:       "${RUNTIME[@]}" prepare --profile wsl2 --profile-root "$PROFILE_ROOT" --apply --quiet
46:       "${RUNTIME[@]}" node-runtime --profile wsl2 --profile-root "$PROFILE_ROOT" --apply --quiet
47:       OPENCODE_MCP_PROFILE=wsl2 OPENCODE_MCP_PROFILE_ROOT="$PROFILE_ROOT" \
48:         "$SCRIPT_DIR/basic-memory-mcp.sh" --provision
49:       OPENCODE_MCP_PROFILE=wsl2 OPENCODE_MCP_PROFILE_ROOT="$PROFILE_ROOT" \
50:         "$SCRIPT_DIR/playwright-mcp.sh" --provision
51:       "${RUNTIME[@]}" mcp-runtime --profile wsl2 --profile-root "$PROFILE_ROOT" --apply
52:     else
53:       "${RUNTIME[@]}" mcp-runtime --profile wsl2 --profile-root "$PROFILE_ROOT"
54:       OPENCODE_MCP_PROFILE=wsl2 OPENCODE_MCP_PROFILE_ROOT="$PROFILE_ROOT" \
55:         "$SCRIPT_DIR/basic-memory-mcp.sh" --verify-only
56:       OPENCODE_MCP_PROFILE=wsl2 OPENCODE_MCP_PROFILE_ROOT="$PROFILE_ROOT" \
57:         "$SCRIPT_DIR/playwright-mcp.sh" --verify-only
58:     fi
59:     ;;
60:   *)
61:     echo "ERROR: unsupported MCP profile: $PROFILE" >&2
62:     exit 2
63:     ;;
64: esac

---

## Assistant

_Thinking:_

**Planning to read mcp_runtime lines 800+**

**Tool: read**

**Input:**
```json
{
  "path": "/home/brajam/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/mcp_runtime.py",
  "offset": 790,
  "limit": 250
}
```

Read file /home/brajam/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/mcp_runtime.py, lines 790-921
790:         raise McpRuntimeError(
791:             f"trusted Node.js {policy['nodeVersion']} is unavailable; rerun setup-mcps.sh --apply"
792:         )
793:     root = paths["node_root"]
794:     ensure_safe_path(root)
795:     if root.exists() or root.is_symlink():
796:         raise McpRuntimeError(f"pinned Node.js target exists but is not usable: {root}")
797:     root.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
798:     archive_name = str(policy["nodeArchive"])
799:     temporary_root = Path(tempfile.mkdtemp(prefix="node-runtime-", dir=str(root.parent)))
800:     archive_path = temporary_root / archive_name
801:     extract_root = temporary_root / "extract"
802:     try:
803:         with urlopen(str(policy["nodeUrl"]), timeout=90) as response, archive_path.open("wb") as handle:
804:             digest = hashlib.sha256()
805:             total = 0
806:             while True:
807:                 chunk = response.read(1024 * 1024)
808:                 if not chunk:
809:                     break
810:                 total += len(chunk)
811:                 if total > MAX_NODE_ARCHIVE_BYTES:
812:                     raise McpRuntimeError("pinned Node.js archive exceeds the bounded download size")
813:                 digest.update(chunk)
814:                 handle.write(chunk)
815:         if digest.hexdigest() != str(policy["nodeSha256"]):
816:             raise McpRuntimeError("pinned Node.js archive checksum does not match the published policy")
817:         extract_root.mkdir(mode=0o700)
818:         with tarfile.open(archive_path, mode="r:*") as archive:
819:             members = archive.getmembers()
820:             for member in members:
821:                 name = Path(member.name)
822:                 if name.is_absolute() or ".." in name.parts:
823:                     raise McpRuntimeError("pinned Node.js archive contains an unsafe member")
824:             archive.extractall(extract_root, filter="data")
825:         extracted = extract_root / f"node-v{policy['nodeVersion']}-linux-x64"
826:         if not extracted.is_dir() or extracted.is_symlink():
827:             raise McpRuntimeError("pinned Node.js archive has an unexpected top-level directory")
828:         os.replace(extracted, root)
829:     except (OSError, EOFError, tarfile.TarError, ValueError) as error:
830:         raise McpRuntimeError(f"cannot install pinned Node.js {policy['nodeVersion']}: {error}") from error
831:     finally:
832:         shutil.rmtree(temporary_root, ignore_errors=True)
833:     node = resolve_runner(
834:         "node", str(root / "bin" / "node"), profile=profile, profile_root=profile_root
835:     )
836:     if not _has_node_runtime(str(policy["nodeVersion"]), profile=profile, profile_root=profile_root):
837:         raise McpRuntimeError("installed Node.js runtime failed its executable/version verification")
838:     return node
839: 
840: 
841: def main() -> int:
842:     parser = argparse.ArgumentParser()
843:     parser.add_argument(
844:         "action",
845:         choices=("policy", "prepare", "mcp-runtime", "runner", "node-runtime", "config", "basic-project"),
846:     )
847:     parser.add_argument("--profile", default="native")
848:     parser.add_argument("--profile-root", type=Path)
849:     parser.add_argument("--apply", action="store_true")
850:     parser.add_argument("--quiet", action="store_true")
851:     parser.add_argument("--kind", choices=("uvx", "npx", "npm", "node"))
852:     parser.add_argument("--override")
853:     parser.add_argument("--config", type=Path)
854:     parser.add_argument("--scope", choices=("global", "project"))
855:     parser.add_argument("--notes", type=Path)
856:     parser.add_argument("--project")
857:     args = parser.parse_args()
858:     try:
859:         validate_profile(args.profile)
860:         if args.action == "policy":
861:             policy = load_policy()
862:             if args.kind:
863:                 key = {"uvx": "basicMemory", "npx": "playwright", "npm": "nodeVersion", "node": "nodeVersion"}[args.kind]
864:                 print(policy[key])
865:             else:
866:                 print(json.dumps(policy, sort_keys=True))
867:         elif args.action == "runner":
868:             if args.kind is None:
869:                 raise McpRuntimeError("--kind is required for runner resolution")
870:             print(
871:                 resolve_runner(
872:                     args.kind,
873:                     args.override,
874:                     profile=args.profile,
875:                     profile_root=args.profile_root,
876:                 )
877:             )
878:         elif args.action == "prepare":
879:             if args.profile == "native":
880:                 if args.profile_root is not None:
881:                     raise McpRuntimeError("native MCP preparation does not accept an isolated profile root")
882:                 prepare_native(apply=args.apply)
883:                 target = native_paths()["root"]
884:             else:
885:                 if args.profile_root is None:
886:                     raise McpRuntimeError("--profile-root is required for the WSL2 profile")
887:                 prepare_profile(args.profile_root, apply=args.apply)
888:                 target = _absolute(args.profile_root)
889:             if not args.quiet:
890:                 print(f"OK: canonical {args.profile} MCP profile path is ready: {target}")
891:         elif args.action == "node-runtime":
892:             node = ensure_node(profile=args.profile, profile_root=args.profile_root, apply=args.apply)
893:             if not args.quiet:
894:                 print(f"OK: trusted Node.js runtime: {node}")
895:         elif args.action == "config":
896:             if args.config is None or args.scope is None:
897:                 raise McpRuntimeError("config requires --config and --scope")
898:             configure_mcp_file(args.config, scope=args.scope, apply=args.apply)
899:             if not args.quiet:
900:                 print(f"OK: canonical {args.scope} MCP configuration: {_absolute(args.config)}")
901:         elif args.action == "basic-project":
902:             if args.config is None or args.notes is None or args.project is None:
903:                 raise McpRuntimeError("basic-project requires --config, --notes, and --project")
904:             verify_basic_memory_project(args.config, project=args.project, notes=args.notes)
905:             if not args.quiet:
906:                 print(f"OK: Basic Memory project {args.project}: {_absolute(args.notes)}")
907:         else:
908:             mcp_provisioning(
909:                 args.profile_root,
910:                 profile=args.profile,
911:                 apply=args.apply,
912:                 quiet=args.quiet,
913:             )
914:     except McpRuntimeError as error:
915:         print(f"ERROR: {error}", file=sys.stderr)
916:         return 1
917:     return 0
918: 
919: 
920: if __name__ == "__main__":
921:     raise SystemExit(main())

---

## Assistant

_Thinking:_

**Fixing missing return after systemd command**

_Thinking:_

**Analyzing Basic Memory project provisioning logic**

_Thinking:_

**Planning safer project add and default setting**

_Thinking:_

**Adding --allow-non-default flag and verifying project paths**

_Thinking:_

**Validating runtime profiles and launcher behaviors**

_Thinking:_

**Noting npx lacks --offline support**

_Thinking:_

**Planning self tests and docs review**

_Thinking:_

**Updating stale setup and runtime docs**

**Tool: read**

**Input:**
```json
{
  "path": "/home/brajam/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/setup-computer-assistant.sh",
  "offset": 1,
  "limit": 320
}
```

Read file /home/brajam/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/setup-computer-assistant.sh, lines 1-257
1: #!/usr/bin/env bash
2: # Provision OpenCode's local computer-assistant capabilities on Ubuntu GNOME.
3: set -euo pipefail
4: 
5: APPLY=0
6: MODE_SET=0
7: for arg in "$@"; do
8:   case "$arg" in
9:     --apply)
10:       if [ "$MODE_SET" -ne 0 ]; then
11:         echo "Usage: $0 [--verify-only|--apply]" >&2
12:         exit 2
13:       fi
14:       APPLY=1
15:       MODE_SET=1
16:       ;;
17:     --verify-only)
18:       if [ "$MODE_SET" -ne 0 ]; then
19:         echo "Usage: $0 [--verify-only|--apply]" >&2
20:         exit 2
21:       fi
22:       MODE_SET=1
23:       ;;
24:     -h|--help)
25:       echo "Usage: $0 [--verify-only|--apply]"
26:       exit 0
27:       ;;
28:     *)
29:       echo "Usage: $0 [--verify-only|--apply]" >&2
30:       exit 2
31:       ;;
32:   esac
33: done
34: 
35: SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
36: UBUNTU_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
37: REPO_ROOT="$(cd "$UBUNTU_ROOT/../../.." && pwd)"
38: PROJECT_CONFIG_JSON="$REPO_ROOT/opencode.json"
39: V2_CONFIG_DIR="${OPENCODE_V2_CONFIG_DIR:-${OPENCODE_V2_PILOT_DIR:-$HOME/.opencode-v2-pilot}/config}"
40: OPENCODE_BIN="${OPENCODE_V2_BIN:-$HOME/.local/opt/opencode-v2/opencode}"
41: OPENCODE_CONFIG_JSON="$V2_CONFIG_DIR/opencode.json"
42: OPENCODE_CONFIG_JSONC="$V2_CONFIG_DIR/opencode.jsonc"
43: CLI_CONFIG="$V2_CONFIG_DIR/cli.json"
44: MCP_RUNTIME="$SCRIPT_DIR/mcp_runtime.py"
45: REQUIRED_PACKAGES=(python3-pyatspi ydotool wl-clipboard)
46: 
47: ok() { echo "OK: $*"; }
48: fail() { echo "MISSING/FAILED: $*" >&2; }
49: 
50: global_mcp_config_path() {
51:   if [ -f "$OPENCODE_CONFIG_JSONC" ]; then
52:     printf '%s\n' "$OPENCODE_CONFIG_JSONC"
53:   else
54:     printf '%s\n' "$OPENCODE_CONFIG_JSON"
55:   fi
56: }
57: 
58: preflight_v2_config() {
59:   python3 - "$V2_CONFIG_DIR" "$OPENCODE_CONFIG_JSON" "$OPENCODE_CONFIG_JSONC" "$CLI_CONFIG" "$PROJECT_CONFIG_JSON" <<'PY'
60: import os
61: import stat
62: import sys
63: 
64: root, json_path, jsonc_path, cli_path, project_path = sys.argv[1:]
65: if os.path.exists(json_path) and os.path.exists(jsonc_path):
66:     raise SystemExit(f"both {json_path} and {jsonc_path} exist; consolidate them before setup")
67: for path in (root, json_path, jsonc_path, cli_path, project_path):
68:     absolute = os.path.abspath(path)
69:     current = os.path.dirname(absolute) if path != root else absolute
70:     while current != os.path.dirname(current):
71:         if os.path.islink(current):
72:             raise SystemExit(f"refusing config path with symlink ancestor: {path}")
73:         current = os.path.dirname(current)
74:     if os.path.lexists(absolute):
75:         metadata = os.lstat(absolute)
76:         if stat.S_ISLNK(metadata.st_mode):
77:             raise SystemExit(f"refusing symlinked config path: {path}")
78:         if path == root and not stat.S_ISDIR(metadata.st_mode):
79:             raise SystemExit(f"config root is not a directory: {path}")
80:         if path != root and not stat.S_ISREG(metadata.st_mode):
81:             raise SystemExit(f"config path is not a regular file: {path}")
82: PY
83: }
84: 
85: run_root() {
86:   if [ "$(id -u)" -eq 0 ]; then
87:     "$@"
88:   elif sudo -n true 2>/dev/null; then
89:     sudo "$@"
90:   elif [ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ] && command -v pkexec >/dev/null 2>&1; then
91:     pkexec "$@"
92:   else
93:     sudo "$@"
94:   fi
95: }
96: 
97: install_system_dependencies() {
98:   local package
99:   local missing=()
100:   echo "=== system dependencies ==="
101:   for package in "${REQUIRED_PACKAGES[@]}"; do
102:     if ! dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null | grep -q '^installed$'; then
103:       missing+=("$package")
104:     fi
105:   done
106:   if [ "${#missing[@]}" -gt 0 ]; then
107:     run_root apt-get install -y --no-remove "${missing[@]}"
108:   else
109:     ok "required system packages already installed"
110:   fi
111:   if ! id -nG "$(id -un)" | tr ' ' '\n' | grep -qx input; then
112:     run_root usermod -aG input "$(id -un)"
113:     echo "NOTICE: input group added; a full logout/login may be required."
114:   fi
115:   gsettings set org.gnome.desktop.interface toolkit-accessibility true
116:   systemctl --user daemon-reload
117:   if [ -w /dev/uinput ]; then
118:     systemctl --user enable --now ydotool.service
119:   else
120:     echo "NOTICE: /dev/uinput is not writable in this login; log out/in, then rerun."
121:   fi
122: }
123: 
124: initialize_local_state() {
125:   echo "=== skills and commands ==="
126:   "$SCRIPT_DIR/setup-opencode.sh" --config-dir "$V2_CONFIG_DIR" --prepare
127:   echo "=== v2 plugins ==="
128:   "$SCRIPT_DIR/deploy-plugins.sh" --config-dir "$V2_CONFIG_DIR" --plugins all --apply
129:   echo "=== canonical MCP configuration ==="
130:   python3 "$MCP_RUNTIME" config --scope global --config "$(global_mcp_config_path)" --apply
131:   python3 "$MCP_RUNTIME" config --scope project --config "$PROJECT_CONFIG_JSON"
132:   echo "=== canonical MCP runtimes ==="
133:   "$SCRIPT_DIR/setup-mcps.sh" --profile native --apply
134: }
135: 
136: verify() {
137:   local status=0
138:   local package
139:   local mcp_list=""
140:   echo "=== computer assistant verify ==="
141: 
142:   if [ -x "$OPENCODE_BIN" ] && [[ "$("$OPENCODE_BIN" --version 2>/dev/null || true)" == "opencode v2."* ]]; then
143:     ok "OpenCode v2 binary $OPENCODE_BIN"
144:   else
145:     fail "OpenCode v2 binary $OPENCODE_BIN"
146:     status=1
147:   fi
148: 
149:   for package in "${REQUIRED_PACKAGES[@]}"; do
150:     if dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null | grep -q '^installed$'; then
151:       ok "package $package"
152:     else
153:       fail "package $package"
154:       status=1
155:     fi
156:   done
157: 
158:   if [ "$(gsettings get org.gnome.desktop.interface toolkit-accessibility)" = "true" ]; then
159:     ok "GNOME toolkit accessibility enabled"
160:   else
161:     fail "GNOME toolkit accessibility disabled"
162:     status=1
163:   fi
164:   if python3 -c 'import pyatspi' 2>/dev/null; then
165:     ok "AT-SPI Python binding"
166:   else
167:     fail "AT-SPI Python binding"
168:     status=1
169:   fi
170:   if id -nG "$(id -un)" | tr ' ' '\n' | grep -qx input; then
171:     ok "account belongs to input group"
172:   else
173:     fail "account does not belong to input group"
174:     status=1
175:   fi
176:   if [ -w /dev/uinput ]; then
177:     ok "/dev/uinput writable in this login"
178:   else
179:     fail "/dev/uinput not writable (logout/login may be pending)"
180:     status=1
181:   fi
182:   if systemctl --user is-active --quiet ydotool.service && [ -S "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/.ydotool_socket" ]; then
183:     ok "ydotool user service and private socket"
184:   else
185:     fail "ydotool user service/socket"
186:     status=1
187:   fi
188:   if python3 "$SCRIPT_DIR/desktop-control.py" apps >/dev/null 2>&1; then
189:     ok "desktop-control AT-SPI inspection"
190:   else
191:     fail "desktop-control AT-SPI inspection"
192:     status=1
193:   fi
194: 
195:   if python3 "$MCP_RUNTIME" config --scope project --config "$PROJECT_CONFIG_JSON"; then
196:     ok "portable project MCP configuration remains canonical"
197:   else
198:     fail "portable project MCP configuration"
199:     status=1
200:   fi
201:   if python3 "$MCP_RUNTIME" config --scope global --config "$(global_mcp_config_path)"; then
202:     ok "native global MCP configuration"
203:   else
204:     fail "native global MCP configuration"
205:     status=1
206:   fi
207:   if "$SCRIPT_DIR/setup-mcps.sh" --profile native --verify-only; then
208:     ok "pinned Basic Memory, Node.js, Playwright MCP, and Chrome runtimes"
209:   else
210:     fail "canonical native MCP runtimes"
211:     status=1
212:   fi
213: 
214:   if [ -x "$OPENCODE_BIN" ]; then
215:     mcp_list="$( (cd "$REPO_ROOT"; OPENCODE_CONFIG_DIR="$V2_CONFIG_DIR" "$OPENCODE_BIN" mcp list 2>&1) || true )"
216:   fi
217:   for name in basic-memory playwright; do
218:     if printf '%s\n' "$mcp_list" | grep -q "$name .*connected"; then
219:       ok "OpenCode $name MCP connected"
220:     else
221:       fail "OpenCode $name MCP connection"
222:       status=1
223:     fi
224:   done
225:   if printf '%s\n' "$mcp_list" | grep -qE 'github .*(connected|needs_auth)'; then
226:     ok "OpenCode GitHub hosted MCP connected or awaiting operator OAuth"
227:   else
228:     fail "OpenCode GitHub hosted MCP declaration/connection"
229:     status=1
230:   fi
231: 
232:   if "$SCRIPT_DIR/setup-opencode.sh" --config-dir "$V2_CONFIG_DIR" --verify-only; then
233:     ok "all OpenCode skills, commands, and tools deployed"
234:   else
235:     fail "OpenCode skills, commands, or tools missing/stale"
236:     status=1
237:   fi
238:   if "$SCRIPT_DIR/deploy-plugins.sh" --config-dir "$V2_CONFIG_DIR" --plugins all --verify-only; then
239:     ok "all OpenCode v2 plugins registered and gated"
240:   else
241:     fail "OpenCode v2 plugins missing, stale, or session permissions are not prompt"
242:     status=1
243:   fi
244:   return "$status"
245: }
246: 
247: if ! preflight_v2_config; then
248:   fail "v2 config preflight failed"
249:   exit 1
250: fi
251: 
252: if [ "$APPLY" -eq 1 ]; then
253:   install_system_dependencies
254:   initialize_local_state
255: fi
256: 
257: verify

**Tool: read**

**Input:**
```json
{
  "path": "/home/brajam/repos/opencode-rig/docs/scripts/setup-computer-assistant.md",
  "offset": 1,
  "limit": 320
}
```

Read file /home/brajam/repos/opencode-rig/docs/scripts/setup-computer-assistant.md, lines 1-240
1: # `setup-computer-assistant.sh`
2: 
3: Full-stack provisioning and verification for the local computer-assistant
4: capabilities on Ubuntu GNOME. This is the top-level setup entry point: it
5: installs system packages, deploys v2 skills and commands, verifies
6: the bounded Basic Memory installation, and installs the canonical pinned
7: Playwright MCP. GitHub is registered as the credential-free hosted OAuth MCP
8: endpoint.
9: 
10: ```bash
11: # Read-only health check (default)
12: ./platforms/linux/ubuntu/computer-use/scripts/setup-computer-assistant.sh --verify-only
13: 
14: # Provision or repair the stack
15: ./platforms/linux/ubuntu/computer-use/scripts/setup-computer-assistant.sh --apply
16: ```
17: 
18: `--verify-only` and `--apply` are mutually exclusive; any other argument exits
19: with a usage error (`2`). The setup provisions the native local runtimes and
20: declares hosted GitHub OAuth; it does not install or register the optional local
21: Source Control compatibility runtime.
22: 
23: ## Security-relevant changes made by `--apply`
24: 
25: The script header lists these explicitly, because they are the operations that
26: need review before running on a new machine:
27: 
28: - Enables AT-SPI so user processes can inspect and control accessible widgets.
29: - Installs and enables `ydotool` and adds the user to the `input` group (which
30:   grants synthetic-input access).
31: - Enables the single isolated Playwright browser MCP in the **project** `opencode.json`
32:   (project-only, never global; no normal-browser cookies).
33: - Registers GitHub's hosted OAuth endpoint without a token, authorization
34:   header, client secret, or local credential wrapper. The operator signs in
35:   from `/mcps`.
36: 
37: ## Pins and paths
38: 
39: | Item | Value |
40: |------|-------|
41: | Playwright MCP | canonical `@playwright/mcp@0.0.80` policy |
42: | GitHub MCP | `https://api.githubcopilot.com/mcp/` hosted OAuth endpoint |
43: | Project config | `$REPO_ROOT/opencode.json` |
44: | v2 config | `$OPENCODE_V2_PILOT_DIR/config` |
45: | OpenCode binary | `$OPENCODE_V2_BIN`, default `~/.local/opt/opencode-v2/opencode` |
46: | Browser project | `platforms/linux/ubuntu/browser-tools/` |
47: | Basic Memory | `0.23.2` (`BASIC_MEMORY_VERSION`) via `basic-memory-mcp.sh` |
48: | Required packages | `python3-pyatspi`, `ydotool`, `wl-clipboard` |
49: 
50: Node is used from the fnm default alias at
51: `~/.local/share/fnm/aliases/default/bin`.
52: 
53: ## What `--apply` does
54: 
55: `--apply` runs three phases in order, then always runs `verify()`:
56: 
57: 1. `install_system_dependencies`
58: 2. `initialize_local_state` (runs `setup-opencode.sh --prepare`, then registers
59:    all v2 plugins; the final `verify()` phase performs one full health check)
60: 3. `install_browser_runtime`
61: 
62: ### 1. System dependencies
63: 
64: - Checks each required package with `dpkg-query`; installs the missing ones with
65:   `apt-get install -y --no-remove`.
66: - Adds the current user to the `input` group if absent (a full logout/login may
67:   be required for `/dev/uinput` access).
68: - Sets `org.gnome.desktop.interface toolkit-accessibility true`.
69: - Runs `systemctl --user daemon-reload`.
70: - Enables and starts `ydotool.service` only if `/dev/uinput` is writable in the
71:   current login; otherwise it prints a notice to log out and back in.
72: 
73: Privileged commands go through `run_root()`, which prefers, in order: running
74: as root, cached non-interactive `sudo -n`, `pkexec` (when a D-Bus session is
75: present), and finally an interactive `sudo`. The user's credential is entered
76: only into the trusted `sudo`/PolicyKit dialog.
77: 
78: ### 2. Local state
79: 
80: - Runs `setup-opencode.sh --prepare` to seed the complete canonical examples,
81:   deploy v2 skills/commands, and install/verify pinned parser assets without
82:   running a premature health check (see [`setup-opencode.md`](setup-opencode.md)).
83:   It does not recreate the retired legacy JSON memory store.
84: - Registers all catalog v2 plugins after preparation. The final `verify()` phase
85:   then runs exactly one real `setup-opencode.sh --verify-only` health check.
86:   This works for clean and stale targets; registration is idempotent and
87:   preserves plugin options, unrelated settings, and existing modes.
88: - During local-state setup, stale pilot MCP configuration is migrated to V2
89:   scopes: global `mcp.servers.github` uses the hosted OAuth endpoint and
90:   `mcp.servers.basic-memory` uses the canonical local wrapper, while Playwright
91:   is project-only in the repository config. Obsolete flat `mcp.github`, `mcp.playwright`, and
92:   `mcp.basic-memory` keys are removed only after those destinations validate.
93: - A failed preparation (including accumulated skill-copy, destination,
94:   extra-file, or parser checks) stops immediately under `set -e`; plugin and
95:   runtime phases are not started and no false preparation success is reported.
96: 
97: ### 3. Browser runtime
98: 
99: - Verifies fnm Node/npm, `browser-tools/package.json`, and `package-lock.json`
100:   exist.
101: - `browser_runtime_complete()` requires all of: the installed
102:   `@playwright/mcp` version equals `0.0.80`, the `playwright-mcp` and
103:   `playwright` binaries are executable, and the expected Firefox binary
104:   (resolved via `playwright install --dry-run firefox`) exists under
105:   `browser-tools/browsers/`.
106: - When incomplete, it runs `npm ci --ignore-scripts --no-audit --no-fund`
107:   followed by `playwright install firefox` with `PLAYWRIGHT_BROWSERS_PATH` set
108:   to the component-local `browsers/` directory.
109: - Registers exactly one Playwright MCP entry project-only (see below).
110: 
111: ## MCP registration
112: 
113: Playwright MCP entries are written into the **project** `opencode.json`, not the
114: global config, and duplicate nested or legacy flat entries are actively removed
115: from the global files. Basic Memory and the GitHub hosted endpoint are
116: global-only.
117: The GitHub MCP entry is written into the **global** config
118: (`$OPENCODE_V2_PILOT_DIR/config/opencode.jsonc`),
119: and any duplicate project entry is removed. The embedded Python editor writes
120: these entries atomically (temp file + `os.replace`):
121: 
122: ```json
123: {
124:   "type": "remote",
125:   "url": "https://api.githubcopilot.com/mcp/",
126:   "disabled": false,
127:   "timeout": { "startup": 30000 }
128: }
129: ```
130: 
131: `ensure_mcp()` takes a scope argument. For the project-scoped `playwright`
132: entry it:
133: 
134: 1. `ensure_project_mcp_entry` — create or update the project entry.
135: 2. `remove_global_mcp_entry` — delete the name from `opencode.json`/`jsonc`.
136: 3. `project_mcp_matches` — confirm the project entry names the wrapper.
137: 4. `global_mcp_has_entry` and `mcp_config_matches` — confirm the global config
138:    is clean and exactly one scoped entry names the wrapper.
139: 
140: For the global-scoped `github` entry it:
141: 
142: 1. `ensure_global_mcp_entry` — create or update the entry in the global config.
143: 2. `remove_project_mcp_entry` — delete the name from the project
144:    `opencode.json`.
145: 3. the hosted-URL matcher — confirm the global entry is credential-free.
146: 4. `project_mcp_has_entry` — confirm the project config is clean and exactly one
147:    global entry uses the hosted URL.
148: 
149: The migration parses JSON and JSONC with the strict string-aware parser,
150: rejecting malformed or duplicate-key input. It validates both target files and
151: symlink safety before writing either one, then uses atomic mode-preserving
152: writes. Existing `mcp.timeout`, unrelated servers/settings, and options on
153: legacy or nested entries are retained; affected JSONC files may be normalized
154: to canonical JSON, removing comments and trailing-comma formatting.
155: 
156: The initial setup preflight rejects a symlinked V2 config root, ancestor, or
157: server/CLI config target, and rejects simultaneous `opencode.json` and
158: `opencode.jsonc` pilot files before parser, plugin, or runtime work begins.
159: 
160: The script uses the isolated v2 config directory and refuses conflicting JSON
161: and JSONC files there until they are consolidated. Existing fields on the named
162: server are preserved while its type, command, enabled state, and startup timeout
163: are normalized. Malformed config is never silently overwritten.
164: 
165: The local wrappers registered are:
166: 
167: - `playwright` → `playwright-mcp.sh` (project)
168: - `basic-memory` → `basic-memory-mcp.sh` (global)
169: 
170: `github` is remote and has no local wrapper.
171: 
172: ## Verification
173: 
174: `verify()` is read-only and reports `OK:`/`MISSING/FAILED:` lines. It checks:
175: 
176: - All required packages are installed.
177: - The configured executable reports an OpenCode v2 version.
178: - GNOME toolkit accessibility is enabled.
179: - The AT-SPI Python binding imports.
180: - The account is in the `input` group.
181: - `/dev/uinput` is writable in this login.
182: - `ydotool.service` is active and its private socket exists.
183: - `desktop-control.py apps` runs (AT-SPI inspection works).
184: - Basic Memory `0.23.2` is on `PATH` and `basic-memory-mcp.sh --verify-only`
185:   resolves a limiter and a usable budget.
186: - The pinned Playwright runtime and Firefox binary are complete.
187: - The canonical GitHub hosted endpoint is declared without credential fields.
188: - `opencode mcp list` reports the single live Playwright MCP connected.
189:   When the caller explicitly sets `OPENCODE_DISABLE_PROJECT_CONFIG=1`, this
190:   shared-service probe is reported as deferred rather than silently overriding
191:   the opt-out; the project entry, pinned runtime, and local wrapper are still
192:   verified.
193: - The GitHub hosted MCP is connected after OAuth, otherwise it reports
194:   `needs_auth` and instructs the operator to complete `/mcps`.
195: - Each MCP is bound to the right scope — Playwright project-only, GitHub
196:   global-only, and Basic Memory global-only — in valid `mcp.servers` entries;
197:   no obsolete flat MCP keys remain, `session.permissions` is exactly `prompt`,
198:   and the configured v2 binary
199:   lists their live connection state with `OPENCODE_CONFIG_DIR` set to the
200:   isolated directory.
201: - `setup-opencode.sh --verify-only` passes (skills, commands,
202:   deployed).
203: - `deploy-plugins.sh --plugins all --verify-only` passes, including
204:   `cli.json` `session.permissions: "prompt"` for rig-tools gates.
205: 
206: `verify()` returns non-zero if any check fails, so `--verify-only` is suitable
207: as a health gate.
208: 
209: The apply order is intentionally strict: `setup-opencode.sh --prepare` seeds
210: the complete examples and deploys skills, commands, and pinned parser assets;
211: `deploy-plugins.sh --plugins all --apply` then registers all seven catalog
212: packages and enforces prompt permissions; after runtime installation,
213: `verify()` invokes `setup-opencode.sh --verify-only` as the single full health check. A
214: failure in any phase stops the apply path and propagates non-zero. Preparation
215: does not overwrite existing config wholesale; plugin/permission edits may
216: normalize affected JSONC to canonical JSON, removing comments only in files
217: that require those edits.
218: 
219: ## Exit codes
220: 
221: | Code | Meaning |
222: |------|---------|
223: | `0` | Verification passed, or `--apply` completed and verified |
224: | `1` | One or more verification checks failed, or an apply phase failed |
225: | `2` | Invalid usage (conflicting or unknown arguments) |
226: 
227: ## Notes and limitations
228: 
229: - The script assumes the canonical repository layout; it derives the project
230:   config path by walking up from `scripts/`.
231: - Native Playwright browser binaries are downloaded during `--apply` and are
232:   gitignored; WSL2 downloads its own profile-local runtime through the same
233:   canonical launcher.
234: - `ydotool` access may require a logout/login after the first `--apply` on a
235:   new machine; the script prints a notice and verification fails until then.
236: - GitHub authentication is handled only by OpenCode's hosted OAuth flow from
237:   `/mcps`; never add a token, header, or client secret to configuration.
238: - Reading order: [`setup-opencode.md`](setup-opencode.md),
239:   [`setup-live-dictation.md`](setup-live-dictation.md),
240:   [`github-mcp.md`](github-mcp.md), [`playwright-mcp.md`](playwright-mcp.md).

**Tool: read**

**Input:**
```json
{
  "path": "/home/brajam/repos/opencode-rig/.github/workflows/verify-wsl2.yml",
  "offset": 1,
  "limit": 260
}
```

Read file /home/brajam/repos/opencode-rig/.github/workflows/verify-wsl2.yml, lines 1-41
1: name: verify-wsl2-source
2: 
3: on:
4:   push:
5:     branches: [main]
6:     paths:
7:       - ".github/workflows/verify-wsl2.yml"
8:       - "platforms/windows/wsl2/ubuntu/computer-use/**"
9:       - "README.md"
10:       - "documentation-map.json"
11:   pull_request:
12:     paths:
13:       - ".github/workflows/verify-wsl2.yml"
14:       - "platforms/windows/wsl2/ubuntu/computer-use/**"
15:       - "README.md"
16:       - "documentation-map.json"
17: 
18: permissions:
19:   contents: read
20: 
21: jobs:
22:   source:
23:     runs-on: ubuntu-latest
24:     steps:
25:       - name: Checkout
26:         uses: actions/checkout@v4
27: 
28:       - name: Node.js
29:         uses: actions/setup-node@v4
30:         with:
31:           node-version: 22.22.2
32: 
33:       - name: Install locked WSL2 test dependencies
34:         run: |
35:           set -euo pipefail
36:           workspace=platforms/windows/wsl2/ubuntu/computer-use/plugins-v2
37:           wrapper=platforms/windows/wsl2/ubuntu/computer-use/scripts/run-bounded-command.sh
38:           bash "$wrapper" -- npm --prefix "$workspace" ci --ignore-scripts
39: 
40:       - name: Verify independent WSL2 source
41:         run: bash platforms/windows/wsl2/ubuntu/computer-use/scripts/verify-wsl2.sh --source

**Tool: grep**

**Input:**
```json
{
  "pattern": "22\\.23\\.1|Firefox|firefox|fnm|BASIC_MEMORY_BIN|global-only MCP|main project",
  "path": "/home/brajam/repos/opencode-rig",
  "include": "*.{md,sh,py,json,jsonc,yml,yaml}",
  "caseSensitive": false,
  "limit": 300
}
```

Found 81 matches
/home/brajam/repos/opencode-rig/HANDOFF.md:
  Line 99: share that context through typed RPC; the existing Firefox Playwright MCP is

  Line 155: Firefox MCP remains a separate surface; the plugin-owned headed Chromium flow


/home/brajam/repos/opencode-rig/docs/maintainer-features.md:
  Line 67: | `browser-assistant` | Visible isolated Playwright Firefox shared with the user |


/home/brajam/repos/opencode-rig/docs/scripts/playwright-mcp.md:
  Line 4: isolated Firefox window; the WSL2 profile uses the same launcher with a private

  Line 17:    - `NODE_BIN` = `~/.local/share/fnm/aliases/default/bin`

  Line 26: 5. Prepends the fnm Node directory to `PATH` and sets

  Line 27:    `PLAYWRIGHT_BROWSERS_PATH` to `<PROJECT>/browsers`, so the pinned Firefox is

  Line 33:      --browser firefox \

  Line 43: | `--browser firefox` | Use Firefox |

  Line 44: | `--isolated` | A fresh, separate profile; no access to the user's normal Firefox profile, cookies, or tabs |

  Line 66: | fnm Node missing | Prints the path and exits `1` |


/home/brajam/repos/opencode-rig/docs/acceptance-evidence-2026-09-19.md:
  Line 59: browser profile, modify the system browser, replace the Firefox Playwright MCP,


/home/brajam/repos/opencode-rig/platforms/linux/ubuntu/browser-tools/README.md:
  Line 26: remains separate from the user's normal Firefox profile. Headless work is never

  Line 41: Firefox smoke test.


/home/brajam/repos/opencode-rig/docs/scripts/verify-opencode-v2.md:
  Line 4: connects an MCP server, so it never launches Firefox.

  Line 33:   command, with no global-only MCP registrations. The relative form uses


/home/brajam/repos/opencode-rig/docs/scripts/desktop-control.md:
  Line 14: python3 platforms/linux/ubuntu/computer-use/scripts/desktop-control.py tree --app firefox

  Line 15: python3 platforms/linux/ubuntu/computer-use/scripts/desktop-control.py find --app firefox --name "Search" --role entry


/home/brajam/repos/opencode-rig/docs/scripts/setup-computer-assistant.md:
  Line 50: Node is used from the fnm default alias at

  Line 51: `~/.local/share/fnm/aliases/default/bin`.

  Line 99: - Verifies fnm Node/npm, `browser-tools/package.json`, and `package-lock.json`

  Line 103:   `playwright` binaries are executable, and the expected Firefox binary

  Line 104:   (resolved via `playwright install --dry-run firefox`) exists under

  Line 107:   followed by `playwright install firefox` with `PLAYWRIGHT_BROWSERS_PATH` set

  Line 186: - The pinned Playwright runtime and Firefox binary are complete.


/home/brajam/repos/opencode-rig/docs/scripts/basic-memory-mcp.md:
  Line 14: - Resolves `basic-memory` from `PATH` (or `BASIC_MEMORY_BIN`) and exits `2`

  Line 36: | `BASIC_MEMORY_BIN` | Executable override (default: `PATH` lookup) |


/home/brajam/repos/opencode-rig/docs/scripts/opencode-maintenance-cron.md:
  Line 96:   `opencode` or the fnm Node directory.


/home/brajam/repos/opencode-rig/platforms/linux/ubuntu/README.md:
  Line 8: | Browser tools | [`browser-tools/`](browser-tools/) | Pinned Playwright MCP package for live and headless Firefox |


/home/brajam/repos/opencode-rig/docs/README.md:
  Line 84: | [`scripts/playwright-mcp.md`](scripts/playwright-mcp.md) | The visible, user-shared Playwright Firefox launcher |


/home/brajam/repos/opencode-rig/platforms/windows/wsl2/ubuntu/computer-use/plugins-v2/package-lock.json:
  Line 4434:       "integrity": "sha512-RtpOm+cM6O0sHg6IA70wH+UC3FZcND+rccBZpBAHzlUgNO2Bm5BN+FnM8+OBxzXdwpKWFwX11JGF0MFRkhSoIQ==",


/home/brajam/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/verify-opencode-v2.sh:
  Line 6: # Firefox). Override paths with OPENCODE_V2_PILOT_DIR, OPENCODE_V2_BIN,


/home/brajam/repos/opencode-rig/platforms/linux/ubuntu/computer-use/skills/game-playtest/SKILL.md:
  Line 3: description: Playtest browser games in Playwright Firefox with accessibility-first inspection, bounded input, mandatory canvas or WebGL screenshots, representative state coverage, console review, responsive checks, and severity-ordered findings. Use when the user asks for a browser-game smoke test, gameplay QA, visual verification, HUD review, or reproducible bug report.

  Line 5: compatibility: Ubuntu and OpenCode with the repository's visible or explicitly requested headless Playwright Firefox tools.

  Line 26:   user and agent share that isolated Firefox window.

  Line 132: Firefox mode, viewport sizes, states and verbs covered, console/network summary,


/home/brajam/repos/opencode-rig/platforms/linux/ubuntu/computer-use/skills/browser-assistant/SKILL.md:
  Line 3: description: Interact with a visible live Playwright Firefox window shared by the user and agent, including navigation, forms, downloads, and verification. Use when the user says live browser, browse with me, use the visible browser, click a website, fill a web form, or complete an interactive web workflow. Prefer webfetch/websearch for read-only research.

  Line 7:   tags: "browser,live,playwright,firefox"

  Line 13: control one visible Firefox window shared by the user and agent for the current

  Line 17: user's normal Firefox profile or inherit its cookies, history, or tabs. The


/home/brajam/repos/opencode-rig/platforms/linux/ubuntu/computer-use/skills/browser-assistant/README.md:
  Line 9: Tags: `browser`, `live`, `playwright`, `firefox`

  Line 14: Playwright Firefox window shared by the agent and user.

  Line 32: - An isolated Firefox context; it does not inherit the user's normal profile,


/home/brajam/repos/opencode-rig/platforms/linux/ubuntu/computer-use/skills/game-playtest/README.md:
  Line 15: and reproducible bug reports. It uses the repository's Playwright Firefox tools

  Line 31: - whether normal visible Firefox or explicitly requested headless Firefox is in

  Line 37: from the user's normal Firefox profile.

  Line 41: - "Smoke-test this browser game in the visible Firefox window."

  Line 80: - Resizing Firefox to a mobile viewport does not emulate every touch, safe-area,

  Line 101:   package and Firefox installation. Do not switch to blind desktop clicking.

  Line 121:   user-shared Playwright Firefox session.


/home/brajam/repos/opencode-rig/platforms/linux/ubuntu/computer-use/skills/web-3d-asset-pipeline/PROVENANCE.md:
  Line 25:   file, and Firefox screenshot rules from this repository's safety policy.


/home/brajam/repos/opencode-rig/platforms/linux/ubuntu/computer-use/skills/web-3d-asset-pipeline/SKILL.md:
  Line 3: description: Prepare and verify runtime-ready 3D assets for browser projects, including pivots, units, transforms, hierarchy, naming, materials, textures, GLB export, clean reimport, optional approved compression, and Firefox load checks. Use when the user asks to clean, optimize, export, or validate a web 3D asset.

  Line 5: compatibility: Ubuntu and OpenCode; uses existing DCC, project, and Firefox tooling without requiring a Blender MCP server.

  Line 80:    Firefox. For an interactive check use the connected live Playwright tools:

  Line 115: the exact command and settings, revalidate structure, and repeat the Firefox


/home/brajam/repos/opencode-rig/platforms/linux/ubuntu/computer-use/skills/README.md:
  Line 30: - `browser-assistant` shares a visible isolated Firefox window with the user.

  Line 63: | [`browser-assistant`](./browser-assistant/SKILL.md) | [`README.md`](./browser-assistant/README.md) | `browser` | `browser,live,playwright,firefox` |

  Line 130: Interact with websites in a visible Playwright Firefox window shared by the

  Line 145: `../../browser-tools/`. The visible session is isolated from normal Firefox,

  Line 151: Run isolated browser tasks through Playwright Firefox without opening a visible

  Line 171: Playtest browser games in Playwright Firefox with accessibility-first

  Line 185: Requires: the repository's visible Playwright Firefox by default, or headless

  Line 333: optional approved compression, and Firefox load checks.

  Line 342: - "Validate this GLB's hierarchy, materials, size, and Firefox load."

  Line 346: Firefox loader. It does not install undeclared optimization dependencies. This


/home/brajam/repos/opencode-rig/platforms/linux/ubuntu/computer-use/skills/web-3d-asset-pipeline/README.md:
  Line 19: repository's Ubuntu, Blender, file-safety, and Playwright Firefox tools. See

  Line 30: - the available visible `playwright` MCP for interactive Firefox validation

  Line 46:   Firefox."

  Line 63:    in visible Playwright Firefox.

  Line 69: without unexpected loss, and loads visibly in Firefox without asset-related

  Line 118:   Playwright Firefox session.


/home/brajam/repos/opencode-rig/platforms/linux/ubuntu/computer-use/skills/browser-headless/SKILL.md:
  Line 3: description: Run isolated browser tasks through headless Playwright Firefox with no visible window. Use ONLY when the user explicitly asks for headless browsing, background browser automation, or a non-interactive Playwright task. Use the live browser instead when the user needs to see, steer, authenticate, or take over the page.

  Line 17: script must launch an isolated headless Firefox context, share no state with

  Line 58: If the runtime is unavailable, verify the pinned browser package and Firefox


/home/brajam/repos/opencode-rig/platforms/linux/ubuntu/computer-use/skills/browser-headless/README.md:
  Line 32: - An isolated headless Firefox context with no shared state with the live

  Line 99: - Runtime unavailable: verify the pinned `playwright` package and Firefox


/home/brajam/repos/opencode-rig/platforms/linux/ubuntu/computer-use/skills/blender/SKILL.md:
  Line 93:   for a browser, a Firefox runtime load check.


/home/brajam/repos/opencode-rig/platforms/linux/ubuntu/computer-use/skills/blender/references/verification-and-export.md:
  Line 95: web asset, also load it through the project's existing loader in Firefox,


/home/brajam/repos/opencode-rig/platforms/linux/ubuntu/computer-use/plugins-v2/package-lock.json:
  Line 5466:       "integrity": "sha512-RtpOm+cM6O0sHg6IA70wH+UC3FZcND+rccBZpBAHzlUgNO2Bm5BN+FnM8+OBxzXdwpKWFwX11JGF0MFRkhSoIQ==",


/home/brajam/repos/opencode-rig/platforms/linux/ubuntu/computer-use/plugins-v2/integrated-browser/README.md:
  Line 29: that pilot cache; do not remove the cache root or the repository Firefox bundle.

  Line 91: installed OpenCode binaries, or replace the existing Firefox Playwright MCP.


---

## Assistant

_Thinking:_

**Inspecting fixture definitions for WSL testing**

**Tool: read**

**Input:**
```json
{
  "path": "/home/brajam/repos/opencode-rig/platforms/windows/wsl2/ubuntu/computer-use/scripts/self-test.py",
  "offset": 140,
  "limit": 180
}
```

Read file /home/brajam/repos/opencode-rig/platforms/windows/wsl2/ubuntu/computer-use/scripts/self-test.py, lines 140-319
140:         generic_packages = (shared_server_packages | shared_cli_packages) - {
141:             path for path in shared_server_packages | shared_cli_packages
142:             if path.name == "wsl-interop"
143:         }
144:         canonical_root = configure.PLATFORM_ROOT.parents[3] / "linux" / "ubuntu" / "computer-use" / "plugins-v2"
145:         if any(canonical_root not in path.parents for path in generic_packages):
146:             raise AssertionError("generic WSL profile packages are not owned by canonical Ubuntu")
147:         if (shared_target / "cli.json").exists():
148:             raise AssertionError("shared WSL deployment wrote a duplicate CLI config")
149:         setup_source = SETUP_SCRIPT.read_text(encoding="utf-8")
150:         if '"$SCRIPT_DIR/deploy-plugins.sh"' not in setup_source:
151:             raise AssertionError("WSL setup does not delegate plugin deployment to the shared wrapper")
152:         versions = configure.MCP.load_policy()
153:         wrappers = {
154:             "basicMemory": configure.CANONICAL_ROOT / "scripts" / "basic-memory-mcp.sh",
155:             "playwright": configure.CANONICAL_ROOT / "scripts" / "playwright-mcp.sh",
156:         }
157:         if (Path(__file__).resolve().parent / "basic-memory-mcp.sh").exists():
158:             raise AssertionError("WSL keeps a duplicate Basic Memory wrapper")
159:         if (Path(__file__).resolve().parent / "playwright-mcp.sh").exists():
160:             raise AssertionError("WSL keeps a duplicate Playwright wrapper")
161:         if (configure.CONFIG_ROOT / "mcp-versions.json").exists():
162:             raise AssertionError("WSL keeps a duplicate MCP version policy")
163:         for key, wrapper in wrappers.items():
164:             source = wrapper.read_text(encoding="utf-8")
165:             if str(versions["basicMemory" if key == "basicMemory" else "playwright"]) not in source:
166:                 if "mcp_runtime.py" not in source:
167:                     raise AssertionError(f"{wrapper.name} does not use the canonical policy")
168:             if "/usr/bin/env -i" not in source or "mcp_runtime.py" not in source:
169:                 raise AssertionError(f"{wrapper.name} is not environment-isolated through canonical runtime")
170:             if "@latest" in source:
171:                 raise AssertionError(f"{wrapper.name} uses an unpinned latest package")
172:         windows_setup = (Path(__file__).resolve().parent / "setup-open-rig-wsl.ps1").read_text(encoding="utf-8")
173:         if '-replace "`0", ""' not in windows_setup or '"\\s2\\s*$"' not in windows_setup:
174:             raise AssertionError("Windows prerequisite verifier does not normalize WSL UTF-16 output")
175:         writable_runner = root / "writable-uvx"
176:         writable_runner.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
177:         writable_runner.chmod(0o722)
178:         rejected_runner = subprocess.run(
179:             [str(wrappers["basicMemory"]), "--provision"],
180:             check=False,
181:             capture_output=True,
182:             text=True,
183:             env={
184:                 **os.environ,
185:                 "OPENCODE_WSL2_PILOT_DIR": str(target.parent),
186:                 "OPENCODE_MCP_PROFILE": "wsl2",
187:                 "OPENCODE_MCP_PROFILE_ROOT": str(target.parent),
188:                 "OPENCODE_MCP_UVX_BIN": str(writable_runner),
189:             },
190:         )
191:         if rejected_runner.returncode == 0 or "no trusted uvx runner" not in rejected_runner.stderr:
192:             raise AssertionError("Basic Memory wrapper accepted a writable package runner")
193:         unsupported_profile = subprocess.run(
194:             [str(wrappers["basicMemory"]), "--verify-only"],
195:             check=False,
196:             capture_output=True,
197:             text=True,
198:             env={
199:                 **os.environ,
200:                 "OPENCODE_MCP_PROFILE": "unsupported",
201:                 "OPENCODE_MCP_PROFILE_ROOT": str(target.parent),
202:             },
203:         )
204:         if unsupported_profile.returncode == 0 or "unsupported MCP profile" not in unsupported_profile.stderr:
205:             raise AssertionError("Basic Memory wrapper accepted an unsupported profile")
206:         basic_environment = target.parent / "cache" / "uv" / "environments-v2" / "scope" / "environment"
207:         basic_executable = basic_environment / "bin" / "basic-memory"
208:         basic_executable.parent.mkdir(parents=True)
209:         basic_executable.write_text("#!/usr/bin/env sh\nexit 0\n", encoding="utf-8")
210:         basic_executable.chmod(0o700)
211:         basic_package = basic_environment / "lib" / "python3.12" / "site-packages" / f"basic_memory-{versions['basicMemory']}.dist-info"
212:         basic_package.mkdir(parents=True)
213:         node_bin = target.parent / "mcp" / "node" / f"node-v{versions['nodeVersion']}-linux-x64" / "bin"
214:         node_bin.mkdir(parents=True)
215:         (node_bin / "node").write_text(
216:             f"#!/usr/bin/env sh\nprintf 'v{versions['nodeVersion']}\\n'\n",
217:             encoding="utf-8",
218:         )
219:         (node_bin / "npm").write_text("#!/usr/bin/env sh\nprintf '10.9.4\\n'\n", encoding="utf-8")
220:         (node_bin / "npx").write_text("#!/usr/bin/env sh\nexit 0\n", encoding="utf-8")
221:         for runner in (node_bin / "node", node_bin / "npm", node_bin / "npx"):
222:             runner.chmod(0o700)
223:         basic_config = target.parent / "mcp" / "basic-memory" / "home" / "config.json"
224:         basic_config.parent.mkdir(parents=True, exist_ok=True)
225:         basic_config.write_text(
226:             json.dumps(
227:                 {
228:                     "projects": {
229:                         "computer-assistant": {
230:                             "path": str(target.parent / "mcp" / "basic-memory" / "notes"),
231:                             "mode": "local",
232:                         }
233:                     },
234:                     "default_project": "computer-assistant",
235:                 }
236:             )
237:             + "\n",
238:             encoding="utf-8",
239:         )
240:         playwright_package = target.parent / "cache" / "npm" / "_npx" / "run" / "node_modules" / "@playwright" / "mcp" / "package.json"
241:         playwright_package.parent.mkdir(parents=True)
242:         playwright_package.write_text(json.dumps({"version": versions["playwright"]}) + "\n", encoding="utf-8")
243:         revision = versions["playwrightBrowserRevision"]
244:         browser = target.parent / "cache" / "ms-playwright" / f"chromium-{revision}" / "chrome-linux64" / "chrome"
245:         browser.parent.mkdir(parents=True)
246:         browser.write_text("#!/usr/bin/env sh\nexit 0\n", encoding="utf-8")
247:         browser.chmod(0o700)
248:         configure.mcp_provisioning(target, apply=True)
249:         configure.mcp_provisioning(target, apply=False)
250:         profile_before_verify = {
251:             path.relative_to(target.parent): (path.read_bytes(), path.stat().st_mode & 0o777)
252:             for path in target.parent.rglob("*")
253:             if path.is_file() and not path.is_symlink()
254:         }
255:         delegated = subprocess.run(
256:             [str(SETUP_MCPS_SCRIPT), "--pilot-dir", str(target.parent), "--verify-only"],
257:             check=False,
258:             capture_output=True,
259:             text=True,
260:         )
261:         if delegated.returncode != 0:
262:             raise AssertionError(f"WSL MCP setup did not delegate to canonical verification: {delegated.stderr}")
263:         profile_after_verify = {
264:             path.relative_to(target.parent): (path.read_bytes(), path.stat().st_mode & 0o777)
265:             for path in target.parent.rglob("*")
266:             if path.is_file() and not path.is_symlink()
267:         }
268:         if profile_after_verify != profile_before_verify:
269:             raise AssertionError("WSL MCP verify-only changed isolated profile state")
270:         playwright_package.write_text('{"version":"stale"}\n', encoding="utf-8")
271:         expect_error(lambda: configure.mcp_provisioning(target, apply=False), "Playwright MCP's canonical pinned")
272:         playwright_package.write_text(json.dumps({"version": versions["playwright"]}) + "\n", encoding="utf-8")
273:         marker = target.parent / "mcp" / "provisioned.json"
274:         marker_data = configure.load_json(marker)
275:         marker_data["playwright"] = "stale"
276:         configure.atomic_write(marker, marker_data)
277:         expect_error(lambda: configure.mcp_provisioning(target, apply=False), "missing or stale")
278:         configure.mcp_provisioning(target, apply=True)
279:         quiet = subprocess.run(
280:             [sys.executable, str(SCRIPT), "check-path", "--config-dir", str(target), "--quiet"],
281:             check=True,
282:             capture_output=True,
283:             text=True,
284:         )
285:         if quiet.stdout or quiet.stderr:
286:             raise AssertionError("quiet path validation emitted transport-corrupting output")
287:         before = (server.read_bytes(), cli.read_bytes())
288:         configure.deploy(target, "all", apply=False)
289:         if before != (server.read_bytes(), cli.read_bytes()):
290:             raise AssertionError("read-only deployment verification changed bytes")
291:         configure.seed(target, apply=True)
292:         configure.deploy(target, "all", apply=True)
293:         after = (server.read_bytes(), cli.read_bytes())
294:         if before != after:
295:             raise AssertionError("idempotent setup/deployment changed bytes")
296: 
297:         server_data = configure.load_json(server)
298:         server_data["unrelated"] = {"preserved": True}
299:         configure.atomic_write(server, server_data)
300:         configure.deploy(target, "all", apply=True)
301:         if configure.load_json(server).get("unrelated") != {"preserved": True}:
302:             raise AssertionError("deployment did not preserve unrelated server configuration")
303: 
304:         disabled = configure.load_json(server)
305:         package = configure.validate_catalog()[0]["package"]
306:         for entry in disabled["plugins"]:
307:             if configure.configured_package(entry) == package:
308:                 entry["options"]["enabled"] = False
309:         configure.atomic_write(server, disabled)
310:         configure.deploy(target, "server", apply=True)
311:         matches = [
312:             entry for entry in configure.load_json(server)["plugins"]
313:             if configure.configured_package(entry) == package
314:         ]
315:         if matches != [configure.plugin_object(package)]:
316:             raise AssertionError("deployment did not normalize disabled plugin options")
317: 
318:         duplicate = root / "duplicate.jsonc"
319:         duplicate.write_text('{"value": 1, "value": 2}\n', encoding="utf-8")
[Output truncated. Continue reading with offset: 320]

---

## Assistant

_Thinking:_

**Planning run_limited fixes and test assertions**

_Thinking:_

**Designing fake runtime environment for tests**

_Thinking:_

**Implementing fake systemd-run and prlimit scripts**

_Thinking:_

**Implementing fake uvx version output**

_Thinking:_

**Designing project add config handling**

_Thinking:_

**Planning setup marker update after project add**

The focused review found one WSL-only defect before it could reach users: its Basic Memory limiter helper could invoke both `systemd-run` and `prlimit` sequentially. I’m correcting that and adding an execution-level regression, not just a source-text assertion.

**Tool: patch**

**Input:**
```json
{}
```

Tool execution interrupted
