import type { ProcEntry, ProcReader } from "./proc.ts"
import { excludeServiceSubtrees, isServiceCommand, selectProcessTree } from "./proc.ts"

export type ResourceSnapshot = { cpuPercent?: number; rssBytes: number; processCount: number }
type ProcessSample = { startTimeTicks: number; ticks: number }
export type ResourceSample = { at: number; processes: ReadonlyMap<number, ProcessSample>; rssBytes: number; processCount: number }

export function sampleResources(entries: readonly ProcEntry[], rootPid: number, previous: ResourceSample | undefined, now: number, reader: Pick<ProcReader, "pageSize" | "clockTicks">): { sample: ResourceSample; snapshot: ResourceSnapshot } {
  const tree = selectProcessTree(entries, rootPid)
  const servicePids = new Set(tree.filter((entry) => isServiceCommand(entry.cmdline)).map((entry) => entry.pid))
  const included = excludeServiceSubtrees(tree, servicePids)
  const processes = new Map(included.map((entry) => [entry.pid, { startTimeTicks: entry.startTimeTicks, ticks: entry.utime + entry.stime }]))
  let comparableProcesses = 0
  const deltaTicks = previous
    ? [...processes].reduce((sum, [pid, currentProcess]) => {
      const old = previous.processes.get(pid)
      if (old?.startTimeTicks !== currentProcess.startTimeTicks || currentProcess.ticks < old.ticks) return sum
      comparableProcesses++
      return sum + currentProcess.ticks - old.ticks
    }, 0)
    : 0
  const current: ResourceSample = {
    at: now,
    processes,
    rssBytes: included.reduce((sum, entry) => sum + entry.rssPages * reader.pageSize, 0),
    processCount: included.length,
  }
  const elapsed = previous ? now - previous.at : 0
  const cpuPercent = previous && comparableProcesses > 0 && elapsed > 0 && deltaTicks >= 0 ? deltaTicks / reader.clockTicks / (elapsed / 1000) * 100 : undefined
  return { sample: current, snapshot: { cpuPercent, rssBytes: included.length === 0 ? Number.NaN : current.rssBytes, processCount: current.processCount } }
}

export function createResourceMonitor(reader: ProcReader, rootPid: number, intervalMs: number, onSnapshot: (snapshot: ResourceSnapshot) => void) {
  let previous: ResourceSample | undefined
  let stopped = false
  let running = false
  const tick = async () => {
    if (stopped || running) return
    running = true
    try {
      const entries = await reader.list(rootPid)
      if (stopped) return
      const result = sampleResources(entries, rootPid, previous, Date.now(), reader)
      previous = result.sample
      onSnapshot(result.snapshot)
    } catch {
      // A failed /proc scan is transient. Keep the previous visible sample and
      // try again at the next bounded interval.
    } finally {
      running = false
    }
  }
  void tick()
  const timer = setInterval(() => void tick(), intervalMs)
  return () => { stopped = true; clearInterval(timer) }
}
