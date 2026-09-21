import assert from "node:assert/strict"
import test from "node:test"

import { cgroupV2Directory, createMemoryCapacityEvaluator } from "../src/memory-capacity.ts"

test("resolves a nested cgroup v2 path", () => {
  assert.equal(cgroupV2Directory("0::/user.slice/user-1000.slice/session.slice\n"), "/sys/fs/cgroup/user.slice/user-1000.slice/session.slice")
})

test("uses nested cgroup current/limit and reports the limiting source", async () => {
  const files: Record<string, string> = {
    "/proc/meminfo": "MemAvailable:       8192 kB\n",
    "/proc/self/cgroup": "0::/user.slice/agent.slice\n",
    "/sys/fs/cgroup/user.slice/agent.slice/memory.max": "6291456",
    "/sys/fs/cgroup/user.slice/agent.slice/memory.current": "1048576",
    "/sys/fs/cgroup/user.slice/memory.max": "10485760",
    "/sys/fs/cgroup/user.slice/memory.current": "0",
    "/sys/fs/cgroup/memory.max": "10485760",
    "/sys/fs/cgroup/memory.current": "0",
  }
  const evaluate = createMemoryCapacityEvaluator({ memoryReserveMiB: 1, memoryPerAgentMiB: 1 }, async (path) => {
    if (!(path in files)) throw new Error(`missing fixture ${path}`)
    return files[path]
  })
  const result = await evaluate(3)
  assert.equal(result.limitingSource, "cgroup-v2")
  assert.equal(result.approvedCount, 3)
  assert.equal(result.evidence.cgroupAvailableBytes, 5242880)
})

test("missing cgroup files fall back to host memory and invalid config is serial", async () => {
  const host = createMemoryCapacityEvaluator({ memoryReserveMiB: 1, memoryPerAgentMiB: 1 }, async (path) => {
    if (path === "/proc/meminfo") return "MemAvailable: 4096 kB\n"
    if (path === "/proc/self/cgroup") return "0::/missing\n"
    throw new Error("not mounted")
  })
  assert.equal((await host(2)).limitingSource, "host-MemAvailable")
  const invalid = createMemoryCapacityEvaluator({ memoryPerAgentMiB: 0 })
  assert.equal((await invalid(3)).recommendedCount, 1)
})

test("approves exactly three when the bounded orchestration budget permits it", async () => {
  const files: Record<string, string> = {
    "/proc/meminfo": "MemAvailable: 4096 kB\n",
    "/proc/self/cgroup": "0::/agent\n",
    "/sys/fs/cgroup/agent/memory.max": "1048576000",
    "/sys/fs/cgroup/agent/memory.current": "0",
    "/sys/fs/cgroup/memory.max": "1048576000",
    "/sys/fs/cgroup/memory.current": "0",
  }
  const evaluate = createMemoryCapacityEvaluator({ memoryReserveMiB: 1, memoryPerAgentMiB: 1 }, async (path) => files[path] ?? (() => { throw new Error(`missing ${path}`) })())
  assert.equal((await evaluate(3)).recommendedCount, 3)
})

test("reduces to the valid budget and never exceeds the hard cap", async () => {
  const files: Record<string, string> = {
    "/proc/meminfo": "MemAvailable: 4096 kB\n",
    "/proc/self/cgroup": "0::/agent\n",
    "/sys/fs/cgroup/agent/memory.max": "3145728",
    "/sys/fs/cgroup/agent/memory.current": "0",
    "/sys/fs/cgroup/memory.max": "3145728",
    "/sys/fs/cgroup/memory.current": "0",
  }
  const evaluate = createMemoryCapacityEvaluator({ memoryReserveMiB: 1, memoryPerAgentMiB: 1 }, async (path) => files[path] ?? (() => { throw new Error(`missing ${path}`) })())
  assert.equal((await evaluate(3)).recommendedCount, 2)
})

test("uses the minimum finite parent and grandparent headroom when the leaf is unlimited", async () => {
  const files: Record<string, string> = {
    "/proc/meminfo": "MemAvailable: 1048576 kB\nSwapFree: 1048576 kB\n",
    "/proc/self/cgroup": "0::/parent/child/grandchild\n",
    "/sys/fs/cgroup/parent/child/grandchild/memory.max": "max",
    "/sys/fs/cgroup/parent/child/memory.max": "max",
    "/sys/fs/cgroup/parent/memory.max": "1048576",
    "/sys/fs/cgroup/parent/memory.current": "0",
    "/sys/fs/cgroup/memory.max": "2097152",
    "/sys/fs/cgroup/memory.current": "0",
  }
  const evaluate = createMemoryCapacityEvaluator({ memoryReserveMiB: 1, memoryPerAgentMiB: 1 }, async (path) => files[path] ?? (() => { throw new Error(`missing ${path}`) })())
  const result = await evaluate(3)
  assert.equal(result.evidence.cgroupAvailableBytes, 1048576)
  assert.equal(result.evidence.limitingCgroupPath, "/sys/fs/cgroup/parent")
})

test("exhausted ancestor and malformed finite-current metrics fail closed", async () => {
  const make = (current: string) => createMemoryCapacityEvaluator({ memoryReserveMiB: 1, memoryPerAgentMiB: 1 }, async (path) => ({
    "/proc/meminfo": "MemAvailable: 1048576 kB\nSwapFree: 1048576 kB\n",
    "/proc/self/cgroup": "0::/parent/child\n",
    "/sys/fs/cgroup/parent/child/memory.max": "max",
    "/sys/fs/cgroup/parent/memory.max": "1048576",
    "/sys/fs/cgroup/parent/memory.current": current,
    "/sys/fs/cgroup/memory.max": "2097152",
    "/sys/fs/cgroup/memory.current": "0",
  } as Record<string, string>)[path] ?? (() => { throw new Error(`missing ${path}`) })())
  assert.equal((await make("1048576")(2)).limitingSource, "cgroup-v2")
  assert.equal((await make("not-a-number")(2)).limitingSource, "invalid-metrics-or-configuration")
  assert.equal((await make("1048577")(2)).limitingSource, "invalid-metrics-or-configuration")
})

test("takes the minimum remaining finite ancestor swap budget", async () => {
  const files: Record<string, string> = {
    "/proc/meminfo": "MemAvailable: 1048576 kB\nSwapFree: 1048576 kB\n",
    "/proc/self/cgroup": "0::/parent/child\n",
    "/sys/fs/cgroup/parent/child/memory.max": "max",
    "/sys/fs/cgroup/parent/memory.max": "2097152",
    "/sys/fs/cgroup/parent/memory.current": "0",
    "/sys/fs/cgroup/memory.max": "2097152",
    "/sys/fs/cgroup/memory.current": "0",
    "/sys/fs/cgroup/parent/child/memory.swap.max": "max",
    "/sys/fs/cgroup/parent/memory.swap.max": "10485760",
    "/sys/fs/cgroup/parent/memory.swap.current": "8388608",
    "/sys/fs/cgroup/memory.swap.max": "20971520",
    "/sys/fs/cgroup/memory.swap.current": "0",
  }
  const evaluate = createMemoryCapacityEvaluator({ memoryReserveMiB: 1, memoryPerAgentMiB: 1 }, async (path) => files[path] ?? (() => { throw new Error(`missing ${path}`) })())
  assert.equal((await evaluate(1)).evidence.cgroupSwapBytes, 2097152)
})
