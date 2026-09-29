import { readFile } from "node:fs/promises"

export type ProcEntry = { pid: number; ppid: number; utime: number; stime: number; startTimeTicks: number; rssPages: number; comm: string; cmdline?: string }
export type ProcReader = { list: (rootPid: number) => Promise<ProcEntry[]>; pageSize: number; clockTicks: number }
export type ProcLimits = { maxProcesses: number; maxDepth: number; maxChildren: number; maxChildrenTextBytes: number }
export const DEFAULT_PROC_LIMITS: ProcLimits = { maxProcesses: 4096, maxDepth: 64, maxChildren: 512, maxChildrenTextBytes: 65536 }

/** /proc/[pid]/stat has a parenthesized comm which may itself contain spaces and ')'. */
export function parseStat(text: string, pid: number): ProcEntry | undefined {
  const open = text.indexOf("(")
  const close = text.lastIndexOf(")")
  if (open < 0 || close <= open || text[close + 1] !== " ") return undefined
  const comm = text.slice(open + 1, close)
  const fields = text.slice(close + 2).trim().split(/\s+/)
  const number = (index: number) => Number.parseInt(fields[index] ?? "", 10)
  const ppid = number(1)
  const utime = number(11)
  const stime = number(12)
  const startTimeTicks = number(19)
  const rssPages = number(21)
  if (![pid, ppid, utime, stime, startTimeTicks, rssPages].every(Number.isSafeInteger) || startTimeTicks < 0 || rssPages < 0) return undefined
  return { pid, ppid, utime, stime, startTimeTicks, rssPages, comm }
}

export function isServiceCommand(cmdline: string | undefined): boolean {
  if (!cmdline) return false
  const args = cmdline.includes("\0") ? cmdline.split("\0").filter(Boolean) : cmdline.trim().split(/\s+/).filter(Boolean)
  const executable = args[0]?.split("/").pop()
  return executable === "opencode" && args.slice(1).some((arg) => arg === "serve") && args.slice(1).some((arg) => arg === "--service")
}

export function selectProcessTree(entries: readonly ProcEntry[], rootPid: number): ProcEntry[] {
  const byParent = new Map<number, ProcEntry[]>()
  const byPid = new Map<number, ProcEntry>()
  for (const entry of entries) {
    const children = byParent.get(entry.ppid) ?? []
    children.push(entry)
    byParent.set(entry.ppid, children)
    byPid.set(entry.pid, entry)
  }
  const selected: ProcEntry[] = []
  const queue = [rootPid]
  const seen = new Set<number>()
  while (queue.length > 0) {
    const pid = queue.shift()!
    if (seen.has(pid)) continue
    seen.add(pid)
    const entry = byPid.get(pid)
    if (entry) selected.push(entry)
    for (const child of byParent.get(pid) ?? []) queue.push(child.pid)
  }
  return selected
}

export function excludeServiceSubtrees(entries: readonly ProcEntry[], servicePids: ReadonlySet<number>): ProcEntry[] {
  const byParent = new Map<number, ProcEntry[]>()
  for (const entry of entries) byParent.set(entry.ppid, [...(byParent.get(entry.ppid) ?? []), entry])
  const excluded = new Set(servicePids)
  const queue = [...servicePids]
  while (queue.length) {
    const pid = queue.shift()!
    for (const child of byParent.get(pid) ?? []) {
      if (!excluded.has(child.pid)) { excluded.add(child.pid); queue.push(child.pid) }
    }
  }
  return entries.filter((entry) => !excluded.has(entry.pid))
}

export async function createProcReader(procRoot = "/proc", limits: ProcLimits = DEFAULT_PROC_LIMITS): Promise<ProcReader> {
  // Node has no portable sysconf API; Linux's normal USER_HZ is 100 and page size is 4096.
  const pageSize = 4096
  const clockTicks = 100
  const list = async (rootPid: number): Promise<ProcEntry[]> => {
    const entries: ProcEntry[] = []
    const pending: Array<{ pid: number; depth: number }> = [{ pid: rootPid, depth: 0 }]
    const seen = new Set<number>()
    const readLive = async (path: string): Promise<string | undefined> => {
      try { return await readFile(path, "utf8") } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined
        throw error
      }
    }
    while (pending.length > 0) {
      const item = pending.shift()!
      const pid = item.pid
      if (!Number.isSafeInteger(pid) || pid <= 0 || seen.has(pid)) continue
      seen.add(pid)
      const statText = await readLive(`${procRoot}/${pid}/stat`)
      if (statText === undefined) continue
      const stat = parseStat(statText, pid)
      if (!stat) throw new Error(`malformed live proc stat: ${pid}`)
      if (entries.length >= limits.maxProcesses) throw new Error("process traversal exceeded maxProcesses")
      try { stat.cmdline = await readFile(`${procRoot}/${pid}/cmdline`, "utf8") } catch { /* cmdline can vanish */ }
      entries.push(stat)
      const childrenPath = `${procRoot}/${pid}/task/${pid}/children`
      const childrenText = await readLive(childrenPath)
      if (childrenText === undefined) throw new Error(`missing live children list: ${pid}`)
      if (childrenText.length > limits.maxChildrenTextBytes) throw new Error("children list exceeded maxChildrenTextBytes")
      const trimmed = childrenText.trim()
      const children = trimmed === "" ? [] : trimmed.split(/\s+/)
      if (children.length > limits.maxChildren) throw new Error("children list exceeded maxChildren")
      if (item.depth >= limits.maxDepth && children.length > 0) throw new Error("process traversal exceeded maxDepth")
      for (const child of children) {
        if (!/^\d+$/.test(child)) throw new Error("malformed live children list")
        const childPid = Number(child)
        if (!Number.isSafeInteger(childPid) || childPid <= 0) throw new Error("invalid live child PID")
        if (!seen.has(childPid) && pending.every((queued) => queued.pid !== childPid)) {
          if (seen.size + pending.length >= limits.maxProcesses) throw new Error("process traversal exceeded maxProcesses")
          pending.push({ pid: childPid, depth: item.depth + 1 })
        }
      }
    }
    return entries
  }
  return { list, pageSize, clockTicks }
}
