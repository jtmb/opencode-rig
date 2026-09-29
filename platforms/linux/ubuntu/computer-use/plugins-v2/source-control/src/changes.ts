export type SourceControlChange = {
  file: string
  additions: number
  deletions: number
  status: "added" | "deleted" | "modified"
}

export const MAX_MORE_FILES_PAGE_SIZE = 6
export const MORE_FILES_PAGE_RESERVED_ROWS = 8

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

export function normalizeChanges(value: unknown): SourceControlChange[] {
  if (!Array.isArray(value)) return []

  return value
    .flatMap((item) => {
      if (typeof item !== "object" || item === null) return []
      const change = item as Record<string, unknown>
      if (
        typeof change.file !== "string" ||
        !["added", "deleted", "modified"].includes(String(change.status))
      ) {
        return []
      }
      const file = change.file
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
      if (!file) return []
      return [
        {
          file,
          additions: count(change.additions),
          deletions: count(change.deletions),
          status: change.status as SourceControlChange["status"],
        },
      ]
    })
    .sort((left, right) => left.file.localeCompare(right.file))
}

export function statusLetter(status: SourceControlChange["status"]): "A" | "D" | "M" {
  if (status === "added") return "A"
  if (status === "deleted") return "D"
  return "M"
}

export function leftTruncate(value: string, maxLength: number): string {
  if (maxLength <= 0) return ""
  if (value.length <= maxLength) return value
  if (maxLength <= 3) return value.slice(-maxLength)
  return `...${value.slice(-(maxLength - 3))}`
}

export function visibleChanges(changes: readonly SourceControlChange[], maxFiles: number): SourceControlChange[] {
  return changes.slice(0, Math.max(1, Math.trunc(maxFiles)))
}

export function moreFilesPageSize(viewportHeight: number, occupiedRows = 0): number {
  const height = Number.isFinite(viewportHeight) ? Math.max(0, Math.trunc(viewportHeight)) : 0
  const occupied = Number.isFinite(occupiedRows) ? Math.max(0, Math.trunc(occupiedRows)) : 0
  return Math.max(1, Math.min(MAX_MORE_FILES_PAGE_SIZE, Math.floor(Math.max(1, height - MORE_FILES_PAGE_RESERVED_ROWS - occupied))))
}

export type SourceControlPage = {
  page: number
  pageCount: number
  start: number
  end: number
}

export function sourceControlPage(total: number, requestedPage: number, pageSize: number): SourceControlPage {
  const safeTotal = Math.max(0, Math.trunc(total))
  const safePageSize = Math.max(1, Math.trunc(pageSize))
  const pageCount = Math.ceil(safeTotal / safePageSize)
  const page = pageCount === 0 ? 0 : Math.min(Math.max(0, Math.trunc(requestedPage)), pageCount - 1)
  return {
    page,
    pageCount,
    start: page * safePageSize,
    end: Math.min(safeTotal, (page + 1) * safePageSize),
  }
}

export function pagedChanges(
  changes: readonly SourceControlChange[],
  requestedPage: number,
  pageSize: number,
): { items: SourceControlChange[]; range: SourceControlPage } {
  const range = sourceControlPage(changes.length, requestedPage, pageSize)
  return { items: changes.slice(range.start, range.end), range }
}
