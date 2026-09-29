import path from "node:path"

import { isLexicallySafeRelative, MAX_EDIT_BYTES, type SafeDirectoryEntry } from "./safety.ts"

export { MAX_EDIT_BYTES }

export type FileNode = {
  name: string
  path: string
  type: "file" | "directory"
  ignored: boolean
  virtual?: boolean
  diffStatus?: "added" | "deleted" | "modified"
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
  ".yml": "yaml", ".yaml": "yaml", ".toml": "toml", ".sh": "bash", ".bash": "bash",
  ".py": "python", ".go": "go", ".rs": "rust", ".sql": "sql", ".html": "html", ".htm": "html",
  ".css": "css", ".scss": "scss", ".xml": "xml", ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp",
  ".java": "java", ".rb": "ruby", ".php": "php", ".lua": "lua", ".ini": "ini", ".cfg": "ini", ".diff": "diff", ".patch": "diff",
}

const FILETYPE_BY_BASENAME: Record<string, string> = { dockerfile: "dockerfile", makefile: "make" }

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

/** Adapt only the bounded, relative metadata emitted by PathGuard. The CLI
 * tree never needs or retains arbitrary absolute filesystem paths. */
export function fileNodesFromDirectoryEntries(entries: readonly SafeDirectoryEntry[]): FileNode[] {
  return sortEntries(entries.map((entry) => ({
    name: entry.name,
    path: entry.relative,
    type: entry.type,
    ignored: false,
  })))
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
  return FILETYPE_BY_BASENAME[path.basename(filePath).toLowerCase()] ?? FILETYPE_BY_EXTENSION[path.extname(filePath).toLowerCase()]
}

/** Terminal cells are not JavaScript string characters: wide and combining
 * characters must not be allowed to push the next tree row sideways. */
export function cellWidth(value: string): number {
  let width = 0
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue
    if ((code >= 0x300 && code <= 0x36f) || (code >= 0xfe00 && code <= 0xfe0f)) continue
    width += code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0x1f300 && code <= 0x1faff)) ? 2 : 1
  }
  return width
}

export function safeOneLine(value: string): string {
  return [...value].map((character) => {
    const code = character.codePointAt(0) ?? 0
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? "�" : character
  }).join("").replaceAll(/\r?\n/g, "�")
}

export function truncateToCellWidth(value: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return ""
  const clean = safeOneLine(value)
  if (cellWidth(clean) <= width) return clean
  if (width <= cellWidth(ellipsis)) return ellipsis.slice(0, width)
  let result = ""
  for (const character of clean) {
    if (cellWidth(result + character + ellipsis) > width) break
    result += character
  }
  return result + ellipsis
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
    if (!value || !isLexicallySafeRelative(value) || seen.has(value) || isProtectedPath(value)) continue
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
