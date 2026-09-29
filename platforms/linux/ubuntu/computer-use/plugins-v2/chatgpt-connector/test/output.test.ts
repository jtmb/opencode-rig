import assert from "node:assert/strict"
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { deflateSync } from "node:zlib"

import { saveGeneratedImage } from "../src/output.ts"

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function crc32(value: Buffer): number {
  let crc = 0xffffffff
  for (const byte of value) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const value = Buffer.alloc(data.length + 12)
  value.writeUInt32BE(data.length, 0)
  value.write(type, 4, 4, "ascii")
  data.copy(value, 8)
  value.writeUInt32BE(crc32(value.subarray(4, 8 + data.length)), 8 + data.length)
  return value
}

function ihdrChunk(width = 1, height = 1, bitDepth = 8, colorType = 6): Buffer {
  const data = Buffer.alloc(13)
  data.writeUInt32BE(width, 0)
  data.writeUInt32BE(height, 4)
  data[8] = bitDepth
  data[9] = colorType
  return chunk("IHDR", data)
}

function idatChunk(): Buffer {
  return chunk("IDAT", deflateSync(Buffer.from([0, 0xff, 0x00, 0x00, 0xff])))
}

function iendChunk(): Buffer {
  return chunk("IEND", Buffer.alloc(0))
}

function png(): Buffer {
  return Buffer.concat([PNG_SIGNATURE, ihdrChunk(), idatChunk(), iendChunk()])
}

function refreshChunkCrc(image: Buffer, offset: number): void {
  const length = image.readUInt32BE(offset)
  const crcOffset = offset + 8 + length
  image.writeUInt32BE(crc32(image.subarray(offset + 4, crcOffset)), crcOffset)
}

async function projectFixture(): Promise<string> {
  return mkdtemp(join(tmpdir(), "chatgpt-connector-output-"))
}

function input(projectDirectory: string, bytes = png(), label?: string) {
  return {
    projectDirectory,
    imageBase64: bytes.toString("base64"),
    ...(label === undefined ? {} : { label }),
  }
}

test("saves a validated PNG under assets/generated with a unique name and private mode", async () => {
  const projectDirectory = await projectFixture()
  try {
    const saved = await saveGeneratedImage(input(projectDirectory, png(), "concept_art"))
    assert.match(saved.relativePath, /^assets\/generated\/concept_art-[a-f0-9]{32}\.png$/)
    assert.equal(saved.absolutePath, join(projectDirectory, saved.relativePath))
    assert.equal(saved.bytes, png().length)
    assert.equal(saved.mimeType, "image/png")
    assert.deepEqual(await readFile(saved.absolutePath), png())
    const info = await lstat(saved.absolutePath)
    assert.ok(info.isFile())
    assert.equal(info.isSymbolicLink(), false)
    assert.equal(info.mode & 0o777, 0o600)
  } finally {
    await rm(projectDirectory, { recursive: true, force: true })
  }
})

test("allocates distinct output files for concurrent saves", async () => {
  const projectDirectory = await projectFixture()
  try {
    const saved = await Promise.all([
      saveGeneratedImage(input(projectDirectory)),
      saveGeneratedImage(input(projectDirectory)),
      saveGeneratedImage(input(projectDirectory)),
    ])
    assert.equal(new Set(saved.map((entry) => entry.absolutePath)).size, saved.length)
    assert.deepEqual((await readdir(join(projectDirectory, "assets", "generated"))).toSorted(), saved.map((entry) => entry.relativePath.split("/").at(-1)!).toSorted())
  } finally {
    await rm(projectDirectory, { recursive: true, force: true })
  }
})

test("removes a partially written file when its write fails", async () => {
  const projectDirectory = await projectFixture()
  const probe = await open(projectDirectory, "r")
  const prototype = Object.getPrototypeOf(probe) as FileHandle
  const originalWriteFile = prototype.writeFile
  try {
    try {
      prototype.writeFile = async function (data) {
        if (Buffer.isBuffer(data)) await this.write(data.subarray(0, 4), 0, 4, null)
        throw new Error("injected write failure")
      }
      await assert.rejects(saveGeneratedImage(input(projectDirectory)), /injected write failure/)
    } finally {
      prototype.writeFile = originalWriteFile
    }

    assert.deepEqual(await readdir(join(projectDirectory, "assets", "generated")), [])
  } finally {
    await probe.close().catch(() => undefined)
    await rm(projectDirectory, { recursive: true, force: true })
  }
})

test("rejects malformed and non-canonical base64 before creating output directories", async () => {
  const projectDirectory = await projectFixture()
  try {
    for (const imageBase64 of ["", "YWJj\n", "YWJj=", "_w==", "Zh=="]) {
      await assert.rejects(
        saveGeneratedImage({ projectDirectory, imageBase64 }),
        /canonical base64|non-empty/,
      )
    }
    await assert.rejects(readdir(join(projectDirectory, "assets")), { code: "ENOENT" })
  } finally {
    await rm(projectDirectory, { recursive: true, force: true })
  }
})

test("rejects data without the PNG signature and a structurally valid IHDR", async () => {
  const projectDirectory = await projectFixture()
  try {
    await assert.rejects(saveGeneratedImage(input(projectDirectory, Buffer.from("not a png"))), /PNG/)

    const badCrc = png()
    badCrc[32] ^= 0xff
    await assert.rejects(saveGeneratedImage(input(projectDirectory, badCrc)), /IHDR CRC/)

    const badDimensions = png()
    badDimensions.writeUInt32BE(0, 16)
    refreshChunkCrc(badDimensions, 8)
    await assert.rejects(saveGeneratedImage(input(projectDirectory, badDimensions)), /IHDR fields/)

    const badColorDepth = png()
    badColorDepth[24] = 4
    refreshChunkCrc(badColorDepth, 8)
    await assert.rejects(saveGeneratedImage(input(projectDirectory, badColorDepth)), /IHDR fields/)
  } finally {
    await rm(projectDirectory, { recursive: true, force: true })
  }
})

test("rejects truncated PNGs and missing IDAT or IEND chunks", async () => {
  const projectDirectory = await projectFixture()
  try {
    const complete = png()
    await assert.rejects(saveGeneratedImage(input(projectDirectory, complete.subarray(0, complete.length - 1))), /truncated/)

    const withoutIDAT = Buffer.concat([PNG_SIGNATURE, ihdrChunk(), iendChunk()])
    await assert.rejects(saveGeneratedImage(input(projectDirectory, withoutIDAT)), /missing image data/)

    const withoutIEND = Buffer.concat([PNG_SIGNATURE, ihdrChunk(), idatChunk()])
    await assert.rejects(saveGeneratedImage(input(projectDirectory, withoutIEND)), /missing IEND/)
  } finally {
    await rm(projectDirectory, { recursive: true, force: true })
  }
})

test("rejects malformed chunk lengths and CRCs", async () => {
  const projectDirectory = await projectFixture()
  try {
    const badLength = png()
    badLength.writeUInt32BE(0x7fffffff, 33)
    await assert.rejects(saveGeneratedImage(input(projectDirectory, badLength)), /chunk length/)

    const badIDATCrc = png()
    const idatOffset = 8 + 25
    const idatCrcOffset = idatOffset + 8 + badIDATCrc.readUInt32BE(idatOffset)
    badIDATCrc[idatCrcOffset] ^= 0xff
    await assert.rejects(saveGeneratedImage(input(projectDirectory, badIDATCrc)), /IDAT CRC/)
  } finally {
    await rm(projectDirectory, { recursive: true, force: true })
  }
})

test("rejects images larger than 16 MiB", async () => {
  const projectDirectory = await projectFixture()
  try {
    const oversized = Buffer.alloc(16 * 1024 * 1024 + 1)
    await assert.rejects(saveGeneratedImage(input(projectDirectory, oversized)), /16 MiB|16777216/)
    await assert.rejects(readdir(join(projectDirectory, "assets")), { code: "ENOENT" })
  } finally {
    await rm(projectDirectory, { recursive: true, force: true })
  }
})

test("rejects traversal, separators, controls, and overlong labels", async () => {
  const projectDirectory = await projectFixture()
  try {
    for (const label of ["", ".", "..", "../escape", "nested/name", "nested\\name", "bad label", "line\nbreak", "nul\0byte", "é", "a".repeat(65)]) {
      await assert.rejects(saveGeneratedImage(input(projectDirectory, png(), label)), /label/)
    }
    await assert.rejects(readdir(join(projectDirectory, "assets")), { code: "ENOENT" })
  } finally {
    await rm(projectDirectory, { recursive: true, force: true })
  }
})

test("rejects a symlinked project root", async () => {
  const container = await projectFixture()
  const projectDirectory = join(container, "project")
  const alias = join(container, "project-link")
  try {
    await mkdir(projectDirectory)
    await symlink(projectDirectory, alias)
    await assert.rejects(saveGeneratedImage(input(alias)), /projectDirectory/)
  } finally {
    await rm(container, { recursive: true, force: true })
  }
})

test("rejects symlinks in either output directory component", async () => {
  const projectDirectory = await projectFixture()
  const external = join(projectDirectory, "external")
  try {
    await mkdir(external)
    await symlink(external, join(projectDirectory, "assets"))
    await assert.rejects(saveGeneratedImage(input(projectDirectory)), /assets\/generated.*non-symlink/)
    assert.deepEqual(await readdir(external), [])

    await rm(join(projectDirectory, "assets"))
    await mkdir(join(projectDirectory, "assets"))
    await symlink(external, join(projectDirectory, "assets", "generated"))
    await assert.rejects(saveGeneratedImage(input(projectDirectory)), /assets\/generated.*non-symlink/)
    assert.deepEqual(await readdir(external), [])
  } finally {
    await rm(projectDirectory, { recursive: true, force: true })
  }
})

test("requires a canonical absolute project directory", async () => {
  await assert.rejects(
    saveGeneratedImage({ projectDirectory: "relative/project", imageBase64: png().toString("base64") }),
    /canonical absolute path/,
  )
})
