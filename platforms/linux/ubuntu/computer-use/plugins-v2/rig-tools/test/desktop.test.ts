import assert from "node:assert/strict"
import test from "node:test"

import { buildDesktopArgs, describeDesktopFailure } from "../src/desktop.ts"

test("apps builds the read-only apps command", () => {
  assert.deepEqual(buildDesktopArgs({ verb: "apps" }), { args: ["apps"] })
})

test("tree forwards the app, bounds, and flags", () => {
  const result = buildDesktopArgs({
    verb: "tree",
    app: "firefox",
    maxDepth: 4,
    maxNodes: 50,
    all: true,
    includeText: true,
  })
  assert.deepEqual(result, {
    args: ["tree", "--app", "firefox", "--max-depth", "4", "--max-nodes", "50", "--all", "--include-text"],
  })
})

test("find requires a name and/or role", () => {
  const result = buildDesktopArgs({ verb: "find", app: "firefox" })
  assert.ok("error" in result)
  assert.match(result.error, /name and\/or role/)
})

test("find maps the matcher, bounds, and text preview", () => {
  const result = buildDesktopArgs({
    verb: "find",
    app: "firefox",
    name: "Search",
    role: "entry",
    showing: true,
    nth: 2,
    maxDepth: 9,
    includeText: true,
  })
  assert.deepEqual(result, {
    args: ["find", "--app", "firefox", "--name", "Search", "--role", "entry", "--showing", "--nth", "2", "--max-depth", "9", "--include-text"],
  })
})

test("action previews without apply and leaves the action default to the script", () => {
  const result = buildDesktopArgs({ verb: "action", app: "firefox", name: "Reload" })
  assert.deepEqual(result, { args: ["action", "--app", "firefox", "--name", "Reload"] })
})

test("focus accepts a role-only target with a wait", () => {
  const result = buildDesktopArgs({ verb: "focus", app: "firefox", role: "entry", waitSeconds: 3 })
  assert.deepEqual(result, { args: ["focus", "--app", "firefox", "--role", "entry", "--wait-seconds", "3"] })
})

test("action requires a name because the script requires one", () => {
  const result = buildDesktopArgs({ verb: "action", app: "firefox", role: "push button" })
  assert.ok("error" in result)
  assert.match(result.error, /requires a name/)
})

test("apply requires the preview token", () => {
  const result = buildDesktopArgs({ verb: "action", app: "firefox", name: "Reload", apply: true })
  assert.ok("error" in result)
  assert.match(result.error, /requires expectToken/)
})

test("expectToken without apply is rejected", () => {
  const result = buildDesktopArgs({ verb: "action", app: "firefox", name: "Reload", expectToken: "abc" })
  assert.ok("error" in result)
  assert.match(result.error, /only valid together with apply/)
})

test("set-text requires text and forwards the token when applying", () => {
  const invalid = buildDesktopArgs({ verb: "set-text", app: "firefox", name: "Search" })
  assert.ok("error" in invalid)
  assert.match(invalid.error, /requires text/)

  const applied = buildDesktopArgs({ verb: "set-text", app: "firefox", name: "Search", text: "hello", apply: true, expectToken: "tok" })
  assert.deepEqual(applied, {
    args: ["set-text", "--app", "firefox", "--name", "Search", "--text", "hello", "--expect-token", "tok", "--apply"],
  })
})

test("windows builds the read-only window list with optional filters", () => {
  assert.deepEqual(buildDesktopArgs({ verb: "windows" }), { args: ["windows"] })
  assert.deepEqual(
    buildDesktopArgs({ verb: "windows", app: "firefox", showing: true, maxDepth: 3, maxNodes: 100 }),
    { args: ["windows", "--app", "firefox", "--showing", "--max-depth", "3", "--max-nodes", "100"] },
  )
})

test("input key builds a preview command", () => {
  assert.deepEqual(
    buildDesktopArgs({ verb: "input", kind: "key", key: "ctrl+s" }),
    { args: ["input", "--kind", "key", "--key", "ctrl+s"] },
  )
})

test("input type builds a preview command and applies with the token", () => {
  assert.deepEqual(
    buildDesktopArgs({ verb: "input", kind: "type", text: "hello world" }),
    { args: ["input", "--kind", "type", "--text", "hello world"] },
  )
  assert.deepEqual(
    buildDesktopArgs({ verb: "input", kind: "type", text: "hello", apply: true, expectToken: "tok" }),
    { args: ["input", "--kind", "type", "--text", "hello", "--expect-token", "tok", "--apply"] },
  )
})

test("input requires a kind and the matching payload", () => {
  const missingKind = buildDesktopArgs({ verb: "input" })
  assert.ok("error" in missingKind)
  assert.match(missingKind.error, /requires kind/)

  const missingKey = buildDesktopArgs({ verb: "input", kind: "key" })
  assert.ok("error" in missingKey)
  assert.match(missingKey.error, /requires key/)

  const missingText = buildDesktopArgs({ verb: "input", kind: "type" })
  assert.ok("error" in missingText)
  assert.match(missingText.error, /requires non-empty text/)

  const keyWithText = buildDesktopArgs({ verb: "input", kind: "key", key: "ctrl+s", text: "nope" })
  assert.ok("error" in keyWithText)
  assert.match(keyWithText.error, /text is only valid with kind=type/)

  const typeWithKey = buildDesktopArgs({ verb: "input", kind: "type", text: "ok", key: "ctrl+s" })
  assert.ok("error" in typeWithKey)
  assert.match(typeWithKey.error, /key is only valid with kind=key/)
})

test("input apply requires the preview token", () => {
  const result = buildDesktopArgs({ verb: "input", kind: "key", key: "Return", apply: true })
  assert.ok("error" in result)
  assert.match(result.error, /requires expectToken/)

  const tokenOnly = buildDesktopArgs({ verb: "input", kind: "key", key: "Return", expectToken: "tok" })
  assert.ok("error" in tokenOnly)
  assert.match(tokenOnly.error, /only valid together with apply/)
})

test("describes a maxbuffer failure", () => {
  assert.match(describeDesktopFailure({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }), /exceeded/)
})

test("describes a timeout", () => {
  assert.match(describeDesktopFailure({ killed: true }), /timed out/)
})

test("describes an exit with stderr detail", () => {
  assert.match(describeDesktopFailure({ code: 2, stderr: "bad target\n" }), /exit 2.*bad target/s)
})
