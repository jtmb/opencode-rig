import assert from "node:assert/strict"
import test from "node:test"

import {
  ANTHROPIC_WORKSPACE_HEADER,
  anthropicRateLimitUsage,
  anthropicWorkspaceCandidate,
  isFirstPartyAnthropicRequest,
  resolveAnthropicWorkspaceID,
  withAnthropicWorkspaceHeader,
} from "../src/anthropic.ts"

test("resolves a scoped Anthropic API key only from its API-key metadata", () => {
  const credential = anthropicWorkspaceCandidate({ anthropic_workspace_id: "wrkspc_primary" })
  assert.deepEqual(credential, { workspaceIDs: ["wrkspc_primary"], unambiguous: true })
  assert.equal(resolveAnthropicWorkspaceID([credential], undefined), "wrkspc_primary")
})

test("unscoped Anthropic keys need the explicit workspace option", () => {
  const credential = anthropicWorkspaceCandidate({ organization: "org_example" })
  assert.deepEqual(credential, { workspaceIDs: [], unambiguous: false })
  assert.equal(resolveAnthropicWorkspaceID([credential], undefined), undefined)
  assert.equal(resolveAnthropicWorkspaceID([credential], "wrkspc_configured"), "wrkspc_configured")
})

test("multiple Anthropic keys route automatically only when all metadata identifies the same workspace", () => {
  const primary = anthropicWorkspaceCandidate({ workspaceId: "wrkspc_primary" })
  const same = anthropicWorkspaceCandidate({ workspace_id: "wrkspc_primary" })
  const other = anthropicWorkspaceCandidate({ workspace_id: "wrkspc_other" })
  assert.equal(resolveAnthropicWorkspaceID([primary, same], undefined), "wrkspc_primary")
  assert.equal(resolveAnthropicWorkspaceID([primary, other], undefined), undefined)
  assert.equal(resolveAnthropicWorkspaceID([primary, other], "wrkspc_selected"), "wrkspc_selected")
  assert.equal(anthropicWorkspaceCandidate({ workspace_ids: ["wrkspc_primary", "wrkspc_other"] }).unambiguous, false)
})

test("workspace routing is restricted to first-party Anthropic API requests", () => {
  const request = new Request("https://api.anthropic.com/v1/messages", {
    headers: { Authorization: "Bearer test-key" },
  })
  const routed = withAnthropicWorkspaceHeader(request, "wrkspc_primary")
  assert.ok(routed)
  assert.equal(routed.headers.get(ANTHROPIC_WORKSPACE_HEADER), "wrkspc_primary")
  assert.equal(routed.headers.get("authorization"), "Bearer test-key")
  assert.equal(request.headers.has(ANTHROPIC_WORKSPACE_HEADER), false)

  const alreadyScoped = new Request("https://api.anthropic.com/v1/messages", {
    headers: { [ANTHROPIC_WORKSPACE_HEADER]: "wrkspc_existing" },
  })
  assert.equal(withAnthropicWorkspaceHeader(alreadyScoped, "wrkspc_primary"), alreadyScoped)
  assert.equal(withAnthropicWorkspaceHeader(new Request("https://proxy.example/v1/messages"), "wrkspc_primary"), undefined)
  assert.equal(withAnthropicWorkspaceHeader(new Request("http://api.anthropic.com/v1/messages"), "wrkspc_primary"), undefined)
  assert.equal(withAnthropicWorkspaceHeader(new Request("https://api.anthropic.com:8443/v1/messages"), "wrkspc_primary"), undefined)
  assert.equal(isFirstPartyAnthropicRequest({ url: "https://api.anthropic.com.attacker.example/v1/messages" }), false)
})

test("Anthropic rate-limit percentages require complete valid limit and remaining headers", () => {
  assert.equal(anthropicRateLimitUsage(new Headers({
    "anthropic-ratelimit-requests-limit": "100",
    "anthropic-ratelimit-requests-remaining": "34",
    "anthropic-ratelimit-tokens-limit": "2000",
    "anthropic-ratelimit-tokens-remaining": "1000",
  })), "Requests: 34% left · Tokens: 50% left")

  assert.equal(anthropicRateLimitUsage(new Headers({
    "anthropic-ratelimit-requests-limit": "100",
    "anthropic-ratelimit-requests-remaining": "101",
    "anthropic-ratelimit-tokens-remaining": "20",
  })), undefined)
})
