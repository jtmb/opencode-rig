import { Plugin } from "@opencode/plugin"

import { executeGitDiff } from "./diff.ts"

export default Plugin.define({
  id: "opencode-rig.git-tool",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "git_diff",
        description:
          "Read-only bounded Git diff through OpenCode's native VCS API. Returns unified diff text; optionally limit it to one repository-relative path or directory.",
        input: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["working", "branch", "committed"], description: "Comparison mode (default working)" },
            base: { type: "string", maxLength: 256, description: "Safe Git ref or object ID to compare from" },
            context: { type: "integer", minimum: 0, maximum: 20, description: "Unified diff context lines (default 3)" },
            path: { type: "string", maxLength: 1024, description: "Optional repository-relative file or directory prefix" },
            maxBytes: { type: "integer", minimum: 1024, maximum: 250000, description: "Maximum returned UTF-8 diff bytes (default 120000)" },
          },
          additionalProperties: false,
        },
        async execute(raw) {
          return { content: await executeGitDiff(raw, async (request) => ctx.vcs.diff(request)) }
        },
      })
    })
  },
})
