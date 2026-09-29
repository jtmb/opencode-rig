import { createHash } from "node:crypto"
import { copyFile, mkdir, readFile, rename, rm, readdir } from "node:fs/promises"
import { createReadStream, lstatSync } from "node:fs"
import { dirname, basename, isAbsolute, relative, resolve, parse } from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const manifestPath = resolve(packageRoot, "parsers.manifest.json")
const args = process.argv.slice(2)

export const parseStrictJson = (text, label = "JSON") => {
  let index = 0
  const whitespace = () => { while (/\s/.test(text[index] ?? "")) index++ }
  const string = () => {
    const start = index
    if (text[index++] !== '"') throw new Error(`${label}: expected string`)
    let escaped = false
    while (index < text.length) {
      const char = text[index++]
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') return JSON.parse(text.slice(start, index))
    }
    throw new Error(`${label}: unterminated string`)
  }
  const value = () => {
    whitespace()
    if (text[index] === '"') return string()
    if (text[index] === "{") {
      index++; const object = Object.create(null); const keys = new Set(); whitespace()
      if (text[index] === "}") { index++; return object }
      while (true) {
        whitespace(); const key = string()
        if (keys.has(key)) throw new Error(`${label}: duplicate object key ${key}`)
        keys.add(key); whitespace()
        if (text[index++] !== ":") throw new Error(`${label}: expected colon`)
        object[key] = value(); whitespace()
        if (text[index] === "}") { index++; return object }
        if (text[index++] !== ",") throw new Error(`${label}: expected comma`)
      }
    }
    if (text[index] === "[") {
      index++; const array = []; whitespace()
      if (text[index] === "]") { index++; return array }
      while (true) {
        array.push(value()); whitespace()
        if (text[index] === "]") { index++; return array }
        if (text[index++] !== ",") throw new Error(`${label}: expected comma`)
      }
    }
    const primitive = text.slice(index).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0]
    if (!primitive) throw new Error(`${label}: invalid value`)
    index += primitive.length
    return JSON.parse(primitive)
  }
  const result = value(); whitespace()
  if (index !== text.length) throw new Error(`${label}: trailing content`)
  return result
}

export const safeName = (value, label) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${label} must be a safe name`)
  return value
}

export const sourcePath = (packageRootValue, entry) => {
  if (typeof entry?.source !== "string" || isAbsolute(entry.source)) throw new Error("manifest source must be relative")
  const source = resolve(packageRootValue, entry.source)
  const allowedRoot = resolve(packageRootValue, "../node_modules/tree-sitter-wasm")
  const containment = relative(allowedRoot, source)
  if (containment.startsWith("..") || isAbsolute(containment)) throw new Error(`manifest source escapes approved package: ${entry.source}`)
  return source
}

export const validateManifest = (value) => {
  if (!value || value.schema !== 1 || value.package !== "tree-sitter-wasm" || value.version !== "2.0.1") throw new Error("invalid parser manifest schema/package/version")
  if (!Array.isArray(value.assets) || value.assets.length === 0) throw new Error("manifest assets must be a non-empty array")
  const names = new Set()
  const destinations = new Set()
  for (const asset of value.assets) {
    safeName(asset?.filetype, "filetype")
    if (names.has(asset.filetype)) throw new Error(`duplicate filetype: ${asset.filetype}`)
    names.add(asset.filetype)
    if (asset.sourceLanguage !== undefined && typeof asset.sourceLanguage !== "string") throw new Error("sourceLanguage must be a string")
    if (asset.aliases !== undefined && !Array.isArray(asset.aliases)) throw new Error(`${asset.filetype} aliases must be an array`)
    const assetAliases = asset.aliases === undefined ? [] : asset.aliases
    const aliases = new Set()
    for (const alias of assetAliases) {
      safeName(alias, "alias")
      if (aliases.has(alias) || names.has(alias)) throw new Error(`duplicate or colliding alias: ${alias}`)
      aliases.add(alias); names.add(alias)
    }
    if (!Array.isArray(asset.files) || asset.files.length !== 2) throw new Error(`${asset.filetype} must have exactly two files`)
    const kinds = new Set()
    for (const file of asset.files) {
      if (file?.kind !== "wasm" && file?.kind !== "highlights") throw new Error(`${asset.filetype} has an invalid file kind`)
      if (kinds.has(file.kind)) throw new Error(`${asset.filetype} has duplicate ${file.kind} file`)
      kinds.add(file.kind)
      if (typeof file.source !== "string" || file.source.length === 0 || isAbsolute(file.source) || file.source.includes("\0") || basename(file.source) === "." || basename(file.source) === "..") throw new Error(`${asset.filetype} has an unsafe source filename`)
      if (typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256)) throw new Error(`${asset.filetype}/${file.kind} has an invalid SHA-256`)
      const destination = `${asset.filetype}/${basename(file.source)}`
      if (destinations.has(destination)) throw new Error(`duplicate parser destination: ${destination}`)
      destinations.add(destination)
    }
    if (!kinds.has("wasm") || !kinds.has("highlights")) throw new Error(`${asset.filetype} must have wasm and highlights files`)
  }
  return { assets: value.assets, destinations }
}

const assertSafeTarget = (path) => {
  const root = parse(path).root
  let current = path
  while (current !== root) {
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`parser target or ancestor is a symlink: ${current}`)
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
    current = dirname(current)
  }
}

export const expectedEntries = (plan) => {
  const entries = new Map()
  for (const asset of plan.assets) for (const file of asset.files) entries.set(`${asset.filetype}/${basename(file.source)}`, file)
  return entries
}

export const expectedDirectories = (plan) => new Set(plan.assets.map((asset) => asset.filetype))

export const validateTarget = async (target, plan, { requireComplete = false } = {}) => {
  assertSafeTarget(target)
  const expected = expectedEntries(plan)
  const directories = expectedDirectories(plan)
  let rootEntries
  try { rootEntries = await readdir(target, { withFileTypes: true }) } catch (error) {
    if (error?.code === "ENOENT" && !requireComplete) return
    if (error?.code === "ENOENT" && requireComplete) throw new Error(`missing parser target directory: ${[...directories][0]}`)
    throw new Error(`parser target is missing or unreadable: ${target}`)
  }
  const actual = new Set()
  for (const rootEntry of rootEntries) {
    if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) throw new Error(`unexpected parser target entry: ${rootEntry.name}`)
    if (!directories.has(rootEntry.name)) throw new Error(`unexpected parser target directory: ${rootEntry.name}`)
    const files = await readdir(resolve(target, rootEntry.name), { withFileTypes: true })
    for (const file of files) {
      const key = `${rootEntry.name}/${file.name}`
      if (file.isSymbolicLink() || !file.isFile() || !expected.has(key)) throw new Error(`unexpected parser target entry: ${key}`)
      actual.add(key)
    }
  }
  if (requireComplete) for (const directory of directories) if (!rootEntries.some((entry) => entry.name === directory)) throw new Error(`missing parser target directory: ${directory}`)
  if (requireComplete) for (const key of expected.keys()) if (!actual.has(key)) throw new Error(`missing parser target entry: ${key}`)
}

const sha256 = async (file) => new Promise((resolveHash, reject) => {
  const hash = createHash("sha256")
  const stream = createReadStream(file)
  stream.on("error", reject)
  stream.on("data", (chunk) => hash.update(chunk))
  stream.on("end", () => resolveHash(hash.digest("hex")))
})
export const assertHash = async (file, expected, label) => {
  let actual
  try { actual = await sha256(file) } catch (error) { throw new Error(`${label}: missing or unreadable (${error.message})`) }
  if (actual !== expected) throw new Error(`${label}: SHA-256 mismatch; expected ${expected}, got ${actual}`)
}

const run = async () => {
  if (args.some((arg) => arg.includes("\0"))) throw new Error("arguments may not contain NUL bytes")
  const verifyOnlyCount = args.filter((arg) => arg === "--verify-only").length
  if (verifyOnlyCount > 1) throw new Error("--verify-only may be specified only once")
  const targetIndexes = args.flatMap((arg, index) => arg === "--target" ? [index] : [])
  if (targetIndexes.length > 1) throw new Error("--target may be specified only once")
  const targetArgumentIndex = targetIndexes[0] ?? -1
  const targetArgument = targetArgumentIndex >= 0 ? args[targetArgumentIndex + 1] : undefined
  if (targetArgumentIndex >= 0 && (!targetArgument || targetArgument.startsWith("--"))) throw new Error("--target requires a directory")
  if (args.some((arg, index) => arg !== "--verify-only" && index !== targetArgumentIndex && index !== targetArgumentIndex + 1)) throw new Error(`unknown argument: ${args.join(" ")}`)
  const verifyOnly = verifyOnlyCount === 1
  const target = resolve(targetArgument ?? process.env.RIG_PARSERS_DIR ?? resolve(process.env.XDG_CACHE_HOME ?? resolve(process.env.HOME ?? ".", ".cache"), "opencode-rig", "parsers"))
  const manifest = parseStrictJson(await readFile(manifestPath, "utf8"), "parser manifest")
  const plan = validateManifest(manifest)
  const packageJson = parseStrictJson(await readFile(resolve(packageRoot, "../node_modules/tree-sitter-wasm/package.json"), "utf8"), "tree-sitter package")
  if (packageJson.name !== manifest.package || packageJson.version !== manifest.version) throw new Error(`expected ${manifest.package}@${manifest.version}, found ${packageJson.name}@${packageJson.version}`)
  for (const asset of plan.assets) for (const file of asset.files) {
    const source = sourcePath(packageRoot, file)
    if (lstatSync(source).isSymbolicLink() || !lstatSync(source).isFile()) throw new Error(`${asset.filetype}/${file.kind} source is not a regular file`)
    await assertHash(source, file.sha256, `${asset.filetype}/${file.kind} source`)
  }
  await validateTarget(target, plan, { requireComplete: verifyOnly })
  if (verifyOnly) {
    for (const asset of plan.assets) for (const file of asset.files) await assertHash(resolve(target, asset.filetype, basename(file.source)), file.sha256, `${asset.filetype}/${file.kind} target`)
  } else {
    for (const asset of plan.assets) for (const file of asset.files) {
      const source = sourcePath(packageRoot, file)
      const destination = resolve(target, asset.filetype, basename(file.source))
      await mkdir(dirname(destination), { recursive: true })
      const temporary = `${destination}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
      try {
        await copyFile(source, temporary)
        await assertHash(temporary, file.sha256, `${asset.filetype}/${file.kind} temporary copy`)
        await rename(temporary, destination)
        await assertHash(destination, file.sha256, `${asset.filetype}/${file.kind} installed copy`)
      } finally { await rm(temporary, { force: true }) }
    }
    await validateTarget(target, plan, { requireComplete: true })
  }
  console.log(`${verifyOnly ? "verified" : "installed"} ${plan.assets.length} managed parser languages at ${target}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run()
