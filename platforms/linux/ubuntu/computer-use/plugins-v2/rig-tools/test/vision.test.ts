import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  MAX_ATTACHMENT_BYTES,
  WSL_CAPTURE_OUTPUT_BYTES,
  decodeWindowsScreenshot,
  isAttachmentSize,
  isScreenshotName,
  isWslKernel,
  keySequence,
  newScreenshots,
  pngDataUri,
  pngDimensions,
  retainScreenshot,
} from "../src/vision.ts"

function pngHeader(width: number, height: number): Buffer {
  const header = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0)
  header.writeUInt32BE(13, 8)
  header.write("IHDR", 12, "ascii")
  header.writeUInt32BE(width, 16)
  header.writeUInt32BE(height, 20)
  return header
}

async function withTemporaryDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rig-tools-vision-"))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test("uses the documented ydotool key sequences", () => {
  assert.deepEqual(keySequence("screen"), ["42:1", "99:1", "99:0", "42:0"])
  assert.deepEqual(keySequence("window"), ["56:1", "99:1", "99:0", "56:0"])
  assert.notEqual(keySequence("screen"), keySequence("window"))
})

test("recognizes screenshot file names", () => {
  assert.equal(isScreenshotName("Screenshot From 2026-09-17 17-05-36.png"), true)
  assert.equal(isScreenshotName("shot.PNG"), true)
  assert.equal(isScreenshotName("notes.txt"), false)
})

test("selects only the newly created screenshots", () => {
  const before = ["a.png", "b.png"]
  const after = ["c.png", "a.png", "b.png", "d.png"]
  assert.deepEqual(newScreenshots(before, after), ["c.png", "d.png"])
  assert.deepEqual(newScreenshots(before, before), [])
})

test("guards the attachment size", () => {
  assert.equal(isAttachmentSize(0), false)
  assert.equal(isAttachmentSize(1), true)
  assert.equal(isAttachmentSize(MAX_ATTACHMENT_BYTES), true)
  assert.equal(isAttachmentSize(MAX_ATTACHMENT_BYTES + 1), false)
})

test("builds a png data URI", () => {
  assert.equal(pngDataUri(Buffer.from([1, 2, 3])), "data:image/png;base64,AQID")
})

test("reads png dimensions from a valid header", () => {
  assert.deepEqual(pngDimensions(pngHeader(1280, 720)), { width: 1280, height: 720 })
})

test("rejects a non-png header", () => {
  assert.equal(pngDimensions(Buffer.from("not a png at all........")), undefined)
  assert.equal(pngDimensions(Buffer.alloc(8)), undefined)
})

test("detects only WSL kernel releases for the Windows capture fallback", () => {
  assert.equal(isWslKernel("6.6.87.2-microsoft-standard-WSL2"), true)
  assert.equal(isWslKernel("5.15.153.1-Microsoft-standard-WSL2"), true)
  assert.equal(isWslKernel("6.8.0-64-generic"), false)
})

test("validates bounded canonical Windows screenshot results", () => {
  const bytes = pngHeader(1920, 1080)
  const captured = decodeWindowsScreenshot("window", {
    mimeType: "image/png",
    data: bytes.toString("base64"),
    bytes: bytes.length,
    width: 1920,
    height: 1080,
  })
  assert.equal(captured.mode, "window")
  assert.deepEqual(captured.dimensions, { width: 1920, height: 1080 })
  assert.equal(captured.bytes.equals(bytes), true)
  assert.ok(WSL_CAPTURE_OUTPUT_BYTES > MAX_ATTACHMENT_BYTES)
  assert.throws(() => decodeWindowsScreenshot("screen", { mimeType: "image/png", data: "%%%%", bytes: 3, width: 1, height: 1 }), /base64/u)
  assert.throws(() => decodeWindowsScreenshot("screen", { mimeType: "image/png", data: bytes.toString("base64"), bytes: bytes.length, width: 1, height: 1 }), /dimensions/u)
})

test("retains an opted-in PNG atomically with bounded metadata and mode", async () => {
  await withTemporaryDirectory(async (directory) => {
    const cwd = path.join(directory, "cwd")
    await mkdir(cwd)
    const bytes = pngHeader(320, 240)
    const saved = await retainScreenshot(bytes, "evidence/screenshot.png", cwd)
    const absolutePath = path.join(cwd, "absolute.png")
    const savedAbsolute = await retainScreenshot(bytes, absolutePath, cwd)

    assert.deepEqual(saved, {
      path: path.join(cwd, "evidence", "screenshot.png"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      dimensions: { width: 320, height: 240 },
    })
    assert.equal(savedAbsolute?.path, absolutePath)
    assert.deepEqual(await readFile(saved!.path), bytes)
    assert.deepEqual(await readFile(absolutePath), bytes)
    assert.equal((await stat(saved!.path)).mode & 0o777, 0o644)
    assert.deepEqual(await readdir(path.dirname(saved!.path)), ["screenshot.png"])
  })
})

test("refuses traversal, absolute escapes, wrong suffixes, and oversized retention without files", async () => {
  await withTemporaryDirectory(async (directory) => {
    const cwd = path.join(directory, "cwd")
    await mkdir(cwd)
    const bytes = pngHeader(320, 240)
    const oversized = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)

    assert.equal(await retainScreenshot(bytes, "nested/../traversal.png", cwd), undefined)
    assert.equal(await retainScreenshot(bytes, path.join(directory, "absolute-escape.png"), cwd), undefined)
    assert.equal(await retainScreenshot(bytes, "nested/wrong.jpg", cwd), undefined)
    assert.equal(await retainScreenshot(oversized, "oversized.png", cwd), undefined)

    await assert.rejects(lstat(path.join(directory, "traversal.png")), { code: "ENOENT" })
    await assert.rejects(lstat(path.join(directory, "absolute-escape.png")), { code: "ENOENT" })
    await assert.rejects(lstat(path.join(cwd, "nested")), { code: "ENOENT" })
    await assert.rejects(lstat(path.join(cwd, "oversized.png")), { code: "ENOENT" })
  })
})

test("refuses symlinked path components without writing through them", async () => {
  await withTemporaryDirectory(async (directory) => {
    const cwd = path.join(directory, "cwd")
    await mkdir(cwd)
    await symlink(directory, path.join(cwd, "linked"), "dir")
    await symlink(path.join(directory, "target.png"), path.join(cwd, "linked-file.png"))

    assert.equal(await retainScreenshot(pngHeader(320, 240), "linked/screenshot.png", cwd), undefined)
    assert.equal(await retainScreenshot(pngHeader(320, 240), "linked-file.png", cwd), undefined)
    await assert.rejects(lstat(path.join(directory, "screenshot.png")), { code: "ENOENT" })
    await assert.rejects(lstat(path.join(directory, "target.png")), { code: "ENOENT" })
  })
})
