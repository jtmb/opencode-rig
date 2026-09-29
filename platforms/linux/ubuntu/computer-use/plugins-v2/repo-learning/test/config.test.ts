import assert from "node:assert/strict"
import test from "node:test"

import {
  DEFAULT_REPO_LEARNING_OPTIONS,
  REPO_LEARNING_OPTIONS_SCHEMA,
  resolveRepoLearningOptions,
} from "../src/config.ts"

test("repo-learning options default on when enabled is omitted", () => {
  assert.deepEqual(resolveRepoLearningOptions(undefined), {
    options: { enabled: true },
    diagnostics: [],
  })
  assert.deepEqual(resolveRepoLearningOptions({}), {
    options: { enabled: true },
    diagnostics: [],
  })
  assert.equal(DEFAULT_REPO_LEARNING_OPTIONS.enabled, true)
  assert.equal(REPO_LEARNING_OPTIONS_SCHEMA.enabled.type, "boolean")
  assert.equal(REPO_LEARNING_OPTIONS_SCHEMA.enabled.default, true)
})

test("only the literal boolean false disables repository learning", () => {
  assert.deepEqual(resolveRepoLearningOptions({ enabled: true }).options, { enabled: true })
  assert.deepEqual(resolveRepoLearningOptions({ enabled: false }).options, { enabled: false })

  for (const enabled of ["false", 0, 1, null, [], {}]) {
    const result = resolveRepoLearningOptions({ enabled })
    assert.equal(result.options.enabled, true)
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.includes("enabled must be a boolean")))
  }
})

test("malformed containers and unsupported options diagnose and keep the safe default", () => {
  for (const input of [null, false, "enabled=false", []]) {
    const result = resolveRepoLearningOptions(input)
    assert.equal(result.options.enabled, true)
    assert.ok(result.diagnostics.length > 0)
  }

  const unsupported = resolveRepoLearningOptions({ enabled: false, paused: true })
  assert.deepEqual(unsupported.options, { enabled: false })
  assert.ok(unsupported.diagnostics.some((diagnostic) => diagnostic.includes("unsupported repo-learning option")))
})
