import assert from "node:assert/strict"
import test from "node:test"

import {
  MAX_ATTACHMENT_BYTES,
  isAttachmentSize,
  isScreenshotName,
  keySequence,
  newScreenshots,
  pngDataUri,
  pngDimensions,
} from "../vision.ts"

function pngHeader(width: number, height: number): Buffer {
  const header = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0)
  header.writeUInt32BE(13, 8)
  header.write("IHDR", 12, "ascii")
  header.writeUInt32BE(width, 16)
  header.writeUInt32BE(height, 20)
  return header
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
  const uri = pngDataUri(Buffer.from([1, 2, 3]))
  assert.equal(uri, "data:image/png;base64,AQID")
})

test("reads png dimensions from the IHDR header", () => {
  assert.deepEqual(pngDimensions(pngHeader(1920, 1080)), { width: 1920, height: 1080 })
  assert.deepEqual(pngDimensions(pngHeader(800, 600)), { width: 800, height: 600 })
})

test("rejects non-png or truncated headers", () => {
  assert.equal(pngDimensions(Buffer.from("not a png at all, but long enough")), undefined)
  assert.equal(pngDimensions(Buffer.alloc(10)), undefined)
  const wrongChunk = pngHeader(10, 10)
  wrongChunk.write("IDAT", 12, "ascii")
  assert.equal(pngDimensions(wrongChunk), undefined)
})
