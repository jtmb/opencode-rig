import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createHermesHookSnapshotFeed } from "../src/hermes-hooks-feed.ts"
import {
  emptyHermesHookSnapshot,
  HERMES_HOOK_EVENT_LIMIT,
  HERMES_HOOK_SNAPSHOT_MAX_BYTES,
  hermesHookSnapshotPath,
  limitHermesHookSnapshot,
  parseHermesHookSnapshot,
  readHermesHookSnapshot,
} from "../src/hermes-hooks-snapshot.ts"

async function temporaryDirectory(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "hermes-hooks-test-"))
}

function validEvent(index: number) {
  return {
    at: `2026-09-23T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
    hook: "post_api_request",
    status: "ok",
    model: "gpt-6-luna",
    provider: "openai",
    requestRef: "0123456789ab",
    privatePrompt: "must not escape the allowlist",
  }
}

test("snapshot parsing validates, clamps, and strips unknown event data", () => {
  const parsed = parseHermesHookSnapshot({
    schemaVersion: 1,
    updatedAt: "2026-09-23T10:00:01.000Z",
    events: [validEvent(1), { ...validEvent(2), hook: "unknown_hook" }],
    privateTopLevel: "not exposed",
  })

  assert.equal(parsed.state, "ready")
  assert.equal(parsed.events.length, 1)
  assert.equal(parsed.events[0]?.model, "gpt-6-luna")
  assert.equal("privatePrompt" in (parsed.events[0] ?? {}), false)
  assert.equal("privateTopLevel" in parsed, false)
  assert.deepEqual(limitHermesHookSnapshot(parsed, 1).events, parsed.events)
  assert.equal(limitHermesHookSnapshot(parsed, -1).events.length, 1)
})

test("snapshot reader hydrates a valid regular file and reports missing or oversized data", async () => {
  const directory = await temporaryDirectory()
  try {
    const path = join(directory, "snapshot.json")
    await writeFile(path, JSON.stringify({ schemaVersion: 1, updatedAt: validEvent(1).at, events: [validEvent(1)] }))
    const loaded = await readHermesHookSnapshot(path)
    assert.equal(loaded.state, "ready")
    assert.equal(loaded.events[0]?.hook, "post_api_request")

    const missing = await readHermesHookSnapshot(join(directory, "missing.json"))
    assert.equal(missing.state, "empty")

    const oversized = join(directory, "oversized.json")
    await writeFile(oversized, Buffer.alloc(HERMES_HOOK_SNAPSHOT_MAX_BYTES + 1))
    assert.equal((await readHermesHookSnapshot(oversized)).state, "invalid")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("snapshot reader refuses symlinks and malformed snapshots", async () => {
  const directory = await temporaryDirectory()
  try {
    const outside = join(directory, "outside.json")
    const link = join(directory, "snapshot.json")
    await writeFile(outside, JSON.stringify({ schemaVersion: 1, updatedAt: "", events: [] }))
    await symlink(outside, link)
    assert.equal((await readHermesHookSnapshot(link)).state, "unavailable")

    const malformed = join(directory, "malformed.json")
    await writeFile(malformed, "not-json")
    assert.equal((await readHermesHookSnapshot(malformed)).state, "invalid")
    assert.equal(await readFile(outside, "utf8"), JSON.stringify({ schemaVersion: 1, updatedAt: "", events: [] }))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("telemetry path honors an absolute profile override and rejects relative overrides", () => {
  assert.equal(
    hermesHookSnapshotPath({ HERMES_HOME: "/tmp/hermes-profile" }, "/home/tester"),
    "/tmp/hermes-profile/logs/open-rig-hooks.snapshot.json",
  )
  assert.equal(hermesHookSnapshotPath({ OPEN_RIG_HERMES_TELEMETRY_FILE: "relative.json" }, "/home/tester"), undefined)
  assert.equal(HERMES_HOOK_EVENT_LIMIT, 128)
})

test("live snapshot feed emits hydration and changes once, then stops cleanly", async () => {
  let current = emptyHermesHookSnapshot()
  const published: string[] = []
  const feed = createHermesHookSnapshotFeed(
    async () => current,
    async (snapshot) => { published.push(JSON.stringify(snapshot)) },
    60_000,
  )

  await feed.refresh()
  await feed.refresh()
  current = parseHermesHookSnapshot({ schemaVersion: 1, updatedAt: validEvent(3).at, events: [validEvent(3)] })
  await feed.refresh()
  feed.stop()
  current = emptyHermesHookSnapshot()
  await feed.refresh()

  assert.equal(published.length, 2)
  assert.equal(JSON.parse(published[1] ?? "{}").events.length, 1)
})
