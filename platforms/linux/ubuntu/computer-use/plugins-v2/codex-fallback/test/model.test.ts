import assert from "node:assert/strict"
import test from "node:test"

import { modelFromMessage, modelKey, parseModelKey, sameModel } from "../src/model.ts"

test("formats and parses provider/model keys", () => {
  const model = { providerID: "deepseek", modelID: "deepseek-v4-flash" }
  assert.equal(modelKey(model), "deepseek/deepseek-v4-flash")
  assert.deepEqual(parseModelKey("deepseek/deepseek-v4-flash"), model)
  assert.deepEqual(parseModelKey("openai/gpt-5.3-codex-spark"), {
    providerID: "openai",
    modelID: "gpt-5.3-codex-spark",
  })
  assert.deepEqual(parseModelKey("provider/model/with/slashes"), {
    providerID: "provider",
    modelID: "model/with/slashes",
  })
})

test("rejects malformed model keys", () => {
  assert.equal(parseModelKey(undefined), undefined)
  assert.equal(parseModelKey(""), undefined)
  assert.equal(parseModelKey("no-separator"), undefined)
  assert.equal(parseModelKey("/leading"), undefined)
  assert.equal(parseModelKey("trailing/"), undefined)
  assert.equal(parseModelKey("with space/model"), undefined)
  assert.equal(parseModelKey("provider/with space"), undefined)
})

test("reads models from both user and assistant message shapes", () => {
  assert.deepEqual(modelFromMessage({ model: { providerID: "openai", modelID: "gpt-5.6-sol" } }), {
    providerID: "openai",
    modelID: "gpt-5.6-sol",
  })
  assert.deepEqual(modelFromMessage({ providerID: "deepseek", modelID: "deepseek-v4-pro" }), {
    providerID: "deepseek",
    modelID: "deepseek-v4-pro",
  })
  assert.equal(modelFromMessage({}), undefined)
  assert.equal(modelFromMessage(undefined), undefined)
})

test("compares model references", () => {
  assert.equal(sameModel({ providerID: "a", modelID: "b" }, { providerID: "a", modelID: "b" }), true)
  assert.equal(sameModel({ providerID: "a", modelID: "b" }, { providerID: "a", modelID: "c" }), false)
  assert.equal(sameModel(undefined, undefined), false)
})
