import assert from "node:assert/strict"
import test from "node:test"

import { calculateMemoryBudget, mebibyte, type MemoryProbe } from "../src/memory.ts"

const probe = (availableBytes: number): MemoryProbe => ({
  availableBytes,
  swapFreeBytes: 4 * 1024 * mebibyte,
})

test("scales the MCP budget with available memory", () => {
  const small = calculateMemoryBudget(probe(4 * 1024 * mebibyte))
  const large = calculateMemoryBudget(probe(32 * 1024 * mebibyte))
  assert.equal(small?.memoryMaxBytes, Math.floor((4 * 1024 * mebibyte * 20) / 100))
  assert.equal(large?.memoryMaxBytes, Math.floor((32 * 1024 * mebibyte * 20) / 100))
  assert.ok((large?.memoryMaxBytes ?? 0) > (small?.memoryMaxBytes ?? 0))
})

test("honors the tighter cgroup and swap availability", () => {
  const budget = calculateMemoryBudget({
    availableBytes: 8 * 1024 * mebibyte,
    swapFreeBytes: 4 * 1024 * mebibyte,
    cgroupAvailableBytes: 2 * 1024 * mebibyte,
    cgroupSwapFreeBytes: 128 * mebibyte,
  })
  assert.equal(budget?.availableBytes, 2 * 1024 * mebibyte)
  assert.equal(budget?.memoryMaxBytes, Math.floor((2 * 1024 * mebibyte * 20) / 100))
  assert.equal(budget?.swapMaxBytes, Math.floor((budget?.memoryMaxBytes ?? 0) * 25 / 100))
})

test("refuses to launch when the adaptive budget is not viable", () => {
  assert.equal(calculateMemoryBudget(probe(200 * mebibyte)), undefined)
})
