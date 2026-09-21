import { readFile } from "node:fs/promises"

export type MemoryCapacityOptions = {
  memoryReserveMiB?: unknown
  memoryPerAgentMiB?: unknown
}

export type MemoryFiles = Record<string, string | undefined>
export type MemoryReader = (path: string) => Promise<string>

const MAX_AGENTS = 3
const DEFAULT_RESERVE_MIB = 512
// Delegated sessions are remote-model orchestration overhead, not local
// compiler/browser workloads. Those remain separately bounded by the shared
// run-bounded-command wrapper.
const DEFAULT_PER_AGENT_MIB = 256
const MIB = 1024 * 1024
const MAX_CGROUP_DEPTH = 32

function positiveMiB(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1024 * 1024) {
    throw new Error(`${label} must be a positive integer MiB value`)
  }
  return value
}

function parseMemAvailable(text: string): number {
  const match = text.match(/^MemAvailable:\s+(\d+)\s+kB\s*$/m)
  if (!match) throw new Error("/proc/meminfo has no valid MemAvailable value")
  return Number(match[1]) * 1024
}

function parseBytes(text: string, label: string): number | undefined {
  const value = text.trim()
  if (value === "max") return undefined
  if (!/^\d+$/.test(value)) throw new Error(`${label} is invalid`)
  const bytes = Number(value)
  if (!Number.isSafeInteger(bytes)) throw new Error(`${label} is too large`)
  return bytes
}

export function cgroupV2Directory(cgroupText: string): string | undefined {
  const relative = cgroupRelativePath(cgroupText)
  return relative === undefined ? undefined : `/sys/fs/cgroup${relative === "/" ? "" : relative}`
}

function cgroupRelativePath(cgroupText: string): string | undefined {
  for (const line of cgroupText.split("\n")) {
    const fields = line.split(":")
    if (fields.length !== 3 || fields[1] !== "") continue
    const relative = fields[2] || "/"
    const parts = relative.split("/").filter(Boolean)
    if (parts.length > MAX_CGROUP_DEPTH || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))) throw new Error("cgroup path is unsafe or over-bound")
    return parts.length === 0 ? "/" : `/${parts.join("/")}`
  }
  return undefined
}

function cgroupAncestors(relative: string): string[] {
  const parts = relative.split("/").filter(Boolean)
  if (parts.length > MAX_CGROUP_DEPTH) throw new Error("cgroup ancestry is over-bound")
  const paths: string[] = []
  for (let length = parts.length; length >= 0; length -= 1) {
    paths.push(`/sys/fs/cgroup${length === 0 ? "" : `/${parts.slice(0, length).join("/")}`}`)
  }
  return paths
}

export function createMemoryCapacityEvaluator(options: MemoryCapacityOptions = {}, reader: MemoryReader = (path) => readFile(path, "utf8")) {
  let reserveMiB = DEFAULT_RESERVE_MIB
  let perAgentMiB = DEFAULT_PER_AGENT_MIB
  let configError: string | undefined
  try {
    reserveMiB = positiveMiB(options.memoryReserveMiB, DEFAULT_RESERVE_MIB, "memoryReserveMiB")
    perAgentMiB = positiveMiB(options.memoryPerAgentMiB, DEFAULT_PER_AGENT_MIB, "memoryPerAgentMiB")
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error)
  }

  return async function memoryCapacity(requestedAgents: number) {
    const requested = Number.isInteger(requestedAgents) ? requestedAgents : 0
    if (requested < 1 || requested > MAX_AGENTS) throw new Error(`requestedAgents must be an integer from 1 through ${MAX_AGENTS}`)
    if (configError) {
      return { requestedAgents: requested, approvedCount: 1, recommendedCount: 1, limitingSource: "invalid-metrics-or-configuration", evidence: { safeSerialFallback: true, detail: configError } }
    }
    try {
      const meminfo = await reader("/proc/meminfo")
      const hostAvailableBytes = parseMemAvailable(meminfo)
      const swapMatch = meminfo.match(/^SwapFree:\s+(\d+)\s+kB\s*$/m)
      const hostSwapBytes = swapMatch ? Number(swapMatch[1]) * 1024 : undefined
      let limitBytes: number | undefined
      let currentBytes: number | undefined
      let cgroupAvailableBytes: number | undefined
      let limitingCgroupPath: string | undefined
      let cgroupSwapBytes: number | undefined
      let cgroupConfigured = false
      let sawLeafMemoryMax = false
      try {
        const cgroupText = await reader("/proc/self/cgroup")
        const relative = cgroupRelativePath(cgroupText)
        if (relative) {
          cgroupConfigured = true
          const ancestors = cgroupAncestors(relative)
          let leafMax: number | undefined
          for (const [index, directory] of ancestors.entries()) {
            let maxText: string
            try { maxText = await reader(`${directory}/memory.max`) } catch (error) {
              if (index === 0) throw error
              throw new Error(`missing ancestor cgroup memory.max: ${directory}`)
            }
            const max = parseBytes(maxText, `${directory}/memory.max`)
            if (index === 0) sawLeafMemoryMax = true
            if (index === 0) leafMax = max
            if (max === undefined) continue
            let current: number
            try { current = parseBytes(await reader(`${directory}/memory.current`), `${directory}/memory.current`) ?? NaN } catch {
              throw new Error(`invalid ancestor cgroup memory.current: ${directory}`)
            }
            if (!Number.isSafeInteger(current) || current < 0) throw new Error(`invalid ancestor cgroup memory.current: ${directory}`)
            const available = Math.max(0, max - current)
            if (current > max) throw new Error(`inconsistent ancestor cgroup memory.current: ${directory}`)
            if (cgroupAvailableBytes === undefined || available < cgroupAvailableBytes) {
              cgroupAvailableBytes = available
              limitingCgroupPath = directory
              limitBytes = max
              currentBytes = current
            }
          }
          if (leafMax === undefined && cgroupAvailableBytes === undefined) {
            // An unlimited leaf is valid; finite ancestors above it still win.
          }
          let swapSeen = false
          for (const [index, directory] of ancestors.entries()) {
            let swapMaxText: string
            try { swapMaxText = await reader(`${directory}/memory.swap.max`) } catch (error) {
              if (index === 0) break
              if (swapSeen) throw new Error(`missing ancestor cgroup memory.swap.max: ${directory}`)
              break
            }
            swapSeen = true
            const swapMax = parseBytes(swapMaxText, `${directory}/memory.swap.max`)
            if (swapMax === undefined) continue
            const swapCurrent = parseBytes(await reader(`${directory}/memory.swap.current`), `${directory}/memory.swap.current`)
            if (swapCurrent === undefined) throw new Error(`invalid ancestor cgroup memory.swap.current: ${directory}`)
            const available = Math.max(0, swapMax - swapCurrent)
            if (swapCurrent > swapMax) throw new Error(`inconsistent ancestor cgroup memory.swap.current: ${directory}`)
            cgroupSwapBytes = cgroupSwapBytes === undefined ? available : Math.min(cgroupSwapBytes, available)
          }
        }
      } catch {
        // A completely unavailable cgroup mount may use host metrics. Once a
        // cgroup limit is visible, malformed/incomplete ancestry fails closed.
        if (cgroupConfigured && sawLeafMemoryMax) throw new Error("invalid cgroup ancestry metrics")
        limitBytes = undefined
        currentBytes = undefined
        cgroupAvailableBytes = undefined
        limitingCgroupPath = undefined
        cgroupSwapBytes = undefined
      }
      const effectiveAvailableBytes = cgroupAvailableBytes === undefined
        ? hostAvailableBytes
        : Math.min(hostAvailableBytes, cgroupAvailableBytes)
      const budgetBytes = Math.max(0, effectiveAvailableBytes - reserveMiB * MIB)
      const capacity = Math.min(MAX_AGENTS, Math.floor(budgetBytes / (perAgentMiB * MIB)))
      const recommended = Math.min(requested, capacity)
      const effectiveSwapBytes = hostSwapBytes === undefined
        ? cgroupSwapBytes
        : cgroupSwapBytes === undefined ? hostSwapBytes : Math.min(hostSwapBytes, cgroupSwapBytes)
      const limitingSource = cgroupAvailableBytes !== undefined && cgroupAvailableBytes <= hostAvailableBytes ? "cgroup-v2" : "host-MemAvailable"
      return {
        requestedAgents: requested,
        approvedCount: recommended,
        recommendedCount: recommended,
        limitingSource,
        evidence: {
          hostAvailableBytes,
          hostAvailableMiB: Math.floor(hostAvailableBytes / MIB),
          cgroupLimitBytes: limitBytes ?? null,
          cgroupCurrentBytes: currentBytes ?? null,
          cgroupAvailableBytes: cgroupAvailableBytes ?? null,
          limitingCgroupPath: limitingCgroupPath ?? null,
          hostSwapBytes: hostSwapBytes ?? null,
          cgroupSwapBytes: cgroupSwapBytes ?? null,
          effectiveSwapBytes,
          reserveBytes: reserveMiB * MIB,
          perAgentBytes: perAgentMiB * MIB,
          effectiveAvailableBytes,
          effectiveAvailableMiB: Math.floor(effectiveAvailableBytes / MIB),
        },
      }
    } catch (error) {
      return {
        requestedAgents: requested,
        approvedCount: 1,
        recommendedCount: 1,
        limitingSource: "invalid-metrics-or-configuration",
        evidence: { safeSerialFallback: true, detail: error instanceof Error ? error.message : String(error) },
      }
    }
  }
}
