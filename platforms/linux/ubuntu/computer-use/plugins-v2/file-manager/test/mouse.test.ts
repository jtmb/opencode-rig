import assert from "node:assert/strict"
import test from "node:test"

import { consumeMouseActivation } from "../src/mouse.ts"

test("the first left activation is consumed", () => {
  assert.equal(consumeMouseActivation({ button: 0 }), true)
})

test("a missing button counts as the primary button", () => {
  assert.equal(consumeMouseActivation({}), true)
})

test("a repeated activation of the same event is ignored", () => {
  const event = { button: 0 }
  assert.equal(consumeMouseActivation(event), true)
  assert.equal(consumeMouseActivation(event), false)
})

test("non-primary buttons are marked but never act", () => {
  const event = { button: 2 }
  assert.equal(consumeMouseActivation(event), false)
  assert.equal(consumeMouseActivation(event), false)
})

test("preventDefault is left to the caller", () => {
  let prevented = 0
  const event = { button: 0, preventDefault: () => (prevented += 1) }
  assert.equal(consumeMouseActivation(event), true)
  event.preventDefault()
  assert.equal(prevented, 1)
})
