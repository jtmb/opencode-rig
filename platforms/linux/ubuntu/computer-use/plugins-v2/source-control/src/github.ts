import { execFile } from "node:child_process"
import { promisify } from "node:util"

import type { GithubMcpToolCaller } from "./mcp.ts"

const execFileAsync = promisify(execFile)

export type GithubRemote = {
  owner: string
  repo: string
}

export type GithubCheckState = "passing" | "failing" | "pending" | "unknown"

export type GithubPullRequest = {
  number: number
  state: string
  checks: GithubCheckState
  title?: string
  url?: string
}

export type RunGit = (args: readonly string[], directory: string) => Promise<string>

export type GithubContext = {
  branch?: string
  remote?: GithubRemote
}

export function parseGithubRemote(value: string): GithubRemote | undefined {
  const input = value.trim()
  if (!input) return undefined

  let host: string | undefined
  let path: string | undefined
  const scp = input.match(/^git@([^:]+):(.+)$/)
  if (scp) {
    host = scp[1]
    path = scp[2]
  } else {
    try {
      const url = new URL(input)
      host = url.hostname
      path = url.pathname
    } catch {
      return undefined
    }
  }

  if (host?.toLowerCase() !== "github.com" || !path) return undefined
  const segments = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").split("/")
  if (segments.length !== 2 || !segments[0] || !segments[1]) return undefined
  return { owner: segments[0], repo: segments[1] }
}

async function runGit(args: readonly string[], directory: string): Promise<string> {
  const result = await execFileAsync("git", [...args], {
    cwd: directory,
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    encoding: "utf8",
  })
  return result.stdout.trim()
}

async function optionalGit(run: RunGit, args: readonly string[], directory: string): Promise<string | undefined> {
  try {
    const value = await run(args, directory)
    return value || undefined
  } catch {
    return undefined
  }
}

export async function readGithubContext(
  directory: string,
  remoteName: string,
  git: RunGit = runGit,
): Promise<GithubContext> {
  const [branch, remoteUrl] = await Promise.all([
    optionalGit(git, ["branch", "--show-current"], directory),
    optionalGit(git, ["remote", "get-url", remoteName], directory),
  ])
  return { branch, remote: remoteUrl ? parseGithubRemote(remoteUrl) : undefined }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}

function parseTextContent(value: unknown): unknown {
  const object = objectValue(value)
  const content = object?.content
  if (!Array.isArray(content)) return value
  const text = content.find((item) => objectValue(item)?.type === "text")
  const raw = objectValue(text)?.text
  if (typeof raw !== "string") return value
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

function toolPayload(value: unknown): unknown {
  const parsed = parseTextContent(value)
  const object = objectValue(parsed)
  return object?.structuredContent ?? object?.data ?? parsed
}

function listItems(value: unknown): readonly Record<string, unknown>[] {
  const payload = toolPayload(value)
  if (Array.isArray(payload)) return payload.flatMap((item) => (objectValue(item) ? [objectValue(item)!] : []))
  const object = objectValue(payload)
  if (!object) return []
  for (const key of ["pullRequests", "pull_requests", "items", "results", "data"]) {
    if (Array.isArray(object[key])) {
      return object[key].flatMap((item) => (objectValue(item) ? [objectValue(item)!] : []))
    }
  }
  return []
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value)
  return undefined
}

function textValue(object: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof object[key] === "string" && object[key]) return object[key] as string
  }
  return undefined
}

function collectCheckStates(value: unknown, output: GithubCheckState[]): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectCheckStates(item, output))
    return
  }
  const object = objectValue(value)
  if (!object) return

  for (const key of ["conclusion", "status", "state"]) {
    const raw = object[key]
    if (typeof raw !== "string") continue
    const normalized = raw.toLowerCase().replace(/[ -]/g, "_")
    if (["success", "successful", "passed", "passing", "green"].includes(normalized)) output.push("passing")
    if (["failure", "failed", "failing", "error", "cancelled", "timed_out", "action_required"].includes(normalized)) {
      output.push("failing")
    }
    if (["pending", "queued", "in_progress", "requested", "waiting", "expected"].includes(normalized)) {
      output.push("pending")
    }
  }

  for (const [key, nested] of Object.entries(object)) {
    if (["conclusion", "status", "state"].includes(key)) continue
    if (key === "head" || key === "base" || key === "user") continue
    if (typeof nested === "object") collectCheckStates(nested, output)
  }
}

export function summarizeChecks(value: unknown): GithubCheckState {
  const states: GithubCheckState[] = []
  collectCheckStates(toolPayload(value), states)
  if (states.includes("failing")) return "failing"
  if (states.includes("pending")) return "pending"
  if (states.includes("passing")) return "passing"
  return "unknown"
}

export async function fetchCurrentBranchPullRequest(
  remote: GithubRemote,
  branch: string,
  callTool: GithubMcpToolCaller,
): Promise<GithubPullRequest | undefined> {
  const response = await callTool("list_pull_requests", {
    owner: remote.owner,
    repo: remote.repo,
    state: "open",
    head: `${remote.owner}:${branch}`,
    fields: ["number", "state", "title", "html_url"],
  })
  const pullRequest = listItems(response)
    .map((item) => ({
      number: numberValue(item.number ?? item.pullNumber ?? item.pull_number),
      state: (textValue(item, "state") ?? "open").toLowerCase(),
      title: textValue(item, "title"),
      url: textValue(item, "html_url", "url"),
    }))
    .find((item) => item.number !== undefined)
  if (!pullRequest?.number) return undefined

  const status = await callTool("pull_request_read", {
    owner: remote.owner,
    repo: remote.repo,
    pullNumber: pullRequest.number,
    method: "get_status",
  })
  return {
    number: pullRequest.number,
    state: pullRequest.state,
    checks: summarizeChecks(status),
    title: pullRequest.title,
    url: pullRequest.url,
  }
}
