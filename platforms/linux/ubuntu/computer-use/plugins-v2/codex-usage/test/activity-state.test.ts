import assert from "node:assert/strict"
import { lstat, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"

import { providerStateInputFromOpenCode } from "../src/server.ts"
import {
  MAX_PERSISTED_ACTIVITY_BYTES,
  defaultActivityStatePath,
  loadActivityState,
  parseActivityState,
  persistActivityState,
  serializeActivityState,
} from "../src/activity-state.ts"
import { computeProviderStates, OFFLINE_RECENCY_MS, type ProviderActivity } from "../src/state.ts"

const NOW = Date.UTC(2026, 8, 22, 12, 0, 0)

async function makeDirectory() {
  const directory = join(tmpdir(), `codex-usage-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  await mkdir(directory)
  return directory
}

async function removeDirectory(directory: string) {
  await rm(directory, { recursive: true, force: true })
}

function offlineInput(activities: readonly ProviderActivity[], now = NOW) {
  return providerStateInputFromOpenCode({
    providers: [
      { id: "builtin", name: "Built-in", activation: "enabled" },
      { id: "ingenium", name: "Ingenium", activation: "enabled", integrationID: "ingenium" },
    ],
    connections: [],
    activities,
    now,
  })
}

test("the server pipeline derives ambient readiness from Provider.Info and hides disconnected integration providers", () => {
  const input = providerStateInputFromOpenCode({
    providers: [
      {
        id: "opencode",
        name: "OpenCode Zen",
        activation: "enabled",
        integrationID: "opencode",
        settings: { apiKey: "public", baseURL: "https://example.invalid" },
      },
      { id: "ingenium-primary", name: "Ingenium", activation: "enabled" },
    ],
    integrations: [{ id: "opencode" }, { id: "ingenium-primary" }],
    connections: [],
    now: NOW,
  })
  const result = computeProviderStates(input)
  assert.deepEqual(result.rows.map((row) => [row.id, row.status]), [["opencode", "READY"]])
  assert.doesNotMatch(JSON.stringify(input), /public|example\.invalid/)
  assert.equal(result.rows.some((row) => row.id === "ingenium-primary"), false)
})

test("normalized activity survives a simulated restart at and inside the two-hour boundary", async () => {
  const directory = await makeDirectory()
  try {
    const statePath = join(directory, "nested", "activity.json")
    const inside = NOW - OFFLINE_RECENCY_MS + 1
    const exact = NOW - OFFLINE_RECENCY_MS
    const outside = NOW - OFFLINE_RECENCY_MS - 1
    await persistActivityState(statePath, [
      { providerID: "INGENIUM", at: inside },
      { providerID: "ingenium", at: exact },
      { providerID: "outside", at: outside },
    ], NOW)

    const afterRestart = await loadActivityState(statePath, NOW)
    assert.deepEqual(afterRestart, [{ providerID: "ingenium", at: inside }])
    assert.deepEqual(computeProviderStates(offlineInput(afterRestart)).rows.map((row) => [row.id, row.status]), [
      ["builtin", "READY"],
      ["ingenium", "OFFLINE"],
    ])

    const observed = NOW - 1_000
    const boundaryPath = join(directory, "boundary.json")
    await persistActivityState(boundaryPath, [{ providerID: "ingenium", at: observed }], NOW)
    const atBoundary = await loadActivityState(boundaryPath, observed + OFFLINE_RECENCY_MS)
    assert.equal(computeProviderStates(offlineInput(atBoundary, observed + OFFLINE_RECENCY_MS)).rows.some((row) => row.id === "ingenium"), true)
    const afterBoundary = await loadActivityState(boundaryPath, observed + OFFLINE_RECENCY_MS + 1)
    assert.equal(computeProviderStates(offlineInput(afterBoundary, observed + OFFLINE_RECENCY_MS + 1)).rows.some((row) => row.id === "ingenium"), false)
  } finally {
    await removeDirectory(directory)
  }
})

test("activity state rejects corrupt, symlinked, oversized, and over-capacity files", async () => {
  const directory = await makeDirectory()
  try {
    const statePath = join(directory, "activity.json")
    await writeFile(statePath, "not-json", "utf8")
    assert.deepEqual(await loadActivityState(statePath, NOW), [])

    await writeFile(statePath, "x".repeat(MAX_PERSISTED_ACTIVITY_BYTES + 1), "utf8")
    assert.deepEqual(await loadActivityState(statePath, NOW), [])

    const tooMany = JSON.stringify({
      activities: Array.from({ length: 513 }, (_, index) => ({ providerID: `provider-${index}`, at: NOW })),
    })
    await writeFile(statePath, tooMany, "utf8")
    assert.deepEqual(parseActivityState(tooMany, NOW), [])

    const targetPath = join(directory, "target.json")
    await writeFile(targetPath, serializeActivityState([{ providerID: "ingenium", at: NOW }], NOW), "utf8")
    await unlink(statePath)
    await symlink(targetPath, statePath)
    assert.deepEqual(await loadActivityState(statePath, NOW), [])
    await persistActivityState(statePath, [{ providerID: "ingenium", at: NOW }], NOW)
    assert.equal((await lstat(statePath)).isSymbolicLink(), true)

    const unsafeDirectory = join(directory, "unsafe")
    await symlink(directory, unsafeDirectory)
    assert.deepEqual(await loadActivityState(join(unsafeDirectory, "activity.json"), NOW), [])
    await persistActivityState(join(unsafeDirectory, "created", "activity.json"), [{ providerID: "ingenium", at: NOW }], NOW)
    await assert.rejects(() => lstat(join(directory, "created")), { code: "ENOENT" })

    const fileAncestor = join(directory, "not-a-directory")
    await writeFile(fileAncestor, "file", "utf8")
    await persistActivityState(join(fileAncestor, "activity.json"), [{ providerID: "ingenium", at: NOW }], NOW)
    await assert.rejects(() => lstat(join(fileAncestor, "activity.json")), { code: "ENOTDIR" })
  } finally {
    await removeDirectory(directory)
  }
})

test("persisted activity is normalized, bounded, atomic, and restrictive", async () => {
  const directory = await makeDirectory()
  try {
    const statePath = join(directory, "state", "activity.json")
    await persistActivityState(statePath, [{ providerID: "  InGeNiUm  ", at: NOW }], NOW)
    const info = await lstat(statePath)
    assert.equal(info.isFile(), true)
    assert.equal(info.isSymbolicLink(), false)
    assert.equal(info.mode & 0o777, 0o600)
    assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), {
      activities: [{ providerID: "ingenium", at: NOW }],
    })
    assert.ok((await readFile(statePath)).byteLength <= MAX_PERSISTED_ACTIVITY_BYTES)
    assert.equal(defaultActivityStatePath({ XDG_STATE_HOME: directory }), join(directory, "opencode", "codex-usage", "activity.json"))
  } finally {
    await removeDirectory(directory)
  }
})
