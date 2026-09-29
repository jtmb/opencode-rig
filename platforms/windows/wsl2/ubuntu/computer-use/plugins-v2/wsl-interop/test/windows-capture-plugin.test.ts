import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { lstat, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import plugin from "../src/index.ts"
import { loadCompatibilityPolicy } from "../src/compatibility.ts"
import { WindowsUiManager, type WindowsCapture } from "../src/windows-ui.ts"
import type { WindowsCaptureInput } from "../src/types.ts"

const captureBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p8sAAAAASUVORK5CYII=",
  "base64",
)

type RegisteredTool = {
  name: string
  execute(input: unknown, context: unknown): Promise<unknown>
}

function retentionPath(result: unknown): { path: string } | undefined {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? []
  const text = content.find((item) => item.type === "text")?.text ?? ""
  const match = /Retained PNG: (\{.*?\})\./u.exec(text)
  return match ? JSON.parse(match[1]!) as { path: string } : undefined
}

async function exists(filePath: string): Promise<boolean> {
  return await lstat(filePath).then(() => true, () => false)
}

test("registered windows_capture retains under ctx.location.directory and rejects traversal/symlink paths", async () => {
  const runID = randomUUID()
  const serviceDirectory = process.cwd()
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), "wsl-capture-project-"))
  const outsideDirectory = await mkdtemp(path.join(os.tmpdir(), "wsl-capture-outside-"))
  const capture = {
    windowId: "c".repeat(64),
    processId: 1234,
    windowHandle: "0x1234",
    title: "OpenRig capture fixture",
    className: "FixtureWindow",
    bounds: { x: 0, y: 0, width: 1, height: 1 },
    mimeType: "image/png" as const,
    data: captureBytes.toString("base64"),
    bytes: captureBytes.length,
    width: 1,
    height: 1,
    untrusted: true as const,
  } satisfies WindowsCapture & { untrusted: true }
  const originalCapture = WindowsUiManager.prototype.capture
  WindowsUiManager.prototype.capture = async (_input: WindowsCaptureInput) => capture

  const relativeDirectory = `.windows-capture-${runID}`
  const successfulSavePath = path.join(relativeDirectory, "capture.png")
  const projectTarget = path.resolve(projectDirectory, successfulSavePath)
  const serviceTarget = path.resolve(serviceDirectory, successfulSavePath)
  const traversalSavePath = `../windows-capture-escape-${runID}.png`
  const traversalTargets = [path.resolve(projectDirectory, traversalSavePath), path.resolve(serviceDirectory, traversalSavePath)]
  const symlinkName = `windows-capture-link-${runID}`
  const symlinkSavePath = path.join(symlinkName, "capture.png")
  const symlinkServiceTarget = path.resolve(serviceDirectory, symlinkSavePath)

  try {
    assert.notEqual(projectDirectory, serviceDirectory, "the fixture project must differ from the plugin service CWD")
    const tools = new Map<string, RegisteredTool>()
    const context = {
      options: {
        enabled: true,
        refreshMs: 5_000,
        powershell: { preferred: "auto", timeoutMs: 10_000, maxOutputBytes: 262_144 },
        raw: { enabled: true, tokenTtlMs: 60_000, maxScriptBytes: 65_536, maxTokens: 128 },
      },
      app: { version: (await loadCompatibilityPolicy()).maximumTestedOpenCode },
      location: { directory: projectDirectory },
      rpc: { register: async () => ({}) },
      tool: {
        transform: async (register: (editor: { add(tool: RegisteredTool): void }) => void) => {
          register({ add: (tool) => tools.set(tool.name, tool) })
        },
      },
    }
    const server = plugin as unknown as { setup(context: unknown): Promise<unknown> }
    await server.setup(context)
    const tool = tools.get("windows_capture")
    assert.ok(tool, "the real plugin setup must register windows_capture")

    const savedResult = await tool.execute({
      processId: capture.processId,
      windowHandle: capture.windowHandle,
      title: capture.title,
      className: capture.className,
      savePath: successfulSavePath,
    }, {})
    const savedPath = retentionPath(savedResult)?.path
    const projectFileExists = await exists(projectTarget)
    const serviceFileExists = await exists(serviceTarget)
    if (projectFileExists) assert.deepEqual(await readFile(projectTarget), captureBytes)

    const traversalResult = await tool.execute({
      processId: capture.processId,
      windowHandle: capture.windowHandle,
      title: capture.title,
      savePath: traversalSavePath,
    }, {})
    const traversalContent = (traversalResult as { content: Array<{ type: string; text?: string }> }).content
    const traversalRefused = traversalContent.some((item) => item.type === "text" && /Retention failed/u.test(item.text ?? ""))
      && !(await Promise.all(traversalTargets.map(exists))).some(Boolean)

    await symlink(outsideDirectory, path.join(projectDirectory, symlinkName), "dir")
    const symlinkResult = await tool.execute({
      processId: capture.processId,
      windowHandle: capture.windowHandle,
      title: capture.title,
      savePath: symlinkSavePath,
    }, {})
    const symlinkContent = (symlinkResult as { content: Array<{ type: string; text?: string }> }).content
    const symlinkRefused = symlinkContent.some((item) => item.type === "text" && /Retention failed/u.test(item.text ?? ""))
      && (await readdir(outsideDirectory)).length === 0
      && !(await exists(symlinkServiceTarget))

    assert.deepEqual({
      retainedInProject: savedPath === projectTarget && projectFileExists && !serviceFileExists,
      traversalRefused,
      symlinkRefused,
    }, {
      retainedInProject: true,
      traversalRefused: true,
      symlinkRefused: true,
    }, "windows_capture must save only below the invoking project and reject unsafe destinations")
  } finally {
    WindowsUiManager.prototype.capture = originalCapture
    await Promise.all([
      rm(path.join(projectDirectory, relativeDirectory), { recursive: true, force: true }),
      rm(path.join(serviceDirectory, relativeDirectory), { recursive: true, force: true }),
      rm(path.join(projectDirectory, symlinkName), { recursive: true, force: true }),
      rm(path.join(serviceDirectory, symlinkName), { recursive: true, force: true }),
      ...traversalTargets.map((target) => rm(target, { force: true })),
      rm(projectDirectory, { recursive: true, force: true }),
      rm(outsideDirectory, { recursive: true, force: true }),
    ])
  }
})

test("registered windows_restore forwards the exact selection to the restore manager", async () => {
  const calls: Array<{ input: unknown; caller: { sessionID: string; agent: string; fingerprint: string } }> = []
  const originalRestore = WindowsUiManager.prototype.restore
  WindowsUiManager.prototype.restore = async (input, caller) => {
    calls.push({ input, caller })
    return { action: "preview", expectToken: "token_1234567890abcdef", target: { windowId: "d".repeat(64) } }
  }
  try {
    const tools = new Map<string, RegisteredTool>()
    const context = {
      options: {
        enabled: true,
        refreshMs: 5_000,
        powershell: { preferred: "auto", timeoutMs: 10_000, maxOutputBytes: 262_144 },
        raw: { enabled: true, tokenTtlMs: 60_000, maxScriptBytes: 65_536, maxTokens: 128 },
      },
      app: { version: (await loadCompatibilityPolicy()).maximumTestedOpenCode },
      location: { directory: process.cwd() },
      rpc: { register: async () => ({}) },
      tool: {
        transform: async (register: (editor: { add(tool: RegisteredTool): void }) => void) => {
          register({ add: (tool) => tools.set(tool.name, tool) })
        },
      },
    }
    const server = plugin as unknown as { setup(context: unknown): Promise<unknown> }
    await server.setup(context)
    const tool = tools.get("windows_restore")
    assert.ok(tool, "the real plugin setup must register windows_restore")

    const result = await tool.execute({
      processId: 19_756,
      windowHandle: "0x15028C",
      title: "OC | open-rig",
      apply: true,
      expectToken: "token_1234567890abcdef",
    }, { sessionID: "ses_restore", agent: "build" })

    assert.equal(calls.length, 1, "windows_restore must forward exactly one manager call")
    assert.deepEqual(calls[0]?.input, {
      processId: 19_756,
      windowHandle: "0x15028C",
      title: "OC | open-rig",
      apply: true,
      expectToken: "token_1234567890abcdef",
    })
    assert.equal(calls[0]?.caller.sessionID, "ses_restore")
    assert.equal(calls[0]?.caller.agent, "build")
    assert.match(calls[0]?.caller.fingerprint ?? "", /^[a-f0-9]{64}$/u)
    assert.match(String((result as { content: string }).content), /"action": "preview"/u)
  } finally {
    WindowsUiManager.prototype.restore = originalRestore
  }
})
