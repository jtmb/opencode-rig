import { normalizeChanges, type SourceControlChange } from "./changes.ts"
import type { GithubMcpToolCaller } from "./mcp.ts"
import {
  fetchCurrentBranchPullRequest,
  readGithubContext,
  type GithubContext,
  type GithubPullRequest,
  type GithubRemote,
  type RunGit,
} from "./github.ts"

type VcsStatusResult = {
  data?: unknown
  error?: unknown
}

export type SourceControlState = {
  status: "idle" | "loading" | "ready" | "error"
  isGit: boolean
  directory?: string
  branch?: string
  remote?: GithubRemote
  changes: readonly SourceControlChange[]
  pullRequest?: GithubPullRequest
  error?: string
  githubError?: string
  updatedAt?: number
  githubUpdatedAt?: number
}

export type SourceControlStore = {
  getState: () => SourceControlState
  subscribe: (listener: (state: SourceControlState) => void) => () => void
  refreshLocal: (directory: string, branch?: string) => Promise<void>
  refreshGithub: (directory: string, branch?: string) => Promise<void>
  dispose: () => void
}

export type SourceControlStoreOptions = {
  status: (parameters: { directory: string }) => Promise<unknown>
  github: boolean
  remoteName: string
  githubToolCaller?: GithubMcpToolCaller
  runGit?: RunGit
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return "Unknown refresh error"
}

function resultData(value: unknown): unknown {
  if (Array.isArray(value)) return value
  if (typeof value !== "object" || value === null) return undefined
  const result = value as VcsStatusResult
  if (result.error !== undefined) throw new Error(errorMessage(result.error))
  return result.data
}

export function createSourceControlStore(options: SourceControlStoreOptions): SourceControlStore {
  let state: SourceControlState = {
    status: "idle",
    isGit: false,
    changes: [],
  }
  const listeners = new Set<(state: SourceControlState) => void>()
  let localInFlight: Promise<void> | undefined
  let githubInFlight: Promise<void> | undefined
  let disposed = false

  const update = (patch: Partial<SourceControlState>) => {
    if (disposed) return
    state = { ...state, ...patch }
    for (const listener of listeners) listener(state)
  }

  const refreshLocal = (directory: string, branch?: string): Promise<void> => {
    if (localInFlight) return localInFlight
    localInFlight = (async () => {
      const nextBranch = branch ?? state.branch
      const contextChanged = state.directory !== directory || state.branch !== nextBranch
      update({
        directory,
        branch: nextBranch,
        status: state.status === "idle" ? "loading" : state.status,
        ...(contextChanged
          ? {
              isGit: false,
              changes: [],
              remote: undefined,
              pullRequest: undefined,
              githubError: undefined,
            }
          : {}),
      })
      try {
        const result = await options.status({ directory })
        const changes = normalizeChanges(resultData(result))
        update({
          status: "ready",
          isGit: true,
          directory,
          branch: nextBranch,
          changes,
          error: undefined,
          updatedAt: Date.now(),
        })
      } catch (error) {
        update({ status: "error", directory, branch: nextBranch, error: errorMessage(error) })
      } finally {
        localInFlight = undefined
      }
    })()
    return localInFlight
  }

  const refreshGithub = (directory: string, branch?: string): Promise<void> => {
    const caller = options.githubToolCaller
    if (!options.github || !caller) return Promise.resolve()
    if (githubInFlight) return githubInFlight

    githubInFlight = (async () => {
      try {
        const context: GithubContext = await readGithubContext(directory, options.remoteName, options.runGit)
        const activeBranch = branch ?? context.branch
        const remote = context.remote
        update({ directory, branch: activeBranch ?? state.branch, remote })
        if (!activeBranch || !remote) {
          update({ pullRequest: undefined, githubError: undefined, githubUpdatedAt: Date.now() })
          return
        }
        const pullRequest = await fetchCurrentBranchPullRequest(remote, activeBranch, caller)
        update({
          pullRequest,
          remote,
          branch: activeBranch,
          githubError: undefined,
          githubUpdatedAt: Date.now(),
        })
      } catch (error) {
        update({ githubError: errorMessage(error) })
      } finally {
        githubInFlight = undefined
      }
    })()
    return githubInFlight
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refreshLocal,
    refreshGithub,
    dispose() {
      disposed = true
      listeners.clear()
    },
  }
}

export type { SourceControlChange }
