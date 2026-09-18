import path from "node:path"

import { getTreeSitterClient } from "@opentui/core"

export interface ParserAsset {
  filetype: string
  aliases?: readonly string[]
  wasm: string
  highlights: readonly string[]
}

/**
 * Phase 0 spike: parser assets live in a temp directory and are registered at
 * plugin setup. Phase 2 replaces this with the pinned, checksum-verified fetch
 * script and a generated manifest.
 */
export function spikeParserDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.RIG_SPIKE_PARSERS_DIR ?? "/tmp/opencode/parsers"
}

export function spikeParserAssets(dir: string = spikeParserDir()): ParserAsset[] {
  return [
    {
      filetype: "json",
      aliases: ["jsonc"],
      wasm: path.join(dir, "json", "tree-sitter-json.wasm"),
      highlights: [path.join(dir, "json", "highlights.scm")],
    },
  ]
}

/**
 * Register extra tree-sitter parsers with the host's shared client. Returns
 * false when the client cannot be initialized; individual parser failures are
 * swallowed so the editor falls back to plain text.
 */
export async function registerParsers(assets: readonly ParserAsset[]): Promise<boolean> {
  if (assets.length === 0) return false
  const client = getTreeSitterClient()
  try {
    if (!client.isInitialized()) await client.initialize()
  } catch {
    return false
  }
  let registered = false
  for (const asset of assets) {
    try {
      client.addFiletypeParser({
        filetype: asset.filetype,
        ...(asset.aliases ? { aliases: [...asset.aliases] } : {}),
        wasm: asset.wasm,
        queries: { highlights: [...asset.highlights] },
      })
      registered = true
    } catch {
      // Leave the parser unavailable; the editor renders plain text.
    }
  }
  return registered
}
