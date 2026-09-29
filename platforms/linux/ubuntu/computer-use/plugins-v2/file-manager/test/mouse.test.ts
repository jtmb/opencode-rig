import assert from "node:assert/strict"
import test from "node:test"

import { consumeMouseActivation, editorCursorPosition } from "../src/mouse.ts"

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

test("editor clicks map to bounded rows and columns", () => {
  assert.deepEqual(
    editorCursorPosition(
      { x: 13, y: 12, button: 0 },
      { x: 10, y: 8, scrollY: 1, lineCount: 3, lines: ["zero", "one", "two"] },
    ),
    { row: 2, column: 3 },
  )
  assert.deepEqual(
    editorCursorPosition(
      { x: 0, y: 0 },
      { x: 10, y: 8, scrollY: 0, lineCount: 3, lines: ["zero", "one", "two"] },
    ),
    { row: 0, column: 0 },
  )
})

test("editor clicks ignore non-primary buttons", () => {
  assert.equal(
    editorCursorPosition(
      { x: 10, y: 8, button: 2 },
      { x: 10, y: 8, scrollY: 0, lineCount: 1, lines: ["text"] },
    ),
    undefined,
  )
})
