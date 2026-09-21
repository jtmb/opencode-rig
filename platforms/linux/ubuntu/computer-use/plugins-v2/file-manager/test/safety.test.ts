import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  createPathGuard,
  DiskConflictError,
  MAX_DIRECTORY_DEPTH,
  MAX_DIRECTORY_ENTRIES,
  MAX_DIRECTORY_NAME_BYTES,
  MAX_DIRECTORY_PATH_BYTES,
  MAX_DIRECTORY_TEXT_BYTES,
  MAX_READ_BYTES,
  normalizeSafeRelative,
  parseEditorCommand,
  PathSafetyError,
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
    for (const value of ["", "../outside", "/tmp/absolute-file.txt", "src/../safe.txt", ".git/config", "src/.git/file", "C:\\secret"]) {
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

test("lists local directories with directories first and excludes .git", async () => {
  const { root, outside } = await temporaryProject()
  try {
    await mkdir(join(root, ".git"))
    await mkdir(join(root, "z-dir"))
    await mkdir(join(root, "a-dir"))
    await writeFile(join(root, "z.txt"), "z")
    await writeFile(join(root, "a.txt"), "a")
    await writeFile(join(root, "a-dir", "nested.txt"), "nested")
    const guard = await createPathGuard(root)

    const entries = await guard.listDirectory("")
    assert.deepEqual(entries.map((entry) => [entry.relative, entry.type]), [
      ["a-dir", "directory"],
      ["z-dir", "directory"],
      ["a.txt", "file"],
      ["z.txt", "file"],
    ])
    assert.equal(entries.some((entry) => entry.name === ".git"), false)
    assert.deepEqual((await guard.listDirectory("a-dir")).map((entry) => entry.relative), ["a-dir/nested.txt"])
    assert.ok(entries.every((entry) => !("absolute" in entry) && !("canonical" in entry)))
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test("directory listing omits inside and outside symlink entries without reading outside data", async () => {
  const { root, outside } = await temporaryProject()
  try {
    const outsideFile = join(outside, "secret.txt")
    const oldTime = new Date(1_000_000_000)
    await writeFile(outsideFile, "secret")
    await utimes(outsideFile, oldTime, oldTime)
    const outsideBefore = await stat(outsideFile)
    await mkdir(join(root, "outside-link"))
    await symlink(outsideFile, join(root, "outside-link", "secret-link"))

    await mkdir(join(root, "inside-link"))
    await writeFile(join(root, "inside.txt"), "inside")
    await symlink(join(root, "inside.txt"), join(root, "inside-link", "inside-link.txt"))
    await mkdir(join(root, "inside-directory"))
    await symlink(join(root, "inside-directory"), join(root, "inside-directory-link"))
    await symlink(outside, join(root, "outside-directory-link"))
    await mkdir(join(root, "nested-link"))
    await symlink(outside, join(root, "nested-link", "directory-link"))
    const guard = await createPathGuard(root)

    assert.deepEqual(await guard.listDirectory("outside-link"), [])
    assert.deepEqual(await guard.listDirectory("inside-link"), [])
    await assert.rejects(() => guard.listDirectory("inside-directory-link"), PathSafetyError)
    await assert.rejects(() => guard.listDirectory("outside-directory-link"), PathSafetyError)
    await assert.rejects(() => guard.listDirectory("nested-link/directory-link"), PathSafetyError)
    const rootEntries = await guard.listDirectory("")
    assert.equal(rootEntries.some((entry) => entry.name.endsWith("-directory-link")), false)
    const outsideAfter = await stat(outsideFile)
    assert.equal(outsideAfter.atimeMs, outsideBefore.atimeMs)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test("directory listing refuses special files", async () => {
  const { root, outside } = await temporaryProject()
  const socketPath = join(root, "local.sock")
  const server = createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(socketPath, resolve)
    })
    const guard = await createPathGuard(root)
    await assert.rejects(() => guard.listDirectory(""), /special directory entry is not allowed/)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test("directory listing enforces entry, name, aggregate text, path, and depth bounds", async () => {
  const { root, outside } = await temporaryProject()
  try {
    const guard = await createPathGuard(root)

    const tooMany = join(root, "too-many")
    await mkdir(tooMany)
    await Promise.all(Array.from({ length: MAX_DIRECTORY_ENTRIES + 1 }, (_, index) => writeFile(join(tooMany, `f-${index}`), "")))
    await assert.rejects(() => guard.listDirectory("too-many"), PathSafetyError)

    const longNameDirectory = join(root, "long-name")
    await mkdir(longNameDirectory)
    await writeFile(join(longNameDirectory, "n".repeat(MAX_DIRECTORY_NAME_BYTES + 1)), "")
    await assert.rejects(() => guard.listDirectory("long-name"), PathSafetyError)

    const tooMuchText = join(root, "too-much-text")
    await mkdir(tooMuchText)
    const textNameBytes = 225
    const textEntries = Math.floor(MAX_DIRECTORY_TEXT_BYTES / textNameBytes) + 2
    await Promise.all(Array.from({ length: textEntries }, (_, index) => {
      const name = `${String(index).padStart(4, "0")}-${"x".repeat(textNameBytes - 5)}`
      return writeFile(join(tooMuchText, name), "")
    }))
    await assert.rejects(() => guard.listDirectory("too-much-text"), PathSafetyError)

    await assert.rejects(() => guard.listDirectory("p".repeat(MAX_DIRECTORY_PATH_BYTES + 1)), PathSafetyError)

    const depthParts = Array.from({ length: MAX_DIRECTORY_DEPTH + 1 }, () => "d")
    await mkdir(join(root, ...depthParts), { recursive: true })
    await assert.rejects(() => guard.listDirectory(depthParts.join("/")), PathSafetyError)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test("directory listing fails closed when an entry disappears during enumeration", async () => {
  const { root, outside } = await temporaryProject()
  let running = true
  let iterations = 0
  let churn: Promise<void> | undefined
  try {
    const raceDirectory = join(root, "race-disappear")
    await mkdir(raceDirectory)
    const target = join(raceDirectory, "changing.txt")
    await writeFile(target, "present")
    await Promise.all(Array.from({ length: 200 }, (_, index) => writeFile(join(raceDirectory, `f-${String(index).padStart(3, "0")}`), "x")))
    const guard = await createPathGuard(root)
    churn = (async () => {
      while (running) {
        await rm(target, { force: true })
        await writeFile(target, "present")
        iterations += 1
      }
    })()
    while (iterations < 2) await new Promise<void>((resolve) => setImmediate(resolve))
    await assert.rejects(() => guard.listDirectory("race-disappear"), PathSafetyError)
  } finally {
    running = false
    await churn
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test("directory listing fails closed when stable metadata changes during enumeration", async () => {
  const { root, outside } = await temporaryProject()
  let running = true
  let iterations = 0
  let churn: Promise<void> | undefined
  try {
    const raceDirectory = join(root, "race-change")
    await mkdir(raceDirectory)
    const target = join(raceDirectory, "changing.txt")
    await writeFile(target, "a")
    await Promise.all(Array.from({ length: 300 }, (_, index) => writeFile(join(raceDirectory, `f-${String(index).padStart(3, "0")}`), "x")))
    const guard = await createPathGuard(root)
    churn = (async () => {
      while (running) {
        await writeFile(target, iterations % 2 === 0 ? "longer-content" : "b")
        iterations += 1
      }
    })()
    while (iterations < 2) await new Promise<void>((resolve) => setImmediate(resolve))
    await assert.rejects(() => guard.listDirectory("race-change"), PathSafetyError)
  } finally {
    running = false
    await churn
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
