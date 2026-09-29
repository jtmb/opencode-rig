import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import { promisify } from "node:util"
import test from "node:test"
// The installer is executable JavaScript; this test exercises its exported
// validators directly as runtime values.
const {
  assertHash,
  expectedDirectories,
  expectedEntries,
  parseStrictJson,
  sourcePath,
  validateManifest,
} =
  // @ts-expect-error The .mjs helper intentionally has no generated declaration.
  await import("../scripts/install-parsers.mjs")

const run = promisify(execFile)
const script = new URL("../scripts/install-parsers.mjs", import.meta.url)
const packageRoot = resolve(dirname(script.pathname), "..")
const manifest = JSON.parse(readFileSync(resolve(packageRoot, "parsers.manifest.json"), "utf8"))
const clone = () => JSON.parse(JSON.stringify(manifest))
const fails = async (args: string[], pattern?: RegExp) => {
  const invocation = run(process.execPath, [script.pathname, ...args])
  if (pattern) await assert.rejects(invocation, pattern)
  else await assert.rejects(invocation)
}

test("installer creates the exact managed tree and rejects every extra before writes", async () => {
  const root = await mkdtemp(`${tmpdir()}/rig-parser-exact-`)
  const target = `${root}/target`
  try {
    await run(process.execPath, [script.pathname, "--target", target])
    await run(process.execPath, [script.pathname, "--verify-only", "--target", target])
    const plan = validateManifest(clone())
    assert.equal(expectedDirectories(plan).size, 21)
    assert.equal(expectedEntries(plan).size, 42)
    const managed = await readFile(`${target}/yaml/tree-sitter-yaml.wasm`)

    await writeFile(`${target}/yaml/rogue.tmp`, "rogue")
    await fails(["--target", target], /unexpected parser target entry/)
    assert.deepEqual(await readFile(`${target}/yaml/tree-sitter-yaml.wasm`), managed)
    await rm(`${target}/yaml/rogue.tmp`)

    await mkdir(`${target}/rogue-empty`)
    await fails(["--verify-only", "--target", target], /unexpected parser target directory/)
    await rm(`${target}/rogue-empty`, { recursive: true })

    const outside = `${root}/outside`
    await mkdir(outside)
    await writeFile(`${outside}/sentinel`, "untouched")
    await symlink(`${outside}/sentinel`, `${target}/yaml/rogue-link`)
    await fails(["--verify-only", "--target", target], /unexpected parser target entry/)
    assert.equal(readFileSync(`${outside}/sentinel`, "utf8"), "untouched")
    await rm(`${target}/yaml/rogue-link`)

    await writeFile(`${target}/yaml/.parser.tmp-stale`, "stale")
    await fails(["--verify-only", "--target", target], /unexpected parser target entry/)
    await rm(`${target}/yaml/.parser.tmp-stale`)
    await run(process.execPath, [script.pathname, "--verify-only", "--target", target])

    await rm(`${target}/yaml`, { recursive: true })
    await fails(["--verify-only", "--target", target], /missing parser target directory: yaml/)
    await run(process.execPath, [script.pathname, "--target", target])

    const installed = await readFile(`${target}/yaml/tree-sitter-yaml.wasm`)
    await writeFile(`${target}/yaml/tree-sitter-yaml.wasm`, Buffer.concat([installed, Buffer.from("tampered")]))
    await fails(["--verify-only", "--target", target], /SHA-256 mismatch/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("strict JSON and manifest validators reject unsafe or colliding definitions without mutation", async () => {
  const proto = parseStrictJson('{"__proto__":{"safe":true},"constructor":"data"}')
  assert.equal(Object.getPrototypeOf(proto), null)
  assert.equal(Object.prototype.hasOwnProperty.call(proto, "__proto__"), true)
  assert.equal(proto.constructor, "data")
  assert.throws(() => parseStrictJson('{"__proto__":1,"__proto__":2}'), /duplicate object key/)
  assert.throws(() => parseStrictJson('{"broken": [}'), /expected|invalid/)

  const original = clone()
  const noAliases = clone()
  delete noAliases.assets[0].aliases
  const beforeValidation = JSON.stringify(noAliases)
  validateManifest(noAliases)
  assert.equal(JSON.stringify(noAliases), beforeValidation)
  assert.deepEqual(original.assets[0].aliases, ["jsonc"])

  const invalid = [
    (value: any) => { value.assets.push(JSON.parse(JSON.stringify(value.assets[0]))) },
    (value: any) => { value.assets[0].aliases = ["jsonc", "jsonc"] },
    (value: any) => { value.assets[0].aliases = [value.assets[1].filetype] },
    (value: any) => { value.assets[0].aliases = ["yaml"]; value.assets[1].filetype = "yaml" },
    (value: any) => { value.assets[1].aliases = [value.assets[0].filetype] },
    (value: any) => { value.assets[0].files[1].source = value.assets[0].files[0].source },
    (value: any) => { value.assets[0].files = [value.assets[0].files[0], value.assets[0].files[0]] },
    (value: any) => { value.assets[0].files = [value.assets[0].files[1], value.assets[0].files[1]] },
    (value: any) => { value.assets[0].files.pop() },
  ]
  for (const mutate of invalid) assert.throws(() => validateManifest((() => { const value = clone(); mutate(value); return value })()))
  assert.throws(() => sourcePath(packageRoot, { source: "../../outside.wasm" }), /escapes/)
  assert.throws(() => sourcePath(packageRoot, { source: "/absolute.wasm" }), /relative/)
})

test("target and source safety reject symlinks and hash tampering without touching sentinels", async () => {
  const root = await mkdtemp(`${tmpdir()}/rig-parser-links-`)
  try {
    const outside = `${root}/outside`
    await mkdir(outside)
    await writeFile(`${outside}/sentinel`, "untouched")
    const targetLink = `${root}/target-link`
    await symlink(outside, targetLink)
    await fails(["--verify-only", "--target", targetLink], /symlink/)
    const ancestor = `${root}/ancestor`
    await symlink(outside, ancestor)
    await fails(["--verify-only", "--target", `${ancestor}/target`], /symlink/)
    assert.equal(readFileSync(`${outside}/sentinel`, "utf8"), "untouched")

    const source = `${root}/source.wasm`
    await writeFile(source, "tampered")
    await assert.rejects(assertHash(source, "0".repeat(64), "source"), /SHA-256 mismatch/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
