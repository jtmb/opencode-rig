import type { ResourceSnapshot } from "./monitor.ts"
import type { SystemSnapshot } from "./system.ts"

export type ResourceTone = "normal" | "warning" | "error"

export function formatMiB(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "? MiB"
  return `${Math.round(bytes / 1024 / 1024)} MiB`
}

export function formatCpu(percent: number | undefined): string { return percent === undefined ? "?%" : `${Math.round(percent)}%` }
export function footerText(snapshot: ResourceSnapshot): string { return `CPU ${formatCpu(snapshot.cpuPercent)} · RAM ${formatMiB(snapshot.rssBytes)}` }
export function resourceTone(snapshot: ResourceSnapshot): ResourceTone {
  if ((snapshot.cpuPercent ?? 0) >= 95 || snapshot.rssBytes >= 2 * 1024 ** 3) return "error"
  if ((snapshot.cpuPercent ?? 0) >= 80 || snapshot.rssBytes >= 1024 ** 3) return "warning"
  return "normal"
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "?"
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MiB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`
}

export function systemLines(snapshot: SystemSnapshot, width = 80): string[] {
  const limit = Math.max(20, Math.floor(width))
  const trim = (line: string) => line.length <= limit ? line : `${line.slice(0, Math.max(0, limit - 1))}…`
  const lines = [
    `CPU: ${snapshot.cpuModel}`,
    `Cores: ${snapshot.physicalCores ?? "?"} physical / ${snapshot.logicalCores} logical · Usage: ${snapshot.cpuPercent === undefined ? "?" : `${Math.round(snapshot.cpuPercent)}%`}`,
    `RAM: ${formatBytes(snapshot.memoryUsedBytes)} used / ${formatBytes(snapshot.memoryTotalBytes)} total · ${formatBytes(snapshot.memoryAvailableBytes)} available`,
  ]
  if (snapshot.swapTotalBytes !== undefined && snapshot.swapTotalBytes > 0) lines.push(`Swap: ${formatBytes(snapshot.swapUsedBytes)} used / ${formatBytes(snapshot.swapTotalBytes)} total`)
  lines.push("Storage:")
  for (const filesystem of snapshot.filesystems) lines.push(`  ${filesystem.mount}: ${formatBytes(filesystem.usedBytes)} used / ${formatBytes(filesystem.totalBytes)} total · ${formatBytes(filesystem.availableBytes)} available`)
  return lines.map(trim)
}
