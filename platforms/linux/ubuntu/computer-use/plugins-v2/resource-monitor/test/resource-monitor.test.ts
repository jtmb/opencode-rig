import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProcReader, parseStat, isServiceCommand, selectProcessTree, excludeServiceSubtrees, type ProcEntry } from "../src/proc.ts"
import { createResourceMonitor, sampleResources } from "../src/monitor.ts"
import { footerText, formatMiB, resourceTone } from "../src/format.ts"
import { dialogContentWidth, isPrimaryMouseButton, openPanelOrFallback, registerResourceFooterSlots, RESOURCE_FOOTER_SLOTS } from "../src/registration.ts"
import { DEFAULT_INTERVAL_MS, MAX_INTERVAL_MS, MIN_INTERVAL_MS, normalizeIntervalMs } from "../src/options.ts"
import { cpuPercent, localMounts, parseCpuInfo, parseCpuStat, parseMemInfo, readBoundedText } from "../src/system.ts"

const entry = (pid: number, ppid: number, ticks: number, rssPages: number, cmdline?: string, startTimeTicks = pid): ProcEntry => ({ pid, ppid, utime: ticks, stime: 0, startTimeTicks, rssPages, comm: "node", cmdline })
const stat = (pid: number, comm: string, ppid: number, ticks: number, rssPages: number) =>
  `${pid} (${comm}) ${["S", String(ppid), ...Array(9).fill("0"), String(ticks), "0", ...Array(8).fill("0"), String(rssPages)].join(" ")}`

const tuiSource = await readFile(new URL("../src/tui.tsx", import.meta.url), "utf8")

test("the focused system panel owns Escape before the host can consume it", () => {
  assert.match(tuiSource, /useKeyboard\(\(key\) => \{/)
  assert.match(tuiSource, /if \(!props\.panel\.focused \|\| key\.name !== "escape"\) return/)
  assert.match(tuiSource, /key\.stopPropagation\(\)/)
})

test("parses stat comm fields containing spaces and parentheses", () => {
  const fields = ["S", "41", ...Array(9).fill("0"), "123", "7", ...Array(8).fill("0"), "99"]
  const parsed = parseStat("42 (worker with ) parens) " + fields.join(" "), 42)
  assert.deepEqual(parsed, { pid: 42, ppid: 41, utime: 123, stime: 7, startTimeTicks: 0, rssPages: 99, comm: "worker with ) parens" })
})

test("selects only a root tree and excludes a service subtree", () => {
  const service = "opencode\0serve\0--service\0"
  const all = [entry(10, 1, 0, 1), entry(11, 10, 0, 2), entry(12, 10, 0, 3, service), entry(13, 12, 0, 4), entry(14, 13, 0, 5), entry(20, 1, 0, 6), entry(21, 20, 0, 7)]
  assert.deepEqual(selectProcessTree(all, 10).map((item) => item.pid), [10, 11, 12, 13, 14])
  assert.deepEqual(excludeServiceSubtrees(selectProcessTree(all, 10), new Set([12])).map((item) => item.pid), [10, 11])
  assert.deepEqual(selectProcessTree(all, 20).map((item) => item.pid), [20, 21])
  assert.equal(isServiceCommand(service), true)
  assert.equal(isServiceCommand("opencode\0serve\0"), false)
})

test("recognizes only OpenCode service commands for subtree exclusion", () => {
  assert.equal(isServiceCommand("/home/user/bin/opencode\0serve\0--service\0"), true)
  assert.equal(isServiceCommand("opencode --log-level warn serve --service"), true)
  assert.equal(isServiceCommand("node\0script.js\0serve\0--service\0"), false)
  assert.equal(isServiceCommand("/tmp/opencode-helper\0serve\0--service\0"), false)
  assert.equal(isServiceCommand("opencode\0serve\0"), false)
})

test("computes rolling CPU deltas and RSS without capping multicore CPU", () => {
  const reader = { pageSize: 4096, clockTicks: 100 }
  const first = sampleResources([entry(10, 1, 100, 10)], 10, undefined, 1000, reader)
  const second = sampleResources([entry(10, 1, 500, 20)], 10, first.sample, 2000, reader)
  assert.equal(first.snapshot.cpuPercent, undefined)
  assert.equal(second.snapshot.cpuPercent, 400)
  assert.equal(second.snapshot.rssBytes, 20 * 4096)
})

test("normalizes only bounded finite integer polling intervals", () => {
  assert.equal(normalizeIntervalMs(MIN_INTERVAL_MS), MIN_INTERVAL_MS)
  assert.equal(normalizeIntervalMs(MAX_INTERVAL_MS), MAX_INTERVAL_MS)
  assert.equal(normalizeIntervalMs(MIN_INTERVAL_MS - 1), DEFAULT_INTERVAL_MS)
  assert.equal(normalizeIntervalMs(MAX_INTERVAL_MS + 1), DEFAULT_INTERVAL_MS)
  assert.equal(normalizeIntervalMs(1000.5), DEFAULT_INTERVAL_MS)
  assert.equal(normalizeIntervalMs(Number.MAX_SAFE_INTEGER), DEFAULT_INTERVAL_MS)
  assert.equal(normalizeIntervalMs(Infinity), DEFAULT_INTERVAL_MS)
  assert.equal(normalizeIntervalMs("2000"), DEFAULT_INTERVAL_MS)
})

test("keeps multiple TUI roots isolated and ignores reused or vanished processes", () => {
  const reader = { pageSize: 4096, clockTicks: 100 }
  const firstA = sampleResources([entry(10, 1, 100, 1), entry(11, 10, 100, 2)], 10, undefined, 1000, reader)
  const secondA = sampleResources([entry(10, 1, 200, 2), entry(11, 10, 1, 3, undefined, 999)], 10, firstA.sample, 2000, reader)
  const firstB = sampleResources([entry(20, 1, 500, 4)], 20, undefined, 1000, reader)
  assert.equal(secondA.snapshot.cpuPercent, 100)
  assert.equal(secondA.snapshot.processCount, 2)
  assert.equal(firstB.snapshot.rssBytes, 4 * 4096)
})

test("formats units, footer text, and restrained thresholds", () => {
  const normal = { cpuPercent: 7, rssBytes: 371 * 1024 * 1024, processCount: 1 }
  assert.equal(formatMiB(normal.rssBytes), "371 MiB")
  assert.equal(footerText(normal), "CPU 7% · RAM 371 MiB")
  assert.equal(resourceTone(normal), "normal")
  assert.equal(resourceTone({ ...normal, cpuPercent: 80 }), "warning")
  assert.equal(resourceTone({ ...normal, rssBytes: 2 * 1024 ** 3 }), "error")
})

test("missing and vanished data is safe", () => {
  assert.equal(parseStat("bad", 3), undefined)
  const result = sampleResources([], 3, undefined, 1, { pageSize: 4096, clockTicks: 100 })
  assert.equal(Number.isNaN(result.snapshot.rssBytes), true)
  assert.equal(footerText(result.snapshot), "CPU ?% · RAM ? MiB")
  const recovered = sampleResources([entry(3, 1, 5, 1)], 3, result.sample, 1001, { pageSize: 4096, clockTicks: 100 })
  assert.equal(recovered.snapshot.cpuPercent, undefined)
})

test("proc reader walks only descendants, tolerates vanished children, and rejects malformed live children", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-rig-resource-monitor-"))
  try {
    for (const pid of [10, 11]) await mkdir(join(root, String(pid), "task", String(pid)), { recursive: true })
    await writeFile(join(root, "10", "stat"), stat(10, "opencode", 1, 20, 4))
    await writeFile(join(root, "10", "cmdline"), "opencode\0tui\0")
    await writeFile(join(root, "10", "task", "10", "children"), "11 12\n")
    await writeFile(join(root, "11", "stat"), stat(11, "worker", 10, 5, 2))
    await writeFile(join(root, "11", "task", "11", "children"), "")
    await mkdir(join(root, "12", "task", "12"), { recursive: true })
    await writeFile(join(root, "12", "stat"), "malformed proc stat")
    const reader = await createProcReader(root)
    await assert.rejects(reader.list(10), /malformed live proc stat/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("proc traversal accepts the exact process bound and rejects one over", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-rig-resource-monitor-bound-"))
  try {
    for (const pid of [10, 11, 12]) {
      await mkdir(join(root, String(pid), "task", String(pid)), { recursive: true })
      await writeFile(join(root, String(pid), "stat"), stat(pid, `worker ${pid}`, pid === 10 ? 1 : 10, 1, 1))
      await writeFile(join(root, String(pid), "task", String(pid), "children"), pid === 10 ? "11 12\n" : "")
    }
    const exact = await createProcReader(root, { maxProcesses: 3, maxDepth: 4, maxChildren: 4, maxChildrenTextBytes: 100 })
    assert.equal((await exact.list(10)).length, 3)
    await assert.rejects(createProcReader(root, { maxProcesses: 2, maxDepth: 4, maxChildren: 4, maxChildrenTextBytes: 100 }).then((reader) => reader.list(10)), /maxProcesses/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("malformed and overlong live child lists fail rather than filter tokens", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-rig-resource-monitor-children-"))
  try {
    await mkdir(join(root, "10", "task", "10"), { recursive: true })
    await writeFile(join(root, "10", "stat"), stat(10, "root", 1, 1, 1))
    await writeFile(join(root, "10", "task", "10", "children"), "11 nope\n")
    const reader = await createProcReader(root)
    await assert.rejects(reader.list(10), /malformed live children list/)
    await writeFile(join(root, "10", "task", "10", "children"), "11 ".repeat(5))
    await assert.rejects((await createProcReader(root, { maxProcesses: 8, maxDepth: 4, maxChildren: 2, maxChildrenTextBytes: 100 })).list(10), /maxChildren/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("stops its timer and ignores an in-flight read after cleanup", async () => {
  let reads = 0
  let updates = 0
  const stop = createResourceMonitor({
    pageSize: 4096,
    clockTicks: 100,
    list: async () => { reads++; return [entry(10, 1, reads, 1)] },
  }, 10, 20, () => { updates++ })
  await new Promise((resolve) => setTimeout(resolve, 45))
  stop()
  const readsAtStop = reads
  const updatesAtStop = updates
  await new Promise((resolve) => setTimeout(resolve, 45))
  assert.equal(reads, readsAtStop)
  assert.equal(updates, updatesAtStop)
})

test("does not overlap slow scans and contains reader failures", async () => {
  let reads = 0
  let release!: () => void
  const first = new Promise<void>((resolve) => { release = resolve })
  const stop = createResourceMonitor({
    pageSize: 4096,
    clockTicks: 100,
    list: async () => {
      reads++
      if (reads === 1) await first
      if (reads === 2) throw new Error("transient proc failure")
      return [entry(10, 1, reads, 1)]
    },
  }, 10, 10, () => {})
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(reads, 1)
  release()
  await new Promise((resolve) => setTimeout(resolve, 30))
  stop()
  assert.ok(reads >= 2)
})

test("retains the last snapshot when a later bounded scan fails", async () => {
  let reads = 0
  const snapshots: number[] = []
  const stop = createResourceMonitor({
    pageSize: 4096,
    clockTicks: 100,
    list: async () => {
      reads++
      if (reads > 1) throw new Error("malformed live child")
      return [entry(10, 1, 1, 2)]
    },
  }, 10, 10, (snapshot) => snapshots.push(snapshot.rssBytes))
  await new Promise((resolve) => setTimeout(resolve, 35))
  stop()
  assert.deepEqual(snapshots, [2 * 4096])
})

test("registers and cleans up both v2 footer status slots", () => {
  const claims: string[] = []
  const stopped: string[] = []
  const stop = registerResourceFooterSlots((claim) => {
    claims.push(claim.append)
    return () => stopped.push(claim.append)
  }, () => null)
  assert.deepEqual(claims, [...RESOURCE_FOOTER_SLOTS])
  stop()
  assert.deepEqual(stopped, [...RESOURCE_FOOTER_SLOTS])
})

test("opens a session panel when possible and otherwise uses the home fallback", () => {
  let fallback = 0
  assert.equal(openPanelOrFallback(() => true, () => { fallback++ }), "panel")
  assert.equal(fallback, 0)
  assert.equal(openPanelOrFallback(() => false, () => { fallback++ }), "fallback")
  assert.equal(fallback, 1)
  assert.equal(isPrimaryMouseButton(0), true)
  assert.equal(isPrimaryMouseButton(1), false)
  assert.equal(isPrimaryMouseButton(2), false)
  assert.equal(dialogContentWidth(80), 56)
  assert.equal(dialogContentWidth(40), 28)
  assert.equal(dialogContentWidth(Number.NaN), 20)
})

test("parses bounded truthful host CPU and memory data", () => {
  const cpu = parseCpuInfo("processor : 0\nmodel name : Honest CPU\nphysical id : 0\ncore id : 0\nprocessor : 1\nmodel name : Honest CPU\nphysical id : 0\ncore id : 1\n")
  assert.deepEqual(cpu, { model: "Honest CPU", logicalCores: 2, physicalCores: 2 })
  const first = parseCpuStat("cpu  10 2 3 5 1")
  const second = parseCpuStat("cpu  20 3 5 6 1")
  assert.equal(cpuPercent(first, second), 92.85714285714286)
  assert.deepEqual(parseMemInfo("MemTotal:       1024 kB\nMemAvailable:    256 kB\nSwapTotal:       512 kB\nSwapFree:        128 kB\n"), { memoryTotalBytes: 1024 * 1024, memoryAvailableBytes: 256 * 1024, memoryUsedBytes: 768 * 1024, swapTotalBytes: 512 * 1024, swapUsedBytes: 384 * 1024 })
})

test("bounded proc reads continue after short pseudo-file chunks", async () => {
  const source = Buffer.from("processor : 0\nprocessor : 1\nprocessor : 2\nprocessor : 3\n")
  let offset = 0
  let closed = false
  const text = await readBoundedText("/proc/cpuinfo", async () => ({
    read: async (buffer: Buffer, destinationOffset: number, length: number) => {
      const bytesRead = Math.min(7, length, source.length - offset)
      if (bytesRead > 0) source.copy(buffer, destinationOffset, offset, offset + bytesRead)
      offset += bytesRead
      return { bytesRead, buffer }
    },
    close: async () => { closed = true },
  }) as never)
  assert.equal(text, source.toString("utf8"))
  assert.equal(parseCpuInfo(text).logicalCores, 4)
  assert.equal(closed, true)
})

test("only selects bounded local filesystem mounts", () => {
  assert.deepEqual(localMounts([
    "root / ext4 rw 0 0",
    "server /net nfs rw 0 0",
    "loop /snap/tool squashfs ro 0 0",
    "proc /proc proc rw 0 0",
    "none /proc/sys/fs/binfmt_misc binfmt_misc rw 0 0",
    "portal /run/user/1000/doc fuse.portal rw 0 0",
    "gvfs /run/user/1000/gvfs fuse.gvfsd-fuse rw 0 0",
    "ctl /sys/fs/fuse/connections fusectl rw 0 0",
    "ns /run/netns/test nsfs rw 0 0",
    "data /data ext4 rw 0 0",
  ].join("\n")), ["/", "/data"])
})
