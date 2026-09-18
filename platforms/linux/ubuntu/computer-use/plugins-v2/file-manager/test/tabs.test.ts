import assert from "node:assert/strict"
import test from "node:test"

import {
  EMPTY_TABS,
  activateTab,
  closeTab,
  dirtyTabs,
  markSaved,
  nextTab,
  openTab,
  persistTabs,
  replaceTab,
  restorePaths,
  restoredActive,
  takeClosed,
  updateTab,
} from "../src/tabs.ts"

const tab = (path: string, content = "content") => ({ path, content, original: content })

test("openTab adds and activates, and re-opening activates without duplicating", () => {
  const one = openTab(EMPTY_TABS, tab("a.ts"))
  assert.deepEqual(one.open.map((entry) => entry.path), ["a.ts"])
  assert.equal(one.active, "a.ts")

  const two = openTab(one, tab("b.ts"))
  assert.deepEqual(two.open.map((entry) => entry.path), ["a.ts", "b.ts"])
  assert.equal(two.active, "b.ts")

  const back = openTab(two, tab("a.ts", "stale"))
  assert.deepEqual(back.open.map((entry) => entry.path), ["a.ts", "b.ts"])
  assert.equal(back.active, "a.ts")
  assert.equal(back.open[0].content, "content")
})

test("updateTab and markSaved track the dirty baseline", () => {
  const state = openTab(EMPTY_TABS, tab("a.ts"))
  const edited = updateTab(state, "a.ts", "changed")
  assert.equal(dirtyTabs(edited).length, 1)
  const saved = markSaved(edited, "a.ts")
  assert.equal(dirtyTabs(saved).length, 0)
  assert.equal(saved.open[0].original, "changed")
})

test("replaceTab refreshes an existing tab without changing the closed stack", () => {
  const state = openTab(EMPTY_TABS, tab("a.ts", "old"))
  const refreshed = replaceTab(state, tab("a.ts", "from disk"))
  assert.equal(refreshed.active, "a.ts")
  assert.equal(refreshed.open[0].content, "from disk")
  assert.equal(refreshed.open[0].original, "from disk")
  assert.deepEqual(refreshed.closed, [])
})

test("closeTab selects the neighbor and records the closed path", () => {
  const state = openTab(openTab(EMPTY_TABS, tab("a.ts")), tab("b.ts"))
  const closed = closeTab(state, "b.ts")
  assert.deepEqual(closed.open.map((entry) => entry.path), ["a.ts"])
  assert.equal(closed.active, "a.ts")
  assert.deepEqual(closed.closed, ["b.ts"])

  const middle = closeTab(openTab(openTab(openTab(EMPTY_TABS, tab("a.ts")), tab("b.ts")), tab("c.ts")), "b.ts")
  assert.equal(middle.active, "c.ts")
})

test("takeClosed pops the most recent or a named path", () => {
  const state = closeTab(openTab(EMPTY_TABS, tab("a.ts")), "a.ts")
  const popped = takeClosed(state)
  assert.equal(popped.path, "a.ts")
  assert.deepEqual(popped.state.closed, [])
  assert.equal(takeClosed(EMPTY_TABS).path, undefined)
})

test("nextTab wraps in both directions", () => {
  const state = openTab(openTab(openTab(EMPTY_TABS, tab("a.ts")), tab("b.ts")), tab("c.ts"))
  assert.equal(nextTab(state, 1).active, "a.ts")
  assert.equal(nextTab(state, -1).active, "b.ts")
  assert.equal(nextTab({ ...state, active: "b.ts" }, 1).active, "c.ts")
})

test("persistence round-trips paths and active", () => {
  const state = openTab(openTab(EMPTY_TABS, tab("a.ts")), tab("b.ts"))
  const saved = persistTabs(state)
  assert.deepEqual(saved, { open: ["a.ts", "b.ts"], active: "b.ts" })
  assert.deepEqual(restorePaths(saved), ["a.ts", "b.ts"])
  assert.equal(restoredActive(saved, ["a.ts", "b.ts"]), "b.ts")
})

test("restorePaths tolerates malformed input and drops duplicates", () => {
  assert.deepEqual(restorePaths(undefined), [])
  assert.deepEqual(restorePaths({ open: ["a.ts", "a.ts", 7, ""] }), ["a.ts"])
  assert.equal(restoredActive({ active: "missing" }, ["a.ts"]), "a.ts")
  assert.equal(restoredActive({}, []), "")
})

test("activateTab ignores unknown paths", () => {
  const state = openTab(EMPTY_TABS, tab("a.ts"))
  assert.equal(activateTab(state, "nope"), state)
})
