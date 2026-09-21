import assert from "node:assert/strict"
import test from "node:test"

import {
  buildPythonSandboxArgs,
  createPythonSandbox,
  normalizePythonSandboxInput,
  pythonSandboxRunnerEnvironment,
  type PythonSandboxRunner,
} from "../src/python-sandbox.ts"

test("normalizes bounded Python code, stdin, arguments, and timeout", () => {
  assert.deepEqual(normalizePythonSandboxInput({ code: "print('ok')", args: ["one"], stdin: "value", timeoutMs: 500 }), {
    code: "print('ok')",
    args: ["one"],
    stdin: "value",
    timeoutMs: 500,
  })
  assert.throws(() => normalizePythonSandboxInput({ code: "" }), /non-empty/)
  assert.throws(() => normalizePythonSandboxInput({ code: "pass", timeoutMs: 31_000 }), /timeoutMs/)
  assert.throws(() => normalizePythonSandboxInput({ code: "pass", args: Array(33).fill("x") }), /at most 32/)
})

test("builds a network-isolated read-only project sandbox", () => {
  const input = normalizePythonSandboxInput({ code: "print('ok')", args: ["arg"] })
  const args = buildPythonSandboxArgs("/repo", input)
  assert.ok(args.includes("--unshare-all"))
  assert.equal(args.includes("--share-net"), false)
  assert.deepEqual(args.slice(args.indexOf("--ro-bind", args.lastIndexOf("--ro-bind") - 1), args.indexOf("--ro-bind", args.lastIndexOf("--ro-bind") - 1) + 3), ["--ro-bind", "/repo", "/workspace"])
  assert.ok(args.includes("--clearenv"))
  assert.deepEqual(args.slice(args.indexOf("--size"), args.indexOf("--size") + 4), ["--size", `${16 * 1024 * 1024}`, "--tmpfs", "/tmp"])
  assert.ok(args.includes("-I"))
  assert.ok(args.includes("-S"))
  assert.ok(args.includes("-B"))
})

test("passes only the systemd user-bus environment to the aggregate limiter", () => {
  const environment = pythonSandboxRunnerEnvironment({
    HOME: "/home/test",
    XDG_RUNTIME_DIR: "/run/user/1000",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    SECRET_TOKEN: "must-not-pass",
  })
  assert.equal(environment.HOME, "/home/test")
  assert.equal(environment.XDG_RUNTIME_DIR, "/run/user/1000")
  assert.equal("SECRET_TOKEN" in environment, false)
})

test("runs through the fixed sandbox executable and returns bounded metadata", async () => {
  let call: { file: string; args: string[]; stdin: string; timeoutMs: number } | undefined
  const runner: PythonSandboxRunner = async (file, args, options) => {
    call = { file, args, ...options }
    return { exitCode: 0, signal: null, stdout: "ok\n", stderr: "", stdoutBytes: 3, stderrBytes: 0 }
  }
  const run = createPythonSandbox(process.cwd(), runner)
  const result = await run({ code: "print('ok')", stdin: "input" })
  assert.match(call?.file ?? "", /run-bounded-command\.sh$/)
  assert.ok(call?.args.includes("--require-cgroup"))
  assert.ok(call?.args.includes("/usr/bin/bwrap"))
  assert.equal(call?.stdin, "input")
  assert.equal(call?.timeoutMs, 12_000)
  assert.equal(result.stdout, "ok\n")
  assert.equal(result.sandbox.project, "read-only")
  assert.equal(result.sandbox.network, "disabled")
  assert.equal(result.sandbox.resources, "aggregate-cgroup")
  assert.equal(result.codeSha256.length, 64)
})
