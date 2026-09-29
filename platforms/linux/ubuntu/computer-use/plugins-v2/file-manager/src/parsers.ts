import path from "node:path"
import fs from "node:fs"

import { getTreeSitterClient } from "@opentui/core"

import manifest from "../parsers.manifest.json" with { type: "json" }

export interface ParserAsset {
  filetype: string
  aliases?: readonly string[]
  wasm: string
  highlights: readonly string[]
}

export type ParserRegistration = { filetype: string; registered: boolean; reason?: string }
export type ParserAvailability = "bundled" | "available" | "unavailable"
export type ParserOffsetMode = "bytes" | "characters"

export const BUNDLED_FILETYPES = new Set(["javascript", "javascriptreact", "typescript", "typescriptreact", "markdown", "zig"])

function boundedOffset(offset: number, maximum: number): number {
  if (!Number.isFinite(offset)) return 0
  return Math.max(0, Math.min(maximum, Math.trunc(offset)))
}

function utf8ByteOffsetToUtf16(encoded: Uint8Array, offset: number): number {
  let boundary = boundedOffset(offset, encoded.length)
  while (boundary > 0 && boundary < encoded.length && (encoded[boundary] & 0xc0) === 0x80) boundary -= 1
  return new TextDecoder().decode(encoded.subarray(0, boundary)).length
}

/**
 * Normalize a tree-sitter highlight range for addHighlightByCharRange.
 * OpenTUI 0.5.11 returns JavaScript/UTF-16 offsets, so character pass-through
 * is the default. Byte conversion is an explicit compatibility mode for an
 * alternate worker that reports UTF-8 byte offsets.
 */
export function parserHighlightRangeToUtf16(
  content: string,
  startOffset: number,
  endOffset: number,
  mode: ParserOffsetMode = "characters",
): { start: number; end: number } {
  if (mode === "bytes") {
    const encoded = new TextEncoder().encode(content)
    const start = utf8ByteOffsetToUtf16(encoded, startOffset)
    const end = utf8ByteOffsetToUtf16(encoded, endOffset)
    return { start, end: Math.max(start, end) }
  }
  const start = boundedOffset(startOffset, content.length)
  const end = boundedOffset(endOffset, content.length)
  return { start, end: Math.max(start, end) }
}

/** Resolve the managed parser cache without creating files or downloading. */
export function managedParserDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.RIG_PARSERS_DIR ?? path.join(env.XDG_CACHE_HOME ?? path.join(env.HOME ?? ".", ".cache"), "opencode-rig", "parsers")
}

export function managedParserAssets(dir: string = managedParserDir()): ParserAsset[] {
  return manifest.assets.map((asset) => ({
    filetype: asset.filetype,
    aliases: asset.aliases,
    wasm: path.join(dir, asset.filetype, path.basename((asset.files.find((file) => file.kind === "wasm") ?? (() => { throw new Error(`manifest entry ${asset.filetype} has no wasm`) })()).source)),
    highlights: [path.join(dir, asset.filetype, path.basename((asset.files.find((file) => file.kind === "highlights") ?? (() => { throw new Error(`manifest entry ${asset.filetype} has no highlights`) })()).source))],
  }))
}

export function parserAvailability(registrations: readonly ParserRegistration[] = []): Map<string, ParserAvailability> {
  const availability = new Map<string, ParserAvailability>()
  for (const filetype of BUNDLED_FILETYPES) availability.set(filetype, "bundled")
  for (const registration of registrations) {
    const state = registration.registered ? "available" : "unavailable"
    availability.set(registration.filetype, state)
    const asset = manifest.assets.find((entry) => entry.filetype === registration.filetype)
    for (const alias of asset?.aliases ?? []) availability.set(alias, state)
  }
  return availability
}

/**
 * Register only managed parsers; JavaScript, TypeScript, Markdown, and Zig are
 * supplied by OpenTUI 0.5.11 and deliberately never re-registered here.
 */
export async function registerParsers(assets: readonly ParserAsset[]): Promise<ParserRegistration[]> {
  if (assets.length === 0) return []
  const client = getTreeSitterClient()
  try {
    if (!client.isInitialized()) await client.initialize()
  } catch (error) {
    return assets.map((asset) => ({ filetype: asset.filetype, registered: false, reason: `client initialization failed: ${String(error)}` }))
  }
  const registrations: ParserRegistration[] = []
  for (const asset of assets) {
    if (!fs.existsSync(asset.wasm) || asset.highlights.some((query) => !fs.existsSync(query))) {
      registrations.push({ filetype: asset.filetype, registered: false, reason: "managed parser asset is unavailable; using plain text" })
      continue
    }
    try {
      client.addFiletypeParser({
        filetype: asset.filetype,
        ...(asset.aliases ? { aliases: [...asset.aliases] } : {}),
        wasm: asset.wasm,
        queries: { highlights: [...asset.highlights] },
      })
      registrations.push({ filetype: asset.filetype, registered: true })
    } catch (error) {
      registrations.push({ filetype: asset.filetype, registered: false, reason: `registration failed: ${String(error)}` })
    }
  }
  return registrations
}
