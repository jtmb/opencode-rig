import assert from "node:assert/strict"
import test from "node:test"

import {
  IMAGE_ENDPOINT,
  RESPONSES_ENDPOINT,
  SEARCH_ENDPOINT,
  createChatGPTBackend,
  type CodexCredential,
} from "../src/backend.ts"

const credential: CodexCredential = { accessToken: "oauth-test-token", accountID: "account-1" }

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  })
}

test("image generation uses the Codex OAuth route and fixed GPT image request", async () => {
  let calledURL = ""
  let request: RequestInit | undefined
  const backend = createChatGPTBackend(async (input, init) => {
    calledURL = String(input)
    request = init
    return response({ data: [{ b64_json: "aGVsbG8=" }] })
  })

  const image = await backend.generateImage({
    credential,
    prompt: "A watercolor lighthouse",
    signal: new AbortController().signal,
  })

  assert.equal(calledURL, IMAGE_ENDPOINT)
  assert.equal(image, "aGVsbG8=")
  assert.equal(request?.method, "POST")
  assert.equal(request?.redirect, "error")
  assert.deepEqual(JSON.parse(String(request?.body)), {
    prompt: "A watercolor lighthouse",
    model: "gpt-image-2",
    background: "auto",
    quality: "auto",
    size: "auto",
  })
  const headers = new Headers(request?.headers)
  assert.equal(headers.get("authorization"), "Bearer oauth-test-token")
  assert.equal(headers.get("chatgpt-account-id"), "account-1")
})

test("research uses at most three official search queries and returns only usable sources", async () => {
  let calledURL = ""
  let request: RequestInit | undefined
  const backend = createChatGPTBackend(async (input, init) => {
    calledURL = String(input)
    request = init
    return response({
      output: "Use the official references below.",
      results: [
        { type: "text_result", title: "OpenAI Docs", url: "https://openai.com/docs" },
        { type: "text_result", title: "Unsafe URL", url: "javascript:alert(1)" },
      ],
    })
  })

  const result = await backend.webSearch({
    credential,
    model: "gpt-5.4-codex",
    sessionID: "ses_research1",
    query: "Codex responses endpoint",
    mode: "research",
    signal: new AbortController().signal,
  })

  assert.equal(calledURL, SEARCH_ENDPOINT)
  assert.equal(result.searchPerformed, true)
  assert.deepEqual(result.sources, [{ title: "OpenAI Docs", url: "https://openai.com/docs" }])
  const body = JSON.parse(String(request?.body)) as Record<string, any>
  assert.equal(body.id, "ses_research1")
  assert.equal(body.model, "gpt-5.4-codex")
  assert.equal(body.commands.response_length, "long")
  assert.equal(body.commands.search_query.length, 3)
  assert.equal(body.commands.search_query[0].q, "Codex responses endpoint")
  assert.equal(body.settings.search_context_size, "high")
  assert.equal(body.settings.external_web_access, true)
})

test("search returns no more than twenty verified sources", async () => {
  const backend = createChatGPTBackend(async () => response({
    output: "Research summary",
    results: Array.from({ length: 25 }, (_, index) => ({
      title: `Source ${index + 1}`,
      url: `https://example.com/${index + 1}`,
    })),
  }))

  const result = await backend.webSearch({
    credential,
    model: "gpt-5.4-codex",
    sessionID: "ses_many1",
    query: "bounded sources",
    mode: "research",
    signal: new AbortController().signal,
  })

  assert.equal(result.sources?.length, 20)
  assert.equal(new Set(result.sources?.map((source) => source.url)).size, 20)
})

test("search fails closed when the Codex response has no usable source links", async () => {
  const backend = createChatGPTBackend(async () => response({
    output: "A search summary without structured sources.",
    results: [{ title: "Unusable", url: "javascript:void(0)" }],
  }))

  await assert.rejects(
    backend.webSearch({
      credential,
      model: "gpt-5.4-codex",
      sessionID: "ses_quick1",
      query: "OpenAI",
      mode: "quick",
      signal: new AbortController().signal,
    }),
    /no usable source links/,
  )
})

test("plain chat streams Codex Responses text without tools or stored history", async () => {
  let calledURL = ""
  let request: RequestInit | undefined
  const backend = createChatGPTBackend(async (input, init) => {
    calledURL = String(input)
    request = init
    return new Response([
      'data: {"type":"response.created","response":{"id":"resp-1"}}',
      'data: {"type":"response.output_text.delta","delta":"Hello"}',
      'data: {"type":"response.output_text.delta","delta":" there."}',
      'data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"Hello there."}]}]}}',
      "",
    ].join("\n\n"), { headers: { "content-type": "text/event-stream" } })
  })

  const text = await backend.chat({
    credential,
    model: "gpt-5.4-codex",
    messages: [
      { role: "user", text: "Hi" },
      { role: "assistant", text: "Hello." },
      { role: "user", text: "Continue" },
    ],
    signal: new AbortController().signal,
  })

  assert.equal(calledURL, RESPONSES_ENDPOINT)
  assert.equal(text, "Hello there.")
  assert.equal(request?.method, "POST")
  const headers = new Headers(request?.headers)
  assert.equal(headers.get("accept"), "text/event-stream")
  const body = JSON.parse(String(request?.body)) as Record<string, any>
  assert.equal(body.model, "gpt-5.4-codex")
  assert.equal(body.store, false)
  assert.equal(body.stream, true)
  assert.equal(body.max_output_tokens, 4096)
  assert.equal("tools" in body, false)
  assert.deepEqual(body.input.map((item: any) => item.role), ["user", "assistant", "user"])
  assert.deepEqual(body.input[0].content, [{ type: "input_text", text: "Hi" }])
  assert.deepEqual(body.input[1].content, [{ type: "output_text", text: "Hello." }])
})
