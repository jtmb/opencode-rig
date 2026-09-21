import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createBinaryReplaceManager, inspectBinary } from "../src/binary-files.ts"

test("inspects, finds, and extracts bounded binary data", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-binary-inspect-"))
  const path = join(root, "value.bin")
  try {
    await writeFile(path, Buffer.from("zero\0one one", "utf8"))
    const state = await inspectBinary({ action: "stat", path })
    assert.equal(state.size, 12)
    assert.equal(state.sha256.length, 64)
    const found = await inspectBinary({ action: "find", path, needle: "one", contextBytes: 2 })
    assert.deepEqual(found.matches.map((match) => match.offset), [5, 9])
    assert.equal(found.matches[0]?.before, "o\0")
    const extracted = await inspectBinary({ action: "extract", path, offset: 5, length: 3, encoding: "base64" })
    assert.equal(Buffer.from(extracted.data, "base64").toString("utf8"), "one")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects non-canonical base64 encodings", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-binary-base64-"))
  const path = join(root, "value.bin")
  try {
    await writeFile(path, "f")
    await assert.rejects(inspectBinary({ action: "find", path, needle: "Zh==", encoding: "base64" }), /canonical base64/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("previews and atomically applies an equal-length replacement with a backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-binary-replace-"))
  const path = join(root, "value.bin")
  try {
    await writeFile(path, "hello world")
    const manager = createBinaryReplaceManager()
    const preview = await manager.invoke({ path, search: "world", replacement: "there" }, "ses", "build")
    assert.equal(preview.dryRun, true)
    assert.equal(preview.offset, 6)
    const applied = await manager.invoke({
      path,
      search: "world",
      replacement: "there",
      apply: true,
      expectToken: preview.expectToken,
    }, "ses", "build")
    assert.equal(applied.dryRun, false)
    assert.equal(await readFile(path, "utf8"), "hello there")
    assert.equal(await readFile(applied.backupPath, "utf8"), "hello world")
    await assert.rejects(manager.invoke({
      path,
      search: "world",
      replacement: "there",
      apply: true,
      expectToken: preview.expectToken,
    }, "ses", "build"), /missing or expired/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("binds replacements to file state, caller, and a unique occurrence by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-binary-state-"))
  const path = join(root, "value.bin")
  try {
    await writeFile(path, "same same")
    const manager = createBinaryReplaceManager()
    await assert.rejects(manager.invoke({ path, search: "same", replacement: "else" }, "ses", "build"), /exactly once/)
    const preview = await manager.invoke({ path, search: "same", replacement: "else", occurrence: 2 }, "ses", "build")
    await writeFile(path, "same changed")
    await assert.rejects(manager.invoke({
      path,
      search: "same",
      replacement: "else",
      occurrence: 2,
      apply: true,
      expectToken: preview.expectToken,
    }, "ses", "build"), /changed after preview/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
