import assert from "node:assert/strict"
import test from "node:test"

import {
  CHATGPT_TOOLS,
  createCallToolHandler,
  type ChatgptToolDependencies,
} from "../src/mcp.ts"

const PROJECT_DIRECTORY = "/workspace/verified-project"

function harness(options: {
  output?: unknown
  saveImage?: ChatgptToolDependencies["saveImage"]
} = {}) {
  const calls: Array<{ input: unknown; directory: string }> = []
  const sessionIDs: string[] = []
  const handler = createCallToolHandler({
    async sessionDirectory(sessionID) {
      sessionIDs.push(sessionID)
      return PROJECT_DIRECTORY
    },
    async callRpc(input, directory) {
      calls.push({ input, directory })
      return options.output ?? { text: "completed" }
    },
    saveImage: options.saveImage,
  })
  return { handler, calls, sessionIDs }
}

function request(name: string, args: Record<string, unknown>, meta?: unknown) {
  return {
    params: {
      name,
      arguments: args,
      ...(meta === undefined ? {} : { _meta: meta }),
    },
  }
}

function toolText(result: { content: Array<{ type: string; text?: string }>; isError?: boolean }): string {
  return result.content.find((entry) => entry.type === "text")?.text ?? ""
}

test("registers only the three model-visible tools without session or project path arguments", () => {
  assert.deepEqual(CHATGPT_TOOLS.map((tool) => tool.name), ["generate_image", "web_search", "chat"])
  for (const tool of CHATGPT_TOOLS) {
    const properties = Object.keys(tool.inputSchema.properties)
    assert.equal(properties.includes("sessionID"), false)
    assert.equal(properties.includes("projectDirectory"), false)
  }
  assert.match(CHATGPT_TOOLS.find((tool) => tool.name === "web_search")!.description, /OAuth-backed Codex search/)
})

test("uses only the opaque invoking session from _meta and keeps it out of tool arguments", async () => {
  const { handler, calls, sessionIDs } = harness()
  const result = await handler(request("chat", { prompt: "Keep this private." }, {
    sessionID: "opaque-session-value",
    projectDirectory: "/untrusted/model/path",
  }))

  assert.equal(result.isError, undefined)
  assert.deepEqual(sessionIDs, ["opaque-session-value"])
  assert.deepEqual(calls, [{
    input: { action: "chat", prompt: "Keep this private.", sessionID: "opaque-session-value" },
    directory: PROJECT_DIRECTORY,
  }])
})

test("rejects hostile metadata and model-supplied session or project fields", async () => {
  const { handler, calls, sessionIDs } = harness()
  const invalidMetadata = await handler(request("chat", { prompt: "hello" }, { sessionID: { value: "ses_fake" } }))
  const invalidArguments = await handler(request("generate_image", {
    prompt: "Draw a leaf",
    sessionID: "ses_attacker",
    projectDirectory: "/tmp/attacker-project",
  }, { sessionID: "opaque-session-value" }))

  assert.equal(invalidMetadata.isError, true)
  assert.match(toolText(invalidMetadata), /session context is invalid/)
  assert.equal(invalidArguments.isError, true)
  assert.match(toolText(invalidArguments), /unsupported fields/)
  assert.deepEqual(calls, [])
  assert.deepEqual(sessionIDs, [])
})

test("fails closed when OpenCode omits the invoking session metadata", async () => {
  const { handler, calls } = harness()
  const result = await handler(request("chat", { prompt: "hello" }, {}))

  assert.equal(result.isError, true)
  assert.match(toolText(result), /session context is required/)
  assert.deepEqual(calls, [])
})

test("reports unsuccessful web search as an error without returning sources", async () => {
  const { handler, calls } = harness({
    output: {
      text: "The selected provider did not complete a search.",
      searchPerformed: false,
      sources: [{ title: "Unverified result", url: "https://example.com" }],
    },
  })
  const result = await handler(request("web_search", { query: "latest release", mode: "research" }, {
    sessionID: "opaque-session-value",
  }))

  assert.equal(result.isError, true)
  assert.match(toolText(result), /Search was not completed/)
  assert.doesNotMatch(toolText(result), /Unverified result|example\.com/)
  assert.deepEqual(calls, [{
    input: { action: "web_search", query: "latest release", mode: "research", sessionID: "opaque-session-value" },
    directory: PROJECT_DIRECTORY,
  }])
})

test("rejects successful search responses with missing or empty source lists", async () => {
  for (const sources of [undefined, []]) {
    const { handler } = harness({ output: {
      text: "A result without citations.",
      searchPerformed: true,
      ...(sources === undefined ? {} : { sources }),
    } })
    const result = await handler(request("web_search", { query: "verify sources" }, {
      sessionID: "opaque-session-value",
    }))

    assert.equal(result.isError, true)
    assert.match(toolText(result), /verified HTTP\(S\) search sources/)
    assert.doesNotMatch(toolText(result), /A result without citations/)
  }
})

test("rejects successful search responses with non-HTTP(S) source links", async () => {
  const { handler } = harness({ output: {
    text: "A result with an unsafe source.",
    searchPerformed: true,
    sources: [{ title: "Unsafe source", url: "javascript:alert(1)" }],
  } })
  const result = await handler(request("web_search", { query: "verify URL" }, {
    sessionID: "opaque-session-value",
  }))

  assert.equal(result.isError, true)
  assert.match(toolText(result), /invalid source URL/)
  assert.doesNotMatch(toolText(result), /javascript:alert/)
})

test("saves generated PNG output only under the session-derived project and returns file metadata", async () => {
  const saved = {
    absolutePath: `${PROJECT_DIRECTORY}/assets/generated/generated-abc.png`,
    relativePath: "assets/generated/generated-abc.png",
    bytes: 4096,
    mimeType: "image/png" as const,
  }
  const { handler, calls } = harness({
    output: { text: "A watercolor leaf.", imageBase64: "aGVsbG8=" },
    async saveImage(input) {
      assert.deepEqual(input, { projectDirectory: PROJECT_DIRECTORY, imageBase64: "aGVsbG8=" })
      return saved
    },
  })
  const result = await handler(request("generate_image", { prompt: "A watercolor leaf." }, {
    sessionID: "opaque-session-value",
  }))

  assert.equal(result.isError, undefined)
  assert.match(toolText(result), /assets\/generated\/generated-abc\.png/)
  assert.match(toolText(result), /MIME: image\/png/)
  assert.match(toolText(result), /4096 bytes/)
  assert.deepEqual(calls, [{
    input: {
      action: "generate_image",
      prompt: "A watercolor leaf.",
      sessionID: "opaque-session-value",
      projectDirectory: PROJECT_DIRECTORY,
    },
    directory: PROJECT_DIRECTORY,
  }])
})

test("turns image-save failures into a safe tool error without leaking filesystem details", async () => {
  const { handler } = harness({
    output: { text: "Generated.", imageBase64: "aGVsbG8=" },
    async saveImage() {
      throw new Error("private mount /home/secret/project is read-only")
    },
  })
  const result = await handler(request("generate_image", { prompt: "A watercolor leaf." }, {
    sessionID: "opaque-session-value",
  }))

  assert.equal(result.isError, true)
  assert.match(toolText(result), /could not be safely saved/)
  assert.doesNotMatch(toolText(result), /private mount|secret\/project/)
})

test("requires successful search confirmation, returns validated sources, and bounds arguments", async () => {
  const { handler, calls } = harness({ output: {
    text: "A real result.",
    searchPerformed: true,
    sources: [{ title: "Primary report", url: "https://example.test/source" }],
  } })
  const success = await handler(request("web_search", { query: "bounded search" }, { sessionID: "opaque-session-value" }))
  const oversized = await handler(request("web_search", { query: "q".repeat(513) }, { sessionID: "opaque-session-value" }))

  assert.equal(success.isError, undefined)
  assert.match(toolText(success), /Primary report — https:\/\/example\.test\/source/)
  assert.equal(oversized.isError, true)
  assert.match(toolText(oversized), /within its size limit/)
  assert.equal(calls.length, 1)
})

test("fails closed when validated session location is not canonical", async () => {
  let rpcCalled = false
  const handler = createCallToolHandler({
    async sessionDirectory() {
      return "/workspace/project/../other"
    },
    async callRpc() {
      rpcCalled = true
      return { text: "unreachable" }
    },
  })
  const result = await handler(request("chat", { prompt: "hello" }, { sessionID: "opaque-session-value" }))

  assert.equal(result.isError, true)
  assert.match(toolText(result), /valid project location/)
  assert.equal(rpcCalled, false)
})
