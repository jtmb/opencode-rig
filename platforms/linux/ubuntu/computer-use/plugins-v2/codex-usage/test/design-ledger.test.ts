import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import test from "node:test"

const require = createRequire(import.meta.url)
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
  name: string
  private: boolean
  exports: Record<string, string>
}

const ledgerPath = require.resolve(`${manifest.name}/design-ledger`)
const ledger = require(`${manifest.name}/design-ledger`) as {
  schemaVersion: number
  package: string
  sidebar: {
    rowsPerProvider: number
    fieldOrder: string[]
    wrap: boolean
    overflow: string
    updatedTimestamp: string
    themeRoles: {
      provider: string
      measurement: string
      status: Record<string, string>
    }
  }
  measurement: {
    source: string
    sourcePrecedence: Array<Record<string, string | number>>
    fallback: string
    remainingRatioAffectsColor: boolean
  }
  details: {
    command: string
    contains: string[]
  }
}

test("exports a versioned provider-usage design ledger from the private package", () => {
  assert.equal(manifest.private, true)
  assert.equal(manifest.exports["./design-ledger"], "./design-ledger.json")
  assert.equal(fileURLToPath(new URL("../design-ledger.json", import.meta.url)), ledgerPath)
  assert.equal(ledger.package, manifest.name)
  assert.equal(ledger.schemaVersion, 1)
})

test("defines one truncated row with semantic status-only color roles", () => {
  assert.equal(ledger.sidebar.rowsPerProvider, 1)
  assert.deepEqual(ledger.sidebar.fieldOrder, ["provider", "measurement", "status"])
  assert.equal(ledger.sidebar.wrap, false)
  assert.equal(ledger.sidebar.overflow, "truncate")
  assert.equal(ledger.sidebar.updatedTimestamp, "hidden")
  assert.equal(ledger.sidebar.themeRoles.provider, "text.default")
  assert.equal(ledger.sidebar.themeRoles.measurement, "text.subdued")
  assert.deepEqual(ledger.sidebar.themeRoles.status, {
    READY: "text.feedback.success.default",
    EMPTY: "text.feedback.error.default",
    COOLING: "text.subdued",
    OFFLINE: "text.subdued",
    STALE: "text.subdued",
  })
})

test("keeps measurement provenance explicit and routes full details to the command", () => {
  assert.equal(ledger.measurement.source, "provider.usage.snapshot.rows[].usage")
  assert.deepEqual(ledger.measurement.sourcePrecedence, [
    { source: "current-verified-adapter-value", priority: 1 },
    { source: "explicitly-retained-last-good-value", condition: "status-is-STALE", priority: 2 },
  ])
  assert.equal(ledger.measurement.fallback, "omit-when-missing-or-unverified")
  assert.equal(ledger.measurement.remainingRatioAffectsColor, false)
  assert.equal(ledger.details.command, "/provider-usage")
  assert.ok(ledger.details.contains.includes("diagnostics"))
  assert.ok(ledger.details.contains.includes("updated-timestamp"))
})

test("contains semantic roles only, with no credentials or fixed palette values", async () => {
  const raw = await readFile(ledgerPath, "utf8")
  const serialized = JSON.stringify(ledger)
  assert.doesNotMatch(serialized, /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization|bearer)\b/i)
  assert.doesNotMatch(serialized, /#(?:[\da-f]{3,8})\b|\b(?:rgba?|hsla?)\s*\(/i)
  assert.doesNotMatch(serialized, /\b(?:black|white|red|green|blue|yellow|orange|purple|pink|cyan|magenta)\b/i)
  assert.match(raw, /"schemaVersion"\s*:\s*1/)
})
