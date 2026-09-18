import path from "node:path"

export type FileNode = {
  name: string
  path: string
  absolute: string
  type: "file" | "directory"
  ignored: boolean
}

export type TreeRow = {
  node: FileNode
  depth: number
  expanded: boolean
}

export type FlattenOptions = {
  includeIgnored?: boolean
}

const FILETYPE_BY_EXTENSION: Record<string, string> = {
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascriptreact",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".json": "json",
  ".jsonc": "json",
  ".md": "markdown",
  ".markdown": "markdown",
  ".zig": "zig",
}

export const MAX_EDIT_BYTES = 512 * 1024
export const SEARCH_LIMIT = 200

export function normalizeRelative(value: string): string {
  return value
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "")
}

export function isProtectedPath(relativePath: string): boolean {
  const normalized = normalizeRelative(relativePath)
  return normalized === ".git" || normalized.startsWith(".git/")
}

export function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

export function sortEntries(entries: readonly FileNode[]): FileNode[] {
  return [...entries].sort((left, right) => {
    if (left.type !== right.type) return left.type === "directory" ? -1 : 1
    return left.name.localeCompare(right.name)
  })
}

export function visibleChildren(entries: readonly FileNode[], includeIgnored = false): FileNode[] {
  return sortEntries(includeIgnored ? entries : entries.filter((entry) => !entry.ignored))
}

export function flattenTree(
  childrenByDirectory: ReadonlyMap<string, readonly FileNode[]>,
  expanded: ReadonlySet<string>,
  options: FlattenOptions = {},
): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (directory: string, depth: number) => {
    for (const node of visibleChildren(childrenByDirectory.get(directory) ?? [], options.includeIgnored)) {
      const isExpanded = node.type === "directory" && expanded.has(node.path)
      rows.push({ node, depth, expanded: isExpanded })
      if (isExpanded) walk(node.path, depth + 1)
    }
  }
  walk("", 0)
  return rows
}

export function filetypeFor(filePath: string): string | undefined {
  return FILETYPE_BY_EXTENSION[path.extname(filePath).toLowerCase()]
}

export function isDirty(original: string, current: string): boolean {
  return original !== current
}

export function isBinaryContent(bytes: Uint8Array): boolean {
  return bytes.includes(0)
}

export function tooLargeToEdit(byteLength: number): boolean {
  return byteLength > MAX_EDIT_BYTES
}

export function normalizeSearchResults(results: readonly string[], limit: number): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const result of results) {
    const value = normalizeRelative(result)
    if (!value || seen.has(value) || isProtectedPath(value)) continue
    seen.add(value)
    normalized.push(value)
    if (normalized.length >= limit) break
  }
  return normalized
}

export function nextIndex(current: number, length: number, delta: number): number {
  if (length === 0) return 0
  return (current + delta + length) % length
}

export function parentOf(relativePath: string): string | undefined {
  const normalized = normalizeRelative(relativePath)
  const index = normalized.lastIndexOf("/")
  if (index < 0) return undefined
  return normalized.slice(0, index)
}
