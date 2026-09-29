import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { analyzeUsage, classifyOpenCodeArgs, createSelfUsageAnalyzer, parseProcStat } from "../src/self-usage.ts"

function stat(pid: number, comm: string, ppid: number, ticks: number, rssPages: number) {
  return `${pid} (${comm}) ${["S", String(ppid), ...Array(9).fill("0"), String(ticks), "0", ...Array(6).fill("0"), String(pid), "0", String(rssPages)].join(" ")}`
}

test("parses process metrics and classifies OpenCode roles without returning argv", () => {
  const parsed = parseProcStat(stat(10, "opencode", 1, 25, 20), 10)
  assert.ok(parsed)
  assert.equal(parsed.ppid, 1)
  assert.equal(parsed.ticks, 25)
  assert.equal(parsed.rssBytes, 20 * 4096)
  assert.equal(classifyOpenCodeArgs(["/bin/opencode", "serve", "--service"]), "service")
  assert.equal(classifyOpenCodeArgs(["/bin/opencode", "--standalone"]), "standalone")
  assert.equal(classifyOpenCodeArgs(["/bin/opencode"]), "tui")
})

test("reports explicit host and OpenCode pressure findings", () => {
  const findings = analyzeUsage({
    host: {
      logicalCores: 4,
      loadAverage: [6, 4, 3],
      memoryTotalBytes: 4_000,
      memoryAvailableBytes: 200,
      swapTotalBytes: 1_000,
      swapUsedBytes: 600,
    },
    storage: { totalBytes: 1_000, availableBytes: 50 },
    instances: [{ pid: 10, cpuPercent: 250, rssBytes: 2 * 1024 ** 3 }],
  })
  assert.equal(findings.length, 7)
  assert.match(findings.join(" "), /one-minute load|available memory|25%|swap|filesystem|GiB|logical CPUs/)
})

test("scans a bounded synthetic OpenCode process tree", async () => {
  const procRoot = await mkdtemp(join(tmpdir(), "opencode-self-usage-proc-"))
  try {
    for (const pid of [10, 11]) await mkdir(join(procRoot, String(pid)), { recursive: true })
    await writeFile(join(procRoot, "10", "stat"), stat(10, "opencode", 1, 50, 10))
    await writeFile(join(procRoot, "10", "cmdline"), "/bin/opencode\0--standalone\0")
    await writeFile(join(procRoot, "11", "stat"), stat(11, "worker", 10, 25, 5))
    await writeFile(join(procRoot, "meminfo"), "MemAvailable: 2048 kB\nSwapTotal: 1024 kB\nSwapFree: 512 kB\n")
    const result = await createSelfUsageAnalyzer(procRoot, procRoot)()
    assert.equal(result.instances.length, 1)
    assert.equal(result.instances[0]?.pid, 10)
    assert.equal(result.instances[0]?.role, "standalone")
    assert.equal(result.instances[0]?.processCount, 2)
    assert.equal(result.instances[0]?.rssBytes, 15 * 4096)
    assert.equal(result.host.swapUsedBytes, 512 * 1024)
    assert.equal(result.host.memoryAvailableBytes, 2048 * 1024)
    assert.equal(result.host.memorySource, "proc-meminfo")
    assert.equal(result.bounds.processReadConcurrency, 32)
    assert.equal(JSON.stringify(result).includes("/bin/opencode"), false)
  } finally {
    await rm(procRoot, { recursive: true, force: true })
  }
})
