import { readdir, readFile, statfs } from "node:fs/promises"
import { cpus, freemem, loadavg, totalmem } from "node:os"
import { basename } from "node:path"
import { performance } from "node:perf_hooks"

type ProcEntry = {
  pid: number
  ppid: number
  ticks: number
  startTimeTicks: number
  rssBytes: number
  comm: string
  args?: string[]
}

export type OpenCodeProcessRole = "tui" | "service" | "server" | "standalone"

const MAX_PROCESSES = 4096
const MAX_CMDLINE_BYTES = 65_536
const PAGE_SIZE = 4096
const CLOCK_TICKS = 100
const SAMPLE_MS = 120
const PROC_READ_CONCURRENCY = 32
const MAX_OPENCODE_INSTANCES = 64

function safeNumber(value: string | undefined) {
  const result = Number.parseInt(value ?? "", 10)
  return Number.isSafeInteger(result) ? result : undefined
}

export function parseProcStat(text: string, pid: number): ProcEntry | undefined {
  const open = text.indexOf("(")
  const close = text.lastIndexOf(")")
  if (open < 0 || close <= open || text[close + 1] !== " ") return undefined
  const fields = text.slice(close + 2).trim().split(/\s+/)
  const ppid = safeNumber(fields[1])
  const utime = safeNumber(fields[11])
  const stime = safeNumber(fields[12])
  const startTimeTicks = safeNumber(fields[19])
  const rssPages = safeNumber(fields[21])
  if ([ppid, utime, stime, startTimeTicks, rssPages].some((value) => value === undefined)) return undefined
  if (pid <= 0 || ppid! < 0 || utime! < 0 || stime! < 0 || startTimeTicks! < 0 || rssPages! < 0) return undefined
  return {
    pid,
    ppid: ppid!,
    ticks: utime! + stime!,
    startTimeTicks: startTimeTicks!,
    rssBytes: rssPages! * PAGE_SIZE,
    comm: text.slice(open + 1, close).slice(0, 256),
  }
}

export function classifyOpenCodeArgs(args: readonly string[]): OpenCodeProcessRole {
  if (args.includes("serve") && args.includes("--service")) return "service"
  if (args.includes("serve")) return "server"
  if (args.includes("--standalone")) return "standalone"
  return "tui"
}

function isOpenCode(entry: ProcEntry) {
  return entry.comm === "opencode" || basename(entry.args?.[0] ?? "") === "opencode"
}

async function boundedCmdline(path: string): Promise<string[]> {
  try {
    const raw = await readFile(path)
    if (raw.byteLength > MAX_CMDLINE_BYTES) return []
    return raw.toString("utf8").split("\0").filter(Boolean).slice(0, 128)
  } catch {
    return []
  }
}

async function mapConcurrent<T, R>(values: readonly T[], concurrency: number, operation: (value: T) => Promise<R>) {
  const results = new Array<R>(values.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++
      results[index] = await operation(values[index]!)
    }
  }))
  return results
}

async function scanProc(procRoot = "/proc") {
  const names = (await readdir(procRoot)).filter((name) => /^\d+$/.test(name))
  if (names.length > MAX_PROCESSES) throw new Error(`process table exceeds the ${MAX_PROCESSES} entry bound`)
  const entries = (
    await mapConcurrent(names, PROC_READ_CONCURRENCY, async (name) => {
      const pid = Number(name)
      try {
        return parseProcStat(await readFile(`${procRoot}/${name}/stat`, "utf8"), pid)
      } catch {
        return undefined
      }
    })
  ).filter((entry): entry is ProcEntry => entry !== undefined)
  await mapConcurrent(entries.filter((entry) => entry.comm === "opencode"), PROC_READ_CONCURRENCY, async (entry) => {
    entry.args = await boundedCmdline(`${procRoot}/${entry.pid}/cmdline`)
  })
  return entries
}

function processTree(entries: readonly ProcEntry[], rootPid: number, excludedRoots: ReadonlySet<number>) {
  const byParent = new Map<number, ProcEntry[]>()
  const byPid = new Map(entries.map((entry) => [entry.pid, entry]))
  for (const entry of entries) byParent.set(entry.ppid, [...(byParent.get(entry.ppid) ?? []), entry])
  const result: ProcEntry[] = []
  const queue = [rootPid]
  const seen = new Set<number>()
  while (queue.length > 0 && result.length <= MAX_PROCESSES) {
    const pid = queue.shift()!
    if (seen.has(pid) || (pid !== rootPid && excludedRoots.has(pid))) continue
    seen.add(pid)
    const entry = byPid.get(pid)
    if (!entry) continue
    result.push(entry)
    for (const child of byParent.get(pid) ?? []) queue.push(child.pid)
  }
  if (result.length > MAX_PROCESSES) throw new Error("OpenCode process tree exceeded its bound")
  return result
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

function bytes(value: number) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

async function storage(directory: string) {
  const value = await statfs(directory)
  const blockSize = Number(value.bsize)
  const totalBytes = Number(value.blocks) * blockSize
  const freeBytes = Number(value.bfree) * blockSize
  const availableBytes = Number(value.bavail) * blockSize
  if ([totalBytes, freeBytes, availableBytes].some((item) => bytes(item) === undefined)) {
    throw new Error("filesystem metrics exceed safe numeric bounds")
  }
  return { totalBytes, usedBytes: totalBytes - freeBytes, availableBytes }
}

export function analyzeUsage(snapshot: {
  host: {
    logicalCores: number
    loadAverage: number[]
    memoryTotalBytes: number
    memoryAvailableBytes: number
    swapTotalBytes?: number
    swapUsedBytes?: number
  }
  storage: { totalBytes: number; availableBytes: number }
  instances: Array<{ pid: number; cpuPercent: number; rssBytes: number }>
}) {
  const findings: string[] = []
  const aggregateRssBytes = snapshot.instances.reduce((sum, instance) => sum + instance.rssBytes, 0)
  if (snapshot.host.logicalCores > 0 && (snapshot.host.loadAverage[0] ?? 0) >= snapshot.host.logicalCores * 1.25) {
    findings.push("Host one-minute load is at least 1.25 times the logical CPU count.")
  }
  if (snapshot.host.memoryTotalBytes > 0 && snapshot.host.memoryAvailableBytes / snapshot.host.memoryTotalBytes < 0.1) {
    findings.push("Host available memory is below 10%.")
  }
  if (snapshot.host.memoryTotalBytes > 0 && aggregateRssBytes / snapshot.host.memoryTotalBytes >= 0.25) {
    findings.push("OpenCode process trees are using at least 25% of host memory as RSS.")
  }
  if ((snapshot.host.swapTotalBytes ?? 0) > 0 && (snapshot.host.swapUsedBytes ?? 0) / snapshot.host.swapTotalBytes! > 0.5) {
    findings.push("Host swap use is above 50%.")
  }
  if (snapshot.storage.totalBytes > 0 && snapshot.storage.availableBytes / snapshot.storage.totalBytes < 0.1) {
    findings.push("Project filesystem available space is below 10%.")
  }
  for (const instance of snapshot.instances) {
    if (instance.rssBytes >= 1024 ** 3) findings.push(`OpenCode PID ${instance.pid} is using at least 1 GiB RSS.`)
    if (instance.cpuPercent >= 200) findings.push(`OpenCode PID ${instance.pid} is using at least two logical CPUs.`)
  }
  return findings.length > 0 ? findings : ["No immediate OpenCode CPU, memory, swap, or storage pressure threshold was crossed."]
}

export function createSelfUsageAnalyzer(directory: string, procRoot = "/proc") {
  return async () => {
    const beforeAt = performance.now()
    const before = await scanProc(procRoot)
    await delay(SAMPLE_MS)
    const after = await scanProc(procRoot)
    const elapsedSeconds = Math.max(0.001, (performance.now() - beforeAt) / 1000)
    const beforeByPid = new Map(before.map((entry) => [entry.pid, entry]))
    const allOpenCode = after.filter(isOpenCode)
    const opencode = allOpenCode.slice(0, MAX_OPENCODE_INSTANCES)
    const servicePids = new Set(opencode.filter((entry) => classifyOpenCodeArgs(entry.args ?? []) === "service").map((entry) => entry.pid))
    const instances = opencode.map((root) => {
      const role = classifyOpenCodeArgs(root.args ?? [])
      const tree = processTree(after, root.pid, role === "tui" || role === "standalone" ? servicePids : new Set())
      let tickDelta = 0
      for (const entry of tree) {
        const previous = beforeByPid.get(entry.pid)
        if (previous?.startTimeTicks === entry.startTimeTicks) tickDelta += Math.max(0, entry.ticks - previous.ticks)
      }
      return {
        pid: root.pid,
        role,
        currentServer: root.pid === process.pid,
        processCount: tree.length,
        cpuPercent: Math.round((tickDelta / CLOCK_TICKS / elapsedSeconds) * 10_000) / 100,
        rssBytes: tree.reduce((sum, entry) => sum + entry.rssBytes, 0),
      }
    })

    let memoryAvailableBytes = freemem()
    let memorySource = "node-freemem"
    let swapTotalBytes: number | undefined
    let swapUsedBytes: number | undefined
    try {
      const meminfo = await readFile(`${procRoot}/meminfo`, "utf8")
      const values = new Map<string, number>()
      for (const line of meminfo.split("\n")) {
        const match = line.match(/^([A-Za-z_]+):\s+(\d+)\s+kB$/)
        if (match) values.set(match[1], Number(match[2]) * 1024)
      }
      if (values.has("MemAvailable")) {
        memoryAvailableBytes = values.get("MemAvailable")!
        memorySource = "proc-meminfo"
      }
      swapTotalBytes = values.get("SwapTotal")
      const swapFree = values.get("SwapFree")
      if (swapTotalBytes !== undefined && swapFree !== undefined) swapUsedBytes = Math.max(0, swapTotalBytes - swapFree)
    } catch {
      // Swap remains explicitly unavailable.
    }
    const host = {
      logicalCores: cpus().length,
      cpuModel: cpus()[0]?.model?.slice(0, 256) ?? "unknown",
      loadAverage: loadavg(),
      memoryTotalBytes: totalmem(),
      memoryAvailableBytes,
      memorySource,
      ...(swapTotalBytes !== undefined ? { swapTotalBytes } : {}),
      ...(swapUsedBytes !== undefined ? { swapUsedBytes } : {}),
    }
    const filesystem = await storage(directory)
    const result = {
      sampledAt: Date.now(),
      sampleMilliseconds: Math.round(elapsedSeconds * 1000),
      currentServerPID: process.pid,
      directory,
      instances,
      instancesTruncated: allOpenCode.length > MAX_OPENCODE_INSTANCES,
      totals: {
        processCount: instances.reduce((sum, value) => sum + value.processCount, 0),
        cpuPercent: Math.round(instances.reduce((sum, value) => sum + value.cpuPercent, 0) * 100) / 100,
        rssBytes: instances.reduce((sum, value) => sum + value.rssBytes, 0),
      },
      host,
      storage: filesystem,
      bounds: {
        maximumProcesses: MAX_PROCESSES,
        maximumOpenCodeInstances: MAX_OPENCODE_INSTANCES,
        processReadConcurrency: PROC_READ_CONCURRENCY,
        commandLineBytes: MAX_CMDLINE_BYTES,
      },
    }
    return { ...result, analysis: analyzeUsage({ host, storage: filesystem, instances }) }
  }
}
