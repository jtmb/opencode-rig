import type { FileDiffInfo } from "@opencode/client"

import { isProtectedPath, normalizeRelative, sortEntries, type FileNode, type TreeRow } from "./model.ts"
import { isLexicallySafeRelative } from "./safety.ts"

export type DiffSource = "working" | "branch" | "last-turn"
export type DiffView = "split" | "unified"

export function normalizeDiffFiles(files: readonly FileDiffInfo[]): Map<string, FileDiffInfo> {
  const result = new Map<string, FileDiffInfo>()
  for (const file of files) {
    const relative = normalizeRelative(file.file)
    if (!relative || !isLexicallySafeRelative(relative) || isProtectedPath(relative)) continue
    result.set(relative, { ...file, file: relative })
  }
  return result
}

export function mergeRepositoryNodes(
  directory: string,
  physical: readonly FileNode[],
  diffs: ReadonlyMap<string, FileDiffInfo>,
): FileNode[] {
  const nodes = new Map(physical.map((node) => [node.name, { ...node, diffStatus: diffs.get(node.path)?.status }]))
  const prefix = directory ? `${directory}/` : ""

  for (const diff of diffs.values()) {
    if (!diff.file.startsWith(prefix)) continue
    const remainder = diff.file.slice(prefix.length)
    if (!remainder) continue
    const slash = remainder.indexOf("/")
    const name = slash < 0 ? remainder : remainder.slice(0, slash)
    if (!name || nodes.has(name)) continue
    nodes.set(name, {
      name,
      path: prefix + name,
      type: slash < 0 ? "file" : "directory",
      ignored: false,
      virtual: true,
      diffStatus: slash < 0 ? diff.status : undefined,
    })
  }

  return sortEntries([...nodes.values()])
}

export function nextRepositoryFile(rows: readonly TreeRow[], current: string, delta: number): string | undefined {
  const files = rows.filter((row) => row.node.type === "file").map((row) => row.node.path)
  if (files.length === 0) return undefined
  const index = files.indexOf(current)
  const start = index < 0 ? (delta < 0 ? 0 : -1) : index
  return files[(start + delta + files.length) % files.length]
}

export function patchHunkRows(patch: string): number[] {
  return patch.split("\n").flatMap((line, index) => line.startsWith("@@") ? [index] : [])
}

export function diffSourceLabel(source: DiffSource): string {
  if (source === "branch") return "main branch"
  if (source === "last-turn") return "last turn"
  return "working tree"
}

export function contentKind(path: string, diffs: ReadonlyMap<string, FileDiffInfo>): "diff" | "source" {
  return diffs.has(path) ? "diff" : "source"
}

export function effectiveDiffView(status: FileDiffInfo["status"], requested: DiffView): DiffView {
  return status === "modified" ? requested : "unified"
}
