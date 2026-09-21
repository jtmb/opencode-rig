import { open, statfs } from "node:fs/promises"

export type FilesystemUsage = { mount: string; totalBytes: number; usedBytes: number; availableBytes: number }
export type SystemSnapshot = {
  cpuModel: string
  logicalCores: number
  physicalCores?: number
  cpuPercent?: number
  memoryTotalBytes?: number
  memoryUsedBytes?: number
  memoryAvailableBytes?: number
  swapTotalBytes?: number
  swapUsedBytes?: number
  filesystems: FilesystemUsage[]
}

export type SystemReader = { read: () => Promise<SystemSnapshot> }
type CpuSample = { idle: number; total: number }

const MAX_MOUNTS = 12
const MAX_TEXT = 256
const MAX_PROC_BYTES = 1_048_576
const PROC_READ_CHUNK_BYTES = 65_536
const REMOTE_TYPES = new Set(["autofs", "cifs", "nfs", "nfs4", "smbfs", "sshfs", "fuse.sshfs"])
const VIRTUAL_TYPES = new Set(["autofs", "binfmt_misc", "bpf", "cgroup", "cgroup2", "configfs", "debugfs", "devpts", "devtmpfs", "efivarfs", "fuse.gvfsd-fuse", "fuse.portal", "fusectl", "hugetlbfs", "mqueue", "nsfs", "proc", "pstore", "rpc_pipefs", "securityfs", "squashfs", "sysfs", "tmpfs", "tracefs"])

const finite = (value: number | undefined) => value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined
const boundedText = (value: string, fallback: string) => {
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT)
  return clean || fallback
}

export function parseCpuInfo(text: string): { model: string; logicalCores: number; physicalCores?: number } {
  const model = text.match(/^model name\s*:\s*(.+)$/m)?.[1] ?? text.match(/^Hardware\s*:\s*(.+)$/m)?.[1] ?? "Unknown CPU"
  const logical = Math.max(1, text.split(/^processor\s*:/m).length - 1)
  const physical = new Set<string>()
  const blocks = text.split(/^processor\s*:/m).slice(1)
  for (const block of blocks) {
    const physicalId = block.match(/^physical id\s*:\s*(\d+)/m)?.[1]
    const coreId = block.match(/^core id\s*:\s*(\d+)/m)?.[1]
    if (physicalId !== undefined && coreId !== undefined) physical.add(`${physicalId}:${coreId}`)
  }
  return { model: boundedText(model, "Unknown CPU"), logicalCores: logical, physicalCores: physical.size || undefined }
}

export function parseCpuStat(text: string): CpuSample | undefined {
  const fields = text.match(/^cpu\s+(.+)$/m)?.[1]?.trim().split(/\s+/).map(Number)
  if (!fields || fields.length < 4 || fields.some((value) => !Number.isFinite(value) || value < 0)) return undefined
  return { idle: fields[3] + (fields[4] ?? 0), total: fields.reduce((sum, value) => sum + value, 0) }
}

export function cpuPercent(previous: CpuSample | undefined, current: CpuSample | undefined): number | undefined {
  if (!previous || !current) return undefined
  const total = current.total - previous.total
  const idle = current.idle - previous.idle
  return total > 0 && idle >= 0 && idle <= total ? Math.min(100, Math.max(0, (1 - idle / total) * 100)) : undefined
}

export function parseMemInfo(text: string): Pick<SystemSnapshot, "memoryTotalBytes" | "memoryUsedBytes" | "memoryAvailableBytes" | "swapTotalBytes" | "swapUsedBytes"> {
  const values = new Map<string, number>()
  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Za-z_]+):\s+(\d+)\s*(kB)?/)
    if (match) values.set(match[1], Number(match[2]) * (match[3] ? 1024 : 1))
  }
  const total = finite(values.get("MemTotal")); const available = finite(values.get("MemAvailable"))
  const swapTotal = finite(values.get("SwapTotal")); const swapFree = finite(values.get("SwapFree"))
  return { memoryTotalBytes: total, memoryAvailableBytes: available, memoryUsedBytes: total !== undefined && available !== undefined ? Math.max(0, total - available) : undefined, swapTotalBytes: swapTotal, swapUsedBytes: swapTotal !== undefined && swapFree !== undefined ? Math.max(0, swapTotal - swapFree) : undefined }
}

export function localMounts(text: string): string[] {
  const mounts: string[] = []
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 3) continue
    const type = fields[2]
    const mount = fields[1].replace(/\\040/g, " ").replace(/\\011/g, "\t").replace(/\\134/g, "\\")
    if (!mount.startsWith("/") || REMOTE_TYPES.has(type) || VIRTUAL_TYPES.has(type) || mounts.includes(mount)) continue
    mounts.push(mount)
    if (mounts.length >= MAX_MOUNTS) break
  }
  return mounts.length ? mounts : ["/"]
}

type ReadHandle = Pick<Awaited<ReturnType<typeof open>>, "read" | "close">

export async function readBoundedText(path: string, opener: (path: string, flags: string) => Promise<ReadHandle> = open): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await opener(path, "r") as Awaited<ReturnType<typeof open>>
    const chunks: Buffer[] = []
    let total = 0
    while (total <= MAX_PROC_BYTES) {
      const buffer = Buffer.alloc(Math.min(PROC_READ_CHUNK_BYTES, MAX_PROC_BYTES + 1 - total))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead <= 0) break
      chunks.push(buffer.subarray(0, bytesRead))
      total += bytesRead
    }
    if (total > MAX_PROC_BYTES) return ""
    return Buffer.concat(chunks, total).toString("utf8")
  } catch {
    return ""
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function filesystem(path: string): Promise<FilesystemUsage | undefined> {
  try {
    const info = await statfs(path)
    const total = Number(info.blocks) * Number(info.bsize)
    const free = Number(info.bfree) * Number(info.bsize)
    const available = Number(info.bavail) * Number(info.bsize)
    if (!Number.isSafeInteger(total) || !Number.isSafeInteger(free) || !Number.isSafeInteger(available) || total < 0 || free < 0 || available < 0) return undefined
    return { mount: boundedText(path, "/"), totalBytes: total, usedBytes: Math.max(0, total - free), availableBytes: available }
  } catch { return undefined }
}

export function createSystemReader(procRoot = "/proc"): SystemReader {
  let previousCpu: CpuSample | undefined
  return { read: async () => {
    const [cpuInfo, cpuStat, memInfo, mounts] = await Promise.all([
      readBoundedText(`${procRoot}/cpuinfo`),
      readBoundedText(`${procRoot}/stat`),
      readBoundedText(`${procRoot}/meminfo`),
      readBoundedText(`${procRoot}/mounts`),
    ])
    const currentCpu = parseCpuStat(cpuStat)
    const cpu = parseCpuInfo(cpuInfo)
    const snapshot: SystemSnapshot = { cpuModel: cpu.model, logicalCores: cpu.logicalCores, physicalCores: cpu.physicalCores, ...parseMemInfo(memInfo), cpuPercent: cpuPercent(previousCpu, currentCpu), filesystems: (await Promise.all(localMounts(mounts).map(filesystem))).filter((item): item is FilesystemUsage => item !== undefined) }
    previousCpu = currentCpu
    return snapshot
  } }
}
