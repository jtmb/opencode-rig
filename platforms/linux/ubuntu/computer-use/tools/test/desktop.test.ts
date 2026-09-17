import assert from "node:assert/strict"
import test from "node:test"

import { buildDesktopArgs, describeDesktopFailure } from "../desktop.ts"

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

test("set-text requires text", () => {
  const result = buildDesktopArgs({ verb: "set-text", app: "firefox", name: "Address" })
  assert.ok("error" in result)
  assert.match(result.error, /requires text/)
})

test("apply emits the token pair for the exact previewed target", () => {
  const result = buildDesktopArgs({
    verb: "set-text",
    app: "firefox",
    name: "Address",
    text: "about:blank",
    apply: true,
    expectToken: "123:abc",
  })
  assert.deepEqual(result, {
    args: ["set-text", "--app", "firefox", "--name", "Address", "--text", "about:blank", "--expect-token", "123:abc", "--apply"],
  })
})

test("apply without a preview token is refused", () => {
  const result = buildDesktopArgs({ verb: "action", app: "firefox", name: "Reload", apply: true })
  assert.ok("error" in result)
  assert.match(result.error, /expectToken/)
})

test("a preview token without apply is refused", () => {
  const result = buildDesktopArgs({ verb: "action", app: "firefox", name: "Reload", expectToken: "123:abc" })
  assert.ok("error" in result)
  assert.match(result.error, /apply=true/)
})

test("verb-specific fields are rejected on the wrong verb", () => {
  const textOnAction = buildDesktopArgs({ verb: "action", app: "firefox", name: "Reload", text: "x" })
  assert.ok("error" in textOnAction)
  const actionOnFocus = buildDesktopArgs({ verb: "focus", app: "firefox", name: "Reload", action: "click" })
  assert.ok("error" in actionOnFocus)
  const waitOnAction = buildDesktopArgs({ verb: "action", app: "firefox", name: "Reload", waitSeconds: 5 })
  assert.ok("error" in waitOnAction)
})

test("failure formatting surfaces the exit code and stderr", () => {
  assert.match(
    describeDesktopFailure({ code: 1, stderr: "no match", stdout: "", message: "boom" }),
    /exit 1.*no match/s,
  )
})

test("failure formatting detects the output cap and timeouts", () => {
  assert.match(describeDesktopFailure({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }), /exceeded/)
  assert.match(describeDesktopFailure({ killed: true, code: null, message: "killed" }), /timed out/)
})
