import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import {
  calculateMemoryBudget,
  executableInPath,
  readMemoryProbe,
  type MemoryBudget,
  type MemoryProbe,
} from "./memory.ts"

export type GithubMcpCommand = string | readonly string[]

export type GithubMcpToolCaller = (name: string, arguments_: Record<string, unknown>) => Promise<unknown>

export type GithubMcpClient = {
  callTool: GithubMcpToolCaller
  dispose: () => Promise<void>
}

export type BoundedMcpCommand = {
  command: string
  args: string[]
  budget: MemoryBudget
}

const CONNECT_TIMEOUT_MS = 10_000
const CALL_TIMEOUT_MS = 15_000
const MCP_MEMORY_FRACTION = 20
const MCP_SWAP_FRACTION = 25

function timeout<T>(promise: Promise<T>, milliseconds: number, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${operation} timed out after ${milliseconds}ms`)), milliseconds)
  })
  return Promise.race([promise, expiry]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function commandParts(command: GithubMcpCommand): [string, string[]] {
  const parts = Array.isArray(command) ? [...command] : [command]
  const executable = parts.shift()?.trim()
  if (!executable) throw new Error("githubMcpCommand must name an executable")
  return [executable, parts]
}

function processEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

export function defaultGithubMcpCommand(): string {
  return fileURLToPath(new URL("../../../scripts/github-mcp.sh", import.meta.url))
}

function userSystemdAvailable(systemctl: string | undefined): boolean {
  if (!systemctl) return false
  try {
    execFileSync(systemctl, ["--user", "show-environment"], {
      stdio: "ignore",
      timeout: 1_000,
    })
    return true
  } catch {
    return false
  }
}

export function boundedGithubMcpCommand(
  command: GithubMcpCommand = defaultGithubMcpCommand(),
  probe: MemoryProbe = readMemoryProbe(),
): BoundedMcpCommand | undefined {
  const systemdRun = executableInPath("systemd-run")
  const systemctl = executableInPath("systemctl")
  const prlimit = executableInPath("prlimit")
  const budget = calculateMemoryBudget(probe, {
    memoryFraction: MCP_MEMORY_FRACTION,
    swapFraction: MCP_SWAP_FRACTION,
  })
  if (!budget) return undefined

  const [executable, args] = commandParts(command)
  if (systemdRun && userSystemdAvailable(systemctl)) {
    return {
      command: systemdRun,
      args: [
        "--user",
        "--pipe",
        "--wait",
        "--collect",
        "--service-type=exec",
        `--working-directory=${process.cwd()}`,
        `--setenv=PATH=${process.env.PATH ?? ""}`,
        `--setenv=HOME=${process.env.HOME ?? ""}`,
        `--property=MemoryMax=${budget.memoryMaxBytes}`,
        `--property=MemorySwapMax=${budget.swapMaxBytes}`,
        "--",
        executable,
        ...args,
      ],
      budget,
    }
  }
  if (!prlimit) return undefined
  return {
    command: prlimit,
    args: [
      `--as=${budget.memoryMaxBytes}`,
      "--",
      executable,
      ...args,
    ],
    budget,
  }
}

export function createGithubMcpClient(command: GithubMcpCommand = defaultGithubMcpCommand()): GithubMcpClient {
  let client: Client | undefined
  let transport: StdioClientTransport | undefined
  let connection: Promise<Client> | undefined
  let disposed = false

  const connect = async (): Promise<Client> => {
    if (disposed) throw new Error("GitHub MCP client is disposed")
    if (connection) return connection

    connection = (async () => {
      const bounded = boundedGithubMcpCommand(command)
      if (!bounded) throw new Error("adaptive GitHub MCP memory budget is unavailable")
      transport = new StdioClientTransport({
        command: bounded.command,
        args: bounded.args,
        env: processEnvironment(),
      })
      const next = new Client({ name: "opencode-source-control", version: "0.1.0" })
      await timeout(next.connect(transport), CONNECT_TIMEOUT_MS, "GitHub MCP initialize")
      client = next
      return next
    })()

    try {
      return await connection
    } catch (error) {
      connection = undefined
      const failed = client
      client = undefined
      await failed?.close().catch(() => undefined)
      await transport?.close().catch(() => undefined)
      transport = undefined
      throw error
    }
  }

  const callTool: GithubMcpToolCaller = async (name, arguments_) => {
    try {
      const connected = await connect()
      return await timeout(
        connected.callTool({ name, arguments: arguments_ }),
        CALL_TIMEOUT_MS,
        `GitHub MCP ${name}`,
      )
    } catch (error) {
      const failed = client
      client = undefined
      connection = undefined
      await failed?.close().catch(() => undefined)
      await transport?.close().catch(() => undefined)
      transport = undefined
      throw error
    }
  }

  const dispose = async () => {
    disposed = true
    const active = client
    client = undefined
    connection = undefined
    await active?.close().catch(() => undefined)
    await transport?.close().catch(() => undefined)
    transport = undefined
  }

  return { callTool, dispose }
}
