import assert from "node:assert/strict"
import test from "node:test"

import { mcpStatusCounts, mcpStatusText } from "../src/mcp-sidebar.ts"

test("formats native-style MCP statuses", () => {
  assert.equal(mcpStatusText({ status: { status: "connected" } }), "Connected")
  assert.equal(mcpStatusText({ status: { status: "pending" } }), "Connecting")
  assert.equal(mcpStatusText({ status: { status: "disabled" } }), "Disabled")
  assert.equal(mcpStatusText({ status: { status: "failed", error: "Connection refused" } }), "Connection refused")
  assert.equal(mcpStatusText({ status: { status: "needs_auth", error: "Sign in" } }), "Needs auth")
})

test("summarizes active and error MCP servers", () => {
  assert.deepEqual(mcpStatusCounts([
    { status: { status: "connected" } },
    { status: { status: "connected" } },
    { status: { status: "pending" } },
    { status: { status: "failed", error: "Offline" } },
    { status: { status: "needs_auth", error: "Sign in" } },
  ]), { active: 2, errors: 2 })
})
