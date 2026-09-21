import { accessSync, constants, readFileSync } from "node:fs"
import { join } from "node:path"
import { freemem, totalmem } from "node:os"

const MEBIBYTE = 1024 * 1024

export type MemoryProbe = {
  availableBytes: number
  swapFreeBytes: number
  cgroupAvailableBytes?: number
  cgroupSwapFreeBytes?: number
}

export type MemoryBudget = {
  availableBytes: number
  memoryMaxBytes: number
  swapMaxBytes: number
}

function numericFile(path: string): number | undefined {
  try {
    const value = readFileSync(path, "utf8").trim()
    return /^\d+$/.test(value) ? Number(value) : undefined
  } catch {
    return undefined
  }
}

function memInfo(): Map<string, number> {
  const values = new Map<string, number>()
  try {
    for (const line of readFileSync("/proc/meminfo", "utf8").split("\n")) {
      const match = line.match(/^([^:]+):\s+(\d+)\s+kB$/)
      if (match) values.set(match[1], Number(match[2]) * 1024)
    }
  } catch {
    // The os module fallback below also works outside Linux.
  }
  return values
}

function cgroupDirectory(): string | undefined {
  try {
    const line = readFileSync("/proc/self/cgroup", "utf8")
      .split("\n")
      .find((entry) => entry.startsWith("0::"))
    if (!line) return undefined
    return join("/sys/fs/cgroup", line.slice(3))
  } catch {
    return undefined
  }
}

export function readMemoryProbe(): MemoryProbe {
  const info = memInfo()
  const group = cgroupDirectory()
  const hostAvailable = info.get("MemAvailable") ?? freemem()
  const hostSwapFree = info.get("SwapFree") ?? 0
  const groupMax = group ? numericFile(join(group, "memory.max")) : undefined
  const groupCurrent = group ? numericFile(join(group, "memory.current")) : undefined
  const groupAvailable =
    groupMax !== undefined && groupCurrent !== undefined && groupMax > groupCurrent
      ? groupMax - groupCurrent
      : undefined
  const swapMax = group ? numericFile(join(group, "memory.swap.max")) : undefined
  const swapCurrent = group ? numericFile(join(group, "memory.swap.current")) : undefined
  const groupSwapFree =
    swapMax !== undefined && swapCurrent !== undefined && swapMax > swapCurrent ? swapMax - swapCurrent : undefined

  return {
    availableBytes: Math.max(MEBIBYTE, Math.min(hostAvailable, groupAvailable ?? hostAvailable, totalmem())),
    swapFreeBytes: hostSwapFree,
    cgroupAvailableBytes: groupAvailable,
    cgroupSwapFreeBytes: groupSwapFree,
  }
}

export function calculateMemoryBudget(
  probe: MemoryProbe,
  options: { memoryFraction?: number; swapFraction?: number } = {},
): MemoryBudget | undefined {
  const memoryFraction = options.memoryFraction ?? 20
  const swapFraction = options.swapFraction ?? 25
  if (!Number.isFinite(memoryFraction) || memoryFraction <= 0 || memoryFraction > 90) return undefined
  if (!Number.isFinite(swapFraction) || swapFraction < 0 || swapFraction > 90) return undefined

  const availableBytes = Math.max(
    0,
    Math.floor(Math.min(probe.availableBytes, probe.cgroupAvailableBytes ?? Infinity)),
  )
  const memoryMaxBytes = Math.floor((availableBytes * memoryFraction) / 100)
  if (memoryMaxBytes < 64 * MEBIBYTE) return undefined

  const availableSwap = Math.max(0, Math.floor(Math.min(probe.swapFreeBytes, probe.cgroupSwapFreeBytes ?? Infinity)))
  const swapMaxBytes = Math.floor(Math.min(availableSwap, (memoryMaxBytes * swapFraction) / 100))
  return { availableBytes, memoryMaxBytes, swapMaxBytes }
}

export function executableInPath(name: string): string | undefined {
  const pathValue = process.env.PATH ?? ""
  for (const directory of pathValue.split(":").filter(Boolean)) {
    const candidate = join(directory, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue through PATH entries.
    }
  }
  return undefined
}

export const mebibyte = MEBIBYTE
