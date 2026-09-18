import assert from "node:assert/strict"
import test from "node:test"

import { boundedGithubMcpCommand, defaultGithubMcpCommand } from "../src/mcp.ts"
import { mebibyte, type MemoryProbe } from "../src/memory.ts"

test("builds an adaptive systemd stdio command", () => {
  const probe: MemoryProbe = {
    availableBytes: 8 * 1024 * mebibyte,
    swapFreeBytes: 2 * 1024 * mebibyte,
  }
  const command = boundedGithubMcpCommand("/tmp/github-mcp.sh", probe)
  assert.ok(command)
  assert.equal(command.budget.memoryMaxBytes, Math.floor((8 * 1024 * mebibyte * 20) / 100))
  if (command.command.endsWith("systemd-run")) {
    assert.ok(command.args.includes("--pipe"))
    assert.ok(command.args.includes(`--property=MemoryMax=${command.budget.memoryMaxBytes}`))
  } else {
    assert.ok(command.command.endsWith("prlimit"))
    assert.ok(command.args.includes(`--as=${command.budget.memoryMaxBytes}`))
  }
  assert.equal(command.args.at(-1), "/tmp/github-mcp.sh")
})

test("does not build an unbounded MCP command when memory is too low", () => {
  assert.equal(
    boundedGithubMcpCommand("/tmp/github-mcp.sh", {
      availableBytes: 200 * mebibyte,
      swapFreeBytes: 0,
    }),
    undefined,
  )
})

test("derives the canonical wrapper path from the plugin source", () => {
  assert.match(defaultGithubMcpCommand(), /platforms\/linux\/ubuntu\/computer-use\/scripts\/github-mcp\.sh$/)
})
