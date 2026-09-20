import assert from "node:assert/strict"
import test from "node:test"

import { classifyFailure, classifyRetryMessage, shouldTrigger } from "../src/detect.ts"

test("classifies codex usage limit errors as quota", () => {
  const apiError = {
    name: "APIError",
    data: {
      message: "The usage limit has been reached",
      statusCode: 429,
      responseBody: JSON.stringify({ error: { type: "usage_limit_reached" } }),
      isRetryable: true,
    },
  }
  const info = classifyFailure(apiError)
  assert.equal(info?.kind, "quota")
  assert.equal(info?.status, 429)
  assert.equal(shouldTrigger(info, "quota"), true)

  const message = classifyRetryMessage(
    "You have hit your ChatGPT usage limit (prolite plan). Try again in ~97 min.",
  )
  assert.equal(message?.kind, "quota")
  assert.equal(shouldTrigger(message, "quota"), true)
})

test("classifies insufficient quota responses as quota", () => {
  const info = classifyFailure({
    name: "APIError",
    data: {
      message: "Quota exceeded.",
      statusCode: 429,
      responseBody: '{"error":{"code":"insufficient_quota"}}',
    },
  })
  assert.equal(info?.kind, "quota")
})

test("classifies provider balance exhaustion as quota", () => {
  for (const message of [
    "Insufficient Balance",
    "insufficient credits",
    "insufficient-funds",
    "Account credits are exhausted",
  ]) {
    const info = classifyFailure({ name: "APIError", data: { message } })
    assert.equal(info?.kind, "quota", message)
    assert.equal(shouldTrigger(info, "quota"), true, message)
  }
})

test("classifies typed free and go usage exhaustion as quota", () => {
  for (const error of [
    { name: "APIError", data: { type: "freeUsageExceeded" } },
    { name: "APIError", data: { type: "go_usage_exhausted" } },
    { name: "APIError", data: { error: { code: "free-usage-limit" } } },
  ]) {
    const info = classifyFailure(error)
    assert.equal(info?.kind, "quota", JSON.stringify(error))
    assert.equal(shouldTrigger(info, "quota"), true, JSON.stringify(error))
  }
})

test("classifies transient rate limits separately", () => {
  const info = classifyFailure({
    name: "APIError",
    data: { message: "Too many requests", statusCode: 429, isRetryable: true },
  })
  assert.equal(info?.kind, "rate-limit")
  assert.equal(shouldTrigger(info, "quota"), false)
  assert.equal(shouldTrigger(info, "any-retryable"), true)
})

test("classifies server errors and aborts", () => {
  const server = classifyFailure({ data: { message: "internal server error", statusCode: 500 } })
  assert.equal(server?.kind, "other")
  assert.equal(server?.status, 500)
  assert.equal(shouldTrigger(server, "quota"), false)
  assert.equal(shouldTrigger(server, "any-retryable"), true)

  const aborted = classifyFailure({ name: "MessageAbortedError" })
  assert.equal(aborted?.kind, "aborted")
  assert.equal(shouldTrigger(aborted, "any-retryable"), false)
})

test("handles empty and malformed failures", () => {
  assert.equal(classifyFailure(undefined), undefined)
  assert.equal(classifyFailure({}), undefined)
  assert.equal(classifyRetryMessage(""), undefined)
  assert.equal(classifyRetryMessage(undefined), undefined)
  assert.equal(shouldTrigger(undefined, "quota"), false)
})

test("reads status codes from nested error shapes", () => {
  const info = classifyFailure({ data: { statusCode: "429", message: "slow down" } })
  assert.equal(info?.status, 429)
  assert.equal(info?.kind, "rate-limit")
})
