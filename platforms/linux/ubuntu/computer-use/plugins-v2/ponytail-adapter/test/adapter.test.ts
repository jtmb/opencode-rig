import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import plugin, { loadPonytailPackage } from "../src/index.ts"

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rig-ponytail-"))
  await mkdir(join(root, "hooks"), { recursive: true })
  await mkdir(join(root, ".opencode", "command"), { recursive: true })
  for (const name of ["ponytail", "ponytail-review"]) {
    await mkdir(join(root, "skills", name), { recursive: true })
    await writeFile(join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\nPonytail ${name} body.\n`)
  }
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@dietrichgebert/ponytail", version: "9.9.9" }))
  await writeFile(join(root, ".opencode", "command", "ponytail.md"), "---\ndescription: set mode\n---\nSet $ARGUMENTS mode.\n")
  await writeFile(join(root, ".opencode", "command", "ponytail-review.md"), "---\ndescription: review\n---\nReview now.\n")
  await writeFile(join(root, "hooks", "ponytail-config.js"), `
const modes = new Set(["off", "lite", "full", "ultra"])
exports.normalizeMode = (value) => typeof value === "string" && modes.has(value.trim().toLowerCase()) ? value.trim().toLowerCase() : null
exports.getDefaultMode = () => "full"
`)
  await writeFile(join(root, "hooks", "ponytail-instructions.js"), `
exports.getPonytailInstructions = (mode) => "PONYTAIL MODE ACTIVE — level: " + mode + "\\nRules"
`)
  return root
}

function context(packageRoot: string) {
  const commands = new Map<string, { execute(input: Record<string, unknown>): Promise<void> }>()
  const skills: Array<{ id: string }> = []
  const hooks = new Map<string, (event: { sessionID: string; system: Array<{ type: "text"; text: string }> }) => Promise<void>>()
  const prompts: Array<Record<string, unknown>> = []
  const storage = new Map<string, unknown>()
  return {
    commands,
    skills,
    hooks,
    prompts,
    value: {
      options: { packageRoot },
      storage: {
        get: async (key: string) => storage.get(key),
        set: async (key: string, value: unknown) => { storage.set(key, value) },
      },
      command: { transform: async (callback: (editor: { add(value: { name: string; execute(input: Record<string, unknown>): Promise<void> }): void }) => void) => callback({ add: (value) => commands.set(value.name, value) }) },
      skill: { transform: async (callback: (editor: { add(value: { id: string }): void }) => void) => callback({ add: (value) => skills.push(value) }) },
      session: {
        hook: async (name: string, callback: (event: { sessionID: string; system: Array<{ type: "text"; text: string }> }) => Promise<void>) => { hooks.set(name, callback) },
        prompt: async (input: Record<string, unknown>) => { prompts.push(input) },
      },
    },
  }
}

test("loads a bounded official package and its current commands and skills", async () => {
  const root = await fixture()
  try {
    const loaded = await loadPonytailPackage(root)
    assert.equal(loaded.version, "9.9.9")
    assert.deepEqual(loaded.commands.map((entry) => entry.name).toSorted(), ["ponytail", "ponytail-review"])
    assert.deepEqual(loaded.skills.map((entry) => entry.id).toSorted(), ["ponytail", "ponytail-review"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("registers v2 commands and skills with per-session persistent modes", async () => {
  const root = await fixture()
  try {
    const ctx = context(root)
    await plugin.setup(ctx.value as never)
    assert.deepEqual([...ctx.commands.keys()].toSorted(), ["ponytail", "ponytail-review"])
    assert.deepEqual(ctx.skills.map((entry) => entry.id).toSorted(), ["ponytail", "ponytail-review"])
    assert.ok(ctx.hooks.has("context"))
    assert.ok(ctx.hooks.has("generate"))

    await ctx.commands.get("ponytail")!.execute({ sessionID: "one", prompt: { text: "ultra" }, delivery: "steer" })
    const one = { sessionID: "one", system: [{ type: "text" as const, text: "Existing" }] }
    await ctx.hooks.get("context")!(one)
    assert.equal(one.system.length, 1)
    assert.match(one.system[0].text, /level: ultra/)

    const two = { sessionID: "two", system: [] as Array<{ type: "text"; text: string }> }
    await ctx.hooks.get("generate")!(two)
    assert.match(two.system[0].text, /level: full/)
    assert.match(String(ctx.prompts[0].text), /level: ultra/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("refuses packages with the wrong identity", async () => {
  const root = await fixture()
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "lookalike", version: "1.0.0" }))
    await assert.rejects(loadPonytailPackage(root), /not an official/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
