import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import plugin, {
  loadPonytailPackage,
  PONYTAIL_COMMAND_NAMES,
  PONYTAIL_PACKAGE_VERSION,
  PONYTAIL_SKILL_NAMES,
  resolvePonytailPackageRoot,
} from "../src/index.ts"

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rig-ponytail-"))
  await mkdir(join(root, "hooks"), { recursive: true })
  await mkdir(join(root, ".opencode", "command"), { recursive: true })
  for (const name of PONYTAIL_SKILL_NAMES) {
    await mkdir(join(root, "skills", name), { recursive: true })
    await writeFile(join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\nPonytail ${name} body.\n`)
  }
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@dietrichgebert/ponytail", version: PONYTAIL_PACKAGE_VERSION }))
  for (const name of PONYTAIL_COMMAND_NAMES) {
    await writeFile(join(root, ".opencode", "command", `${name}.md`), `---\ndescription: ${name}\n---\nRun ${name} with $ARGUMENTS.\n`)
  }
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

function context(packageRoot?: string) {
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
      options: packageRoot ? { packageRoot } : {},
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
    assert.equal(loaded.version, PONYTAIL_PACKAGE_VERSION)
    assert.deepEqual(loaded.commands.map((entry) => entry.name).toSorted(), [...PONYTAIL_COMMAND_NAMES].toSorted())
    assert.deepEqual(loaded.skills.map((entry) => entry.id).toSorted(), [...PONYTAIL_SKILL_NAMES].toSorted())
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("registers v2 commands and skills with per-session persistent modes", async () => {
  const root = await fixture()
  try {
    const ctx = context(root)
    await plugin.setup(ctx.value as never)
    assert.deepEqual([...ctx.commands.keys()].toSorted(), [...PONYTAIL_COMMAND_NAMES].toSorted())
    assert.deepEqual(ctx.skills.map((entry) => entry.id).toSorted(), [...PONYTAIL_SKILL_NAMES].toSorted())
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
    await assert.rejects(loadPonytailPackage(root), /not the pinned official/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("resolves the pinned package from the adapter module without HOME or ~/.local state", async () => {
  const previousHome = process.env.HOME
  const previousMode = process.env.PONYTAIL_DEFAULT_MODE
  const home = await mkdtemp(join(tmpdir(), "rig-ponytail-home-"))
  process.env.HOME = home
  process.env.PONYTAIL_DEFAULT_MODE = "full"
  try {
    const root = await resolvePonytailPackageRoot()
    assert.match(root, /node_modules[\\/]@dietrichgebert[\\/]ponytail$/)
    assert.ok(!root.startsWith(home))
    const loaded = await loadPonytailPackage(root)
    assert.equal(loaded.version, PONYTAIL_PACKAGE_VERSION)
    assert.equal(loaded.commands.length, 6)
    assert.equal(loaded.skills.length, 6)
    const ctx = context()
    await plugin.setup(ctx.value as never)
    assert.deepEqual([...ctx.commands.keys()].toSorted(), [...PONYTAIL_COMMAND_NAMES].toSorted())
    assert.deepEqual(ctx.skills.map((entry) => entry.id).toSorted(), [...PONYTAIL_SKILL_NAMES].toSorted())
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousMode === undefined) delete process.env.PONYTAIL_DEFAULT_MODE
    else process.env.PONYTAIL_DEFAULT_MODE = previousMode
    await rm(home, { recursive: true, force: true })
  }
})

test("refuses the official package when its pinned version or layout is wrong", async () => {
  const root = await fixture()
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "@dietrichgebert/ponytail", version: "4.9.0" }))
    await assert.rejects(loadPonytailPackage(root), /pinned official/)
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "@dietrichgebert/ponytail", version: PONYTAIL_PACKAGE_VERSION }))
    await rm(join(root, "skills", "ponytail-help"), { recursive: true })
    await assert.rejects(loadPonytailPackage(root), /exactly six skills/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

for (const hookName of ["ponytail-config.js", "ponytail-instructions.js"] as const) {
  const hookPath = (root: string) => join(root, "hooks", hookName)

  test(`rejects a missing ${hookName} before loading either hook`, async () => {
    const root = await fixture()
    try {
      await rm(hookPath(root))
      await assert.rejects(loadPonytailPackage(root), { code: "ENOENT" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test(`rejects a symlinked ${hookName} before executing it`, async () => {
    const root = await fixture()
    try {
      const target = join(root, `outside-${hookName}`)
      await writeFile(target, 'throw new Error("symlink hook executed")\n')
      await rm(hookPath(root))
      await symlink(target, hookPath(root))
      await assert.rejects(loadPonytailPackage(root), /regular non-symlink file/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test(`rejects an oversized ${hookName} before executing it`, async () => {
    const root = await fixture()
    try {
      await writeFile(hookPath(root), Buffer.alloc(64 * 1024 + 1))
      await assert.rejects(loadPonytailPackage(root), /exceeds 65536 bytes/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test(`rejects a non-regular ${hookName} before loading either hook`, async () => {
    const root = await fixture()
    try {
      await rm(hookPath(root))
      await mkdir(hookPath(root))
      await assert.rejects(loadPonytailPackage(root), /regular non-symlink file/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}
