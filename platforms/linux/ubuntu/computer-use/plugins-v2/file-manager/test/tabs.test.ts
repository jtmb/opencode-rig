import assert from "node:assert/strict"
import test from "node:test"

import {
  EMPTY_TABS,
  activateTab,
  closeTab,
  dirtyTabs,
  dirtyGuard,
  dirtyGuardKey,
  dirtyGuards,
  markSaved,
  markSavedSnapshot,
  nextTab,
  openTab,
  persistTabs,
  replaceTab,
  restorePaths,
  restoredActive,
  sameDirtyGuard,
  saveSnapshot,
  tabRevision,
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

test("revisions keep a newer edit dirty when an older save completes", () => {
  const loaded = {
    path: "a.ts",
    content: "one",
    original: "one",
    diskFingerprint: "disk-one",
    mode: 0o640,
    revision: 0,
  }
  const state = openTab(EMPTY_TABS, loaded)
  const snapshot = saveSnapshot(loaded)
  assert.ok(snapshot)
  const edited = updateTab(state, "a.ts", "two")
  const newer = updateTab(edited, "a.ts", "three")
  assert.equal(tabRevision(newer.open[0]), 2)

  const afterSave = markSavedSnapshot(newer, snapshot, "disk-two", 0o640)
  assert.equal(afterSave.open[0].original, "one")
  assert.equal(afterSave.open[0].content, "three")
  assert.equal(afterSave.open[0].diskFingerprint, "disk-two")
  assert.equal(dirtyTabs(afterSave).length, 1)
})

test("dirty guards include the path and content revision", () => {
  const state = openTab(EMPTY_TABS, tab("a.ts"))
  const dirty = updateTab(state, "a.ts", "changed")
  const guard = dirtyGuard(dirty.open[0])
  assert.equal(sameDirtyGuard(guard, { path: "a.ts", revision: 1 }), true)
  assert.equal(sameDirtyGuard(guard, { path: "a.ts", revision: 2 }), false)
  assert.deepEqual(dirtyGuards(dirty), [guard])
  assert.equal(dirtyGuardKey([guard]), "a.ts:1")
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
  assert.deepEqual(restorePaths({ open: ["a.ts", "a.ts", 7, "", "../escape", ".git/config"] }), ["a.ts"])
  assert.equal(restoredActive({ active: "missing" }, ["a.ts"]), "a.ts")
  assert.equal(restoredActive({}, []), "")
})

test("activateTab ignores unknown paths", () => {
  const state = openTab(EMPTY_TABS, tab("a.ts"))
  assert.equal(activateTab(state, "nope"), state)
})
