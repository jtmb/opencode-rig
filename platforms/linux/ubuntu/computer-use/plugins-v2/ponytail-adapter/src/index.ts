import { createRequire } from "node:module"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"
import { lstat, readdir, readFile, realpath } from "node:fs/promises"

import { Plugin, Skill } from "@opencode/plugin"

const MAX_PACKAGE_JSON_BYTES = 256 * 1024
const MAX_COMMAND_BYTES = 64 * 1024
const MAX_SKILL_BYTES = 512 * 1024
const MAX_COMMANDS = 32
const MAX_SKILLS = 32
const NAME = /^[a-z0-9][a-z0-9-]{0,127}$/

type PonytailRuntime = {
  getDefaultMode(): string
  normalizeMode(value: unknown): string | null
  getPonytailInstructions(mode: string): string
}

export type PonytailCommand = {
  name: string
  description?: string
  template: string
}

export type PonytailSkill = {
  id: string
  name: string
  description?: string
  path: string
  content: string
}

export type PonytailPackage = {
  root: string
  version: string
  commands: PonytailCommand[]
  skills: PonytailSkill[]
  runtime: PonytailRuntime
}

async function boundedFile(path: string, maximum: number, label: string) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`)
  if (info.size > maximum) throw new Error(`${label} exceeds ${maximum} bytes`)
  return readFile(path, "utf8")
}

function parseCommand(name: string, source: string): PonytailCommand {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!match) throw new Error(`Ponytail command has invalid frontmatter: ${name}`)
  const description = match[1].match(/^description:\s*(.+)$/m)?.[1]?.trim()
  return { name, description, template: match[2].trim() }
}

function parseSkill(id: string, path: string, source: string): PonytailSkill {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!match) throw new Error(`Ponytail skill has invalid frontmatter: ${id}`)
  const declaredName = match[1].match(/^name:\s*(.+)$/m)?.[1]?.trim()
  if (!declaredName || declaredName !== id) throw new Error(`Ponytail skill name does not match its directory: ${id}`)
  const folded = match[1].match(/^description:\s*>-?\s*\r?\n((?:[ \t]+.*(?:\r?\n|$))*)/m)?.[1]
  const description = folded
    ? folded.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(" ")
    : match[1].match(/^description:\s*(.+)$/m)?.[1]?.trim()
  return { id, name: id, description, path, content: match[2].trim() }
}

function packageRootOption(options: unknown) {
  if (typeof options === "object" && options !== null && !Array.isArray(options)) {
    const value = (options as Record<string, unknown>).packageRoot
    if (typeof value === "string" && value.length > 0) return value
  }
  return join(homedir(), ".local", "opt", "opencode-ponytail", "current", "node_modules", "@dietrichgebert", "ponytail")
}

export async function loadPonytailPackage(inputRoot: string): Promise<PonytailPackage> {
  const root = await realpath(inputRoot)
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Ponytail package root must resolve to a regular directory")

  const packageText = await boundedFile(join(root, "package.json"), MAX_PACKAGE_JSON_BYTES, "Ponytail package.json")
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(packageText) as Record<string, unknown>
  } catch {
    throw new Error("Ponytail package.json is not valid JSON")
  }
  if (manifest.name !== "@dietrichgebert/ponytail" || typeof manifest.version !== "string") {
    throw new Error("package root is not an official @dietrichgebert/ponytail package")
  }

  const commandDirectory = join(root, ".opencode", "command")
  const commandEntries = (await readdir(commandDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .sort((left, right) => left.name.localeCompare(right.name))
  if (commandEntries.length === 0 || commandEntries.length > MAX_COMMANDS) throw new Error(`Ponytail must contain 1-${MAX_COMMANDS} commands`)
  const commands: PonytailCommand[] = []
  for (const entry of commandEntries) {
    const name = basename(entry.name, ".md")
    if (!NAME.test(name)) throw new Error(`Ponytail command name is invalid: ${name}`)
    const source = await boundedFile(join(commandDirectory, entry.name), MAX_COMMAND_BYTES, `Ponytail command ${name}`)
    commands.push(parseCommand(name, source))
  }

  const skillsDirectory = join(root, "skills")
  const skillEntries = (await readdir(skillsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
  if (skillEntries.length === 0 || skillEntries.length > MAX_SKILLS) throw new Error(`Ponytail must contain 1-${MAX_SKILLS} skills`)
  const skills: PonytailSkill[] = []
  for (const entry of skillEntries) {
    if (!NAME.test(entry.name)) throw new Error(`Ponytail skill name is invalid: ${entry.name}`)
    const skillPath = join(skillsDirectory, entry.name, "SKILL.md")
    const source = await boundedFile(skillPath, MAX_SKILL_BYTES, `Ponytail skill ${entry.name}`)
    skills.push(parseSkill(entry.name, skillPath, source))
  }

  const require = createRequire(import.meta.url)
  const config = require(join(root, "hooks", "ponytail-config.js")) as Record<string, unknown>
  const instructions = require(join(root, "hooks", "ponytail-instructions.js")) as Record<string, unknown>
  if (typeof config.getDefaultMode !== "function" || typeof config.normalizeMode !== "function" || typeof instructions.getPonytailInstructions !== "function") {
    throw new Error("Ponytail package does not expose the expected instruction runtime")
  }
  const runtime: PonytailRuntime = {
    getDefaultMode: config.getDefaultMode as PonytailRuntime["getDefaultMode"],
    normalizeMode: config.normalizeMode as PonytailRuntime["normalizeMode"],
    getPonytailInstructions: instructions.getPonytailInstructions as PonytailRuntime["getPonytailInstructions"],
  }
  for (const mode of ["lite", "full", "ultra"]) {
    const text = runtime.getPonytailInstructions(mode)
    if (typeof text !== "string" || text.length === 0 || text.length > MAX_SKILL_BYTES || !text.includes(`level: ${mode}`)) {
      throw new Error(`Ponytail instruction runtime failed its ${mode} self-check`)
    }
  }
  return { root, version: manifest.version, commands, skills, runtime }
}

function withoutMentions<T extends { mention?: unknown }>(references?: readonly T[]) {
  return references?.map(({ mention: _mention, ...reference }) => reference)
}

function expandCommand(template: string, input: string) {
  const expanded = template.replaceAll("$ARGUMENTS", input)
  return !template.includes("$ARGUMENTS") && input.trim() ? `${expanded}\n\n${input}`.trim() : expanded.trim()
}

export default Plugin.define({
  id: "ponytail",
  async setup(ctx) {
    const ponytail = await loadPonytailPackage(resolve(packageRootOption(ctx.options)))
    const readMode = async (sessionID: string) => {
      const stored = await ctx.storage.get(`mode/${sessionID}`)
      return ponytail.runtime.normalizeMode(stored) ?? ponytail.runtime.getDefaultMode()
    }

    await ctx.command.transform((editor) => {
      for (const command of ponytail.commands) {
        editor.add({
          name: command.name,
          description: command.description,
          execute: async ({ sessionID, prompt, delivery }) => {
            let text = expandCommand(command.template, prompt.text)
            if (command.name === "ponytail") {
              const argument = prompt.text.trim()
              const selected = ponytail.runtime.normalizeMode(argument)
              if (selected) await ctx.storage.set(`mode/${sessionID}`, selected)
              const status = `Ponytail level: ${await readMode(sessionID)}.`
              text = argument && !selected
                ? `Invalid Ponytail level. Use lite, full, ultra, or off. ${status} Report this without changing the mode.`
                : `${status} Report this status briefly. The plugin controls the mode for this session.`
            }
            await ctx.session.prompt({
              ...prompt,
              sessionID,
              text,
              files: withoutMentions(prompt.files),
              agents: withoutMentions(prompt.agents),
              skills: withoutMentions(prompt.skills),
              delivery,
            })
          },
        })
      }
    })

    await ctx.skill.transform((editor) => {
      // The editor validates branded Skill.Info values at the registration
      // boundary; the loader above validates their bounded source fields.
      for (const skill of ponytail.skills) editor.add(skill as unknown as Skill.Info)
    })

    const inject = async (event: { sessionID: string; system: Array<{ type: "text"; text: string }> }) => {
      const mode = await readMode(event.sessionID)
      if (mode === "off") return
      const text = ponytail.runtime.getPonytailInstructions(mode)
      const last = event.system.at(-1)
      if (last) last.text += `\n\n${text}`
      else event.system.push({ type: "text", text })
    }
    await ctx.session.hook("context", inject)
    await ctx.session.hook("generate", inject)
  },
})
