import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { expectedEntries, parseStrictJson, sourcePath, validateManifest, validateTarget } from "./install-parsers.mjs"

const script = fileURLToPath(new URL("./install-parsers.mjs", import.meta.url))
const packageRoot = resolve(dirname(script), "..")
const manifest = JSON.parse(readFileSync(resolve(packageRoot, "parsers.manifest.json"), "utf8"))
const base = JSON.parse(JSON.stringify(manifest))
const testRoot = await mkdtemp(resolve(process.env.OPENCODE_PARSER_TEST_ROOT ?? "/tmp/opencode", "parser-installer-test-"))

const run = (target, verifyOnly = false) => spawnSync(process.execPath, [script, ...(verifyOnly ? ["--verify-only"] : []), "--target", target], { encoding: "utf8" })
const expectManifestFailure = (mutate) => {
  const value = JSON.parse(JSON.stringify(base))
  mutate(value)
  assert.throws(() => validateManifest(value))
}

try {
  const plan = validateManifest(base)
  assert.throws(() => parseStrictJson('{"duplicate":1,"duplicate":2}', "fixture"))
  assert.equal(plan.assets.length, 21)
  assert.equal(expectedEntries(plan).size, 42)
  expectManifestFailure((value) => { value.schema = 2 })
  expectManifestFailure((value) => { value.assets.push(JSON.parse(JSON.stringify(value.assets[0]))) })
  expectManifestFailure((value) => { value.assets[0].aliases = [value.assets[1].filetype] })
  expectManifestFailure((value) => { value.assets[0].files[1].source = value.assets[0].files[0].source })
  expectManifestFailure((value) => { value.assets[0].files.pop() })
  assert.throws(() => sourcePath(packageRoot, { source: "../../outside.wasm" }))

  const target = resolve(testRoot, "target")
  assert.equal(run(target).status, 0)
  assert.equal(run(target, true).status, 0)
  const rogue = resolve(target, "rogue")
  await mkdir(rogue)
  await writeFile(resolve(rogue, "extra.wasm"), "rogue")
  assert.notEqual(run(target, true).status, 0)
  await rm(rogue, { recursive: true })
  await mkdir(rogue)
  await rm(rogue, { recursive: true })
  await symlink(resolve(testRoot, "outside"), rogue)
  assert.notEqual(run(target, true).status, 0)
  await rm(rogue)
  const staleTemp = resolve(target, "json", ".parser.tmp-stale")
  await writeFile(staleTemp, "stale")
  assert.notEqual(run(target, true).status, 0)
  await rm(staleTemp)
  assert.equal(run(target, true).status, 0)
  assert.equal(run(target).status, 0)
  assert.equal(run(target, true).status, 0)

  const outside = resolve(testRoot, "outside")
  await mkdir(outside)
  const sentinel = resolve(outside, "sentinel")
  await writeFile(sentinel, "untouched")
  const targetLink = resolve(testRoot, "target-link")
  await symlink(outside, targetLink)
  assert.notEqual(run(targetLink, true).status, 0)
  assert.equal(readFileSync(sentinel, "utf8"), "untouched")
  await rm(targetLink)
  const ancestor = resolve(testRoot, "ancestor")
  await symlink(outside, ancestor)
  assert.notEqual(run(resolve(ancestor, "target"), true).status, 0)
  assert.equal(readFileSync(sentinel, "utf8"), "untouched")
  assert.equal(existsSync(resolve(target, "json", ".parser.tmp-stale")), false)
} finally {
  await rm(testRoot, { recursive: true, force: true })
}

console.log("OK: parser installer self-tests passed")
