export type SourceControlChange = {
  file: string
  additions: number
  deletions: number
  status: "added" | "deleted" | "modified"
}

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
      return [
        {
          file: change.file,
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
