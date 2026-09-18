import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"

export const DESKTOP_CONTROL_SCRIPT = fileURLToPath(
  new URL("../../../scripts/desktop-control.py", import.meta.url),
)

export const DESKTOP_CONTROL_TIMEOUT_MS = 30_000
export const DESKTOP_CONTROL_MAX_OUTPUT_BYTES = 256 * 1024

export type DesktopMutationVerb = "action" | "focus" | "set-text"

export interface DesktopMatchInput {
  app?: string
  name?: string
  exactName?: boolean
  role?: string
  showing?: boolean
  nth?: number
  maxDepth?: number
  maxNodes?: number
}

export interface DesktopCommandInput extends DesktopMatchInput {
  verb: "apps" | "tree" | "find" | DesktopMutationVerb
  all?: boolean
  includeText?: boolean
  action?: string
  text?: string
  waitSeconds?: number
  apply?: boolean
  expectToken?: string
}

export type DesktopArgResult = { args: string[] } | { error: string }

function pushBounds(args: string[], input: DesktopMatchInput): void {
  if (input.maxDepth !== undefined) args.push("--max-depth", String(input.maxDepth))
  if (input.maxNodes !== undefined) args.push("--max-nodes", String(input.maxNodes))
}

function pushMatcher(args: string[], input: DesktopMatchInput): void {
  if (input.name !== undefined) args.push("--name", input.name)
  if (input.exactName) args.push("--exact-name")
  if (input.role !== undefined) args.push("--role", input.role)
  if (input.showing) args.push("--showing")
  if (input.nth !== undefined) args.push("--nth", String(input.nth))
}

export function buildDesktopArgs(input: DesktopCommandInput): DesktopArgResult {
  const args: string[] = [input.verb]

  switch (input.verb) {
    case "apps":
      return { args }

    case "tree": {
      if (!input.app) return { error: "tree requires an application name" }
      args.push("--app", input.app)
      pushBounds(args, input)
      if (input.all) args.push("--all")
      if (input.includeText) args.push("--include-text")
      return { args }
    }

    case "find": {
      if (!input.app) return { error: "find requires an application name" }
      if (!input.name && !input.role) return { error: "find requires a name and/or role" }
      args.push("--app", input.app)
      pushMatcher(args, input)
      pushBounds(args, input)
      if (input.includeText) args.push("--include-text")
      return { args }
    }

    case "action":
    case "focus":
    case "set-text": {
      const verb = input.verb
      if (!input.app) return { error: `${verb} requires an application name` }
      if (verb === "action" && !input.name) {
        return { error: "action requires a name (desktop-control.py requires --name for actions)" }
      }
      if (verb !== "action" && !input.name && !input.role) {
        return { error: `${verb} requires a name and/or role` }
      }
      if (verb !== "action" && input.action !== undefined) {
        return { error: "action is only valid with the action verb" }
      }
      if (verb === "set-text" && input.text === undefined) {
        return { error: "set-text requires text" }
      }
      if (verb !== "set-text" && input.text !== undefined) {
        return { error: "text is only valid with the set-text verb" }
      }
      if (verb === "action" && input.waitSeconds !== undefined) {
        return { error: "waitSeconds is only valid with the focus and set-text verbs" }
      }
      if (input.expectToken !== undefined && !input.apply) {
        return { error: "expectToken is only valid together with apply=true" }
      }
      if (input.apply && !input.expectToken) {
        return { error: "apply=true requires expectToken from the preview result" }
      }

      args.push("--app", input.app)
      pushMatcher(args, input)
      pushBounds(args, input)
      if (verb === "action" && input.action !== undefined) args.push("--action", input.action)
      if (verb === "set-text" && input.text !== undefined) args.push("--text", input.text)
      if (verb !== "action" && input.waitSeconds !== undefined) {
        args.push("--wait-seconds", String(input.waitSeconds))
      }
      if (input.apply && input.expectToken) {
        args.push("--expect-token", input.expectToken, "--apply")
      }
      return { args }
    }
  }
}

export function describeDesktopFailure(error: unknown): string {
  const failure = error as {
    code?: number | string
    killed?: boolean
    stdout?: string
    stderr?: string
    message?: string
  }
  if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return `desktop-control.py output exceeded ${DESKTOP_CONTROL_MAX_OUTPUT_BYTES} bytes; narrow the query`
  }
  if (failure.killed) {
    return `desktop-control.py timed out after ${DESKTOP_CONTROL_TIMEOUT_MS / 1000}s`
  }
  const detail = (failure.stderr ?? "").trim() || (failure.stdout ?? "").trim() || failure.message || "unknown failure"
  const code = typeof failure.code === "number" ? failure.code : "unknown"
  return `desktop-control.py failed (exit ${code}): ${detail}`
}

export function execFileBounded(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: DESKTOP_CONTROL_TIMEOUT_MS, maxBuffer: DESKTOP_CONTROL_MAX_OUTPUT_BYTES, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }))
          return
        }
        resolve({ stdout, stderr })
      },
    )
  })
}

export async function runDesktopControl(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileBounded("python3", [DESKTOP_CONTROL_SCRIPT, ...args])
    return stdout.trim() || "(desktop-control.py returned no output)"
  } catch (error) {
    return describeDesktopFailure(error)
  }
}

export async function executeDesktop(input: DesktopCommandInput): Promise<string> {
  const built = buildDesktopArgs(input)
  if ("error" in built) return `Invalid desktop request: ${built.error}`
  return runDesktopControl(built.args)
}
