import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  createPathGuard,
  DiskConflictError,
  MAX_READ_BYTES,
  normalizeSafeRelative,
  parseEditorCommand,
} from "../src/safety.ts"

async function temporaryProject(): Promise<{ root: string; outside: string }> {
  const root = await mkdtemp(join(tmpdir(), "file-manager-safety-"))
  const outside = await mkdtemp(join(tmpdir(), "file-manager-outside-"))
  return { root, outside }
}

test("canonicalizes a symlinked root and rejects lexical escapes", async () => {
  const { root, outside } = await temporaryProject()
  const link = `${root}-link`
  try {
    await writeFile(join(root, "safe.txt"), "safe\n")
    await symlink(root, link)
    const guard = await createPathGuard(link)

    assert.equal(guard.root, root)
    assert.equal((await guard.readText("safe.txt")).content, "safe\n")
    for (const value of ["", "../outside", "/etc/passwd", "src/../safe.txt", ".git/config", "src/.git/file", "C:\\secret"]) {
      await assert.rejects(() => guard.inspect(value))
    }
    await assert.rejects(() => guard.inspect(outside))
  } finally {
    await rm(link, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test("rejects symlink escapes and symlinks into .git", async () => {
  const { root, outside } = await temporaryProject()
  try {
    await mkdir(join(root, ".git"))
    await writeFile(join(outside, "secret.txt"), "secret")
    await symlink(join(outside, "secret.txt"), join(root, "outside.txt"))
    await symlink(join(root, ".git"), join(root, "git-link"))
    const guard = await createPathGuard(root)

    await assert.rejects(() => guard.readText("outside.txt"))
    await assert.rejects(() => guard.inspect("git-link"))
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test("rejects directories, binary bytes, invalid UTF-8, and oversized reads", async () => {
  const { root, outside } = await temporaryProject()
  try {
    await mkdir(join(root, "directory"))
    await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2]))
    await writeFile(join(root, "invalid.txt"), Buffer.from([0xc3, 0x28]))
    await writeFile(join(root, "large.txt"), Buffer.alloc(MAX_READ_BYTES + 1, 0x61))
    const guard = await createPathGuard(root)

    await assert.rejects(() => guard.readText("directory"))
    await assert.rejects(() => guard.readText("binary.bin"))
    await assert.rejects(() => guard.readText("invalid.txt"))
    await assert.rejects(() => guard.readText("large.txt"))
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test("writes atomically, preserves mode bits, and leaves no temporary file", async () => {
  const { root, outside } = await temporaryProject()
  try {
    const path = join(root, "safe.txt")
    await writeFile(path, "before\n")
    await chmod(path, 0o640)
    const guard = await createPathGuard(root)
    const opened = await guard.readText("safe.txt")
    const written = await guard.writeText({
      path: "safe.txt",
      content: "after\n",
      diskFingerprint: opened.fingerprint,
      mode: opened.mode,
      revision: 0,
    })

    assert.equal(await readFile(path, "utf8"), "after\n")
    assert.equal((await stat(path)).mode & 0o7777, 0o640)
    assert.equal(written.content, "after\n")
    const entries = await (await import("node:fs/promises")).readdir(root)
    assert.deepEqual(entries.filter((entry) => entry.includes(".safe.txt.") && entry.endsWith(".tmp")), [])
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test("refuses to overwrite an externally changed disk file", async () => {
  const { root, outside } = await temporaryProject()
  try {
    const path = join(root, "safe.txt")
    await writeFile(path, "before\n")
    const guard = await createPathGuard(root)
    const opened = await guard.readText("safe.txt")
    await writeFile(path, "external\n")

    await assert.rejects(
      () =>
        guard.writeText({
          path: "safe.txt",
          content: "mine\n",
          diskFingerprint: opened.fingerprint,
          mode: opened.mode,
          revision: 0,
        }),
      (error: unknown) => error instanceof DiskConflictError,
    )
    assert.equal(await readFile(path, "utf8"), "external\n")
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test("parses bounded editor commands without shell interpolation", () => {
  assert.deepEqual(parseEditorCommand("nvim --wait"), { command: "nvim", args: ["--wait"] })
  assert.deepEqual(parseEditorCommand('code "--reuse-window"'), { command: "code", args: ["--reuse-window"] })
  assert.equal(parseEditorCommand("vim; rm -rf /"), undefined)
  assert.equal(parseEditorCommand('vim "unterminated'), undefined)
})

test("normalizes only safe relative paths", () => {
  assert.equal(normalizeSafeRelative("src/file.ts"), "src/file.ts")
  assert.throws(() => normalizeSafeRelative("./src/file.ts"))
  assert.throws(() => normalizeSafeRelative("src\\..\\file.ts"))
})
