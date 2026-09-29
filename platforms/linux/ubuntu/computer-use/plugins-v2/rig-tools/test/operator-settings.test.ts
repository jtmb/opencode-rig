import assert from "node:assert/strict"
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  DEFAULT_ENFORCEMENTS,
  parseEnforcementSettings,
  readEnforcementSettings,
  serializeEnforcementSettings,
  writeEnforcementSettings,
} from "../../orchestration-policy/src/settings.ts"
import { runOperatorSettingsCommand } from "../src/operator-settings.ts"

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rig-settings-"))
  const projectRoot = join(root, "repository")
  const configHome = join(root, "config")
  const settingsPath = join(configHome, "opencode", "orchestration-policy-settings.json")
  await Promise.all([mkdir(projectRoot), mkdir(configHome, { mode: 0o700 })])
  return { root, projectRoot, configHome, settingsPath }
}

test("operator mode persists independently of enforcement toggles and invalid modes fail closed", async () => {
  const value = await fixture()
  try {
    assert.match(await runOperatorSettingsCommand("mode single-subagent", value.projectRoot, value.settingsPath), /single-subagent/)
    const saved = JSON.parse(await readFile(value.settingsPath, "utf8"))
    assert.equal(saved.orchestrationMode, "single-subagent")
    assert.deepEqual(saved.enforcements, DEFAULT_ENFORCEMENTS)
    await runOperatorSettingsCommand("strictShellClassification off", value.projectRoot, value.settingsPath)
    assert.equal(JSON.parse(await readFile(value.settingsPath, "utf8")).orchestrationMode, "single-subagent")
    await writeFile(value.settingsPath, (await readFile(value.settingsPath, "utf8")).replace("single-subagent", "unlimited"))
    const invalid = await readEnforcementSettings(value.projectRoot, value.settingsPath)
    assert.equal(invalid.status, "invalid")
    assert.deepEqual(invalid.enforcements, DEFAULT_ENFORCEMENTS)
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})

test("schema is bounded, exact, and rejects duplicate or unsupported JSON fields", () => {
  const valid = serializeEnforcementSettings(DEFAULT_ENFORCEMENTS)
  assert.deepEqual(parseEnforcementSettings(valid), DEFAULT_ENFORCEMENTS)
  assert.throws(() => parseEnforcementSettings(valid.replace('"schemaVersion": 1,', '"schemaVersion": 1,\n  "schemaVersion": 1,')), /canonical/)
  assert.throws(() => parseEnforcementSettings(valid.replace('"memoryReconciliation": true', '"memoryReconciliation": "off"')), /schema/)
  assert.throws(() => serializeEnforcementSettings({ ...DEFAULT_ENFORCEMENTS, credentials: "secret" } as never), /exactly/)
  assert.throws(() => parseEnforcementSettings(" ".repeat(4_097)), /size limit/)
})

test("missing settings fail open only to all-ON defaults; atomic writes survive reload", async () => {
  const value = await fixture()
  try {
    const missing = await readEnforcementSettings(value.projectRoot, value.settingsPath)
    assert.equal(missing.status, "missing")
    assert.deepEqual(missing.enforcements, DEFAULT_ENFORCEMENTS)

    const disabled = { ...DEFAULT_ENFORCEMENTS, strictShellClassification: false }
    await writeEnforcementSettings(disabled, value.projectRoot, value.settingsPath)
    const reloaded = await readEnforcementSettings(value.projectRoot, value.settingsPath)
    assert.equal(reloaded.status, "valid")
    assert.deepEqual(reloaded.enforcements, disabled)
    assert.equal((await stat(value.settingsPath)).mode & 0o777, 0o600)
    assert.deepEqual(JSON.parse(await readFile(value.settingsPath, "utf8")), {
      schemaVersion: 1,
      enforcements: disabled,
    })
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})

test("malformed or unreadable settings fail closed to all ON", async () => {
  const value = await fixture()
  try {
    await mkdir(join(value.configHome, "opencode"), { mode: 0o700 })
    await writeFile(value.settingsPath, '{"schemaVersion":1,"enforcements":{}}', { mode: 0o600 })
    const malformed = await readEnforcementSettings(value.projectRoot, value.settingsPath)
    assert.equal(malformed.status, "invalid")
    assert.deepEqual(malformed.enforcements, DEFAULT_ENFORCEMENTS)
    assert.match(malformed.message ?? "", /all workflow enforcements remain ON/)

    await chmod(value.settingsPath, 0o644)
    const unreadable = await readEnforcementSettings(value.projectRoot, value.settingsPath)
    assert.equal(unreadable.status, "invalid")
    assert.deepEqual(unreadable.enforcements, DEFAULT_ENFORCEMENTS)
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})

test("operator command lists states, persists toggles, and refuses fixed safety changes", async () => {
  const value = await fixture()
  try {
    const listed = await runOperatorSettingsCommand("", value.projectRoot, value.settingsPath)
    for (const name of Object.keys(DEFAULT_ENFORCEMENTS)) assert.match(listed, new RegExp(`${name}: ON`))
    assert.match(listed, /Fixed safety core/)
    assert.match(listed, /not operator-toggleable/)

    const toggled = await runOperatorSettingsCommand("requireTaskDeclare off", value.projectRoot, value.settingsPath)
    assert.match(toggled, /requireTaskDeclare is now OFF/)
    assert.match(toggled, /REDUCED POSTURE: requireTaskDeclare are OFF/)
    assert.equal((await readEnforcementSettings(value.projectRoot, value.settingsPath)).enforcements.requireTaskDeclare, false)

    const refused = await runOperatorSettingsCommand("commitApproval off", value.projectRoot, value.settingsPath)
    assert.match(refused, /Refused: commitApproval is fixed safety core/)
    assert.equal((await readEnforcementSettings(value.projectRoot, value.settingsPath)).enforcements.requireTaskDeclare, false)
    assert.match(await runOperatorSettingsCommand("unrecognized on", value.projectRoot, value.settingsPath), /Unknown enforcement/)
    assert.match(await runOperatorSettingsCommand("requireTaskDeclare off extra", value.projectRoot, value.settingsPath), /Usage error/)
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})

test("settings paths inside the repository are rejected", async () => {
  const value = await fixture()
  try {
    const inside = join(value.projectRoot, "settings.json")
    const result = await readEnforcementSettings(value.projectRoot, inside)
    assert.equal(result.status, "invalid")
    assert.deepEqual(result.enforcements, DEFAULT_ENFORCEMENTS)
    await assert.rejects(writeEnforcementSettings(DEFAULT_ENFORCEMENTS, value.projectRoot, inside), /outside the repository/)
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})

test("operator toggle repairs a symlink without following or changing its target", async () => {
  const value = await fixture()
  try {
    await mkdir(join(value.configHome, "opencode"), { mode: 0o700 })
    const target = join(value.root, "outside-settings.json")
    await writeFile(target, "do not modify", { mode: 0o600 })
    await symlink(target, value.settingsPath)
    const invalid = await readEnforcementSettings(value.projectRoot, value.settingsPath)
    assert.equal(invalid.status, "invalid")
    assert.deepEqual(invalid.enforcements, DEFAULT_ENFORCEMENTS)

    const output = await runOperatorSettingsCommand("strictShellClassification off", value.projectRoot, value.settingsPath)
    assert.match(output, /strictShellClassification is now OFF/)
    assert.equal((await lstat(value.settingsPath)).isSymbolicLink(), false)
    assert.equal(await readFile(target, "utf8"), "do not modify")
    assert.equal((await readEnforcementSettings(value.projectRoot, value.settingsPath)).enforcements.strictShellClassification, false)
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})
