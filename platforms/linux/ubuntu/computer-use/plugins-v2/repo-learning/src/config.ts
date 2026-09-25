export type RepoLearningOptions = {
  enabled: boolean
}

export type RepoLearningOptionSchema = {
  enabled: {
    type: "boolean"
    default: boolean
    description: string
  }
}

export const REPO_LEARNING_OPTIONS_SCHEMA: RepoLearningOptionSchema = {
  enabled: {
    type: "boolean",
    default: true,
    description: "Repository learning is active unless this is explicitly false.",
  },
}

export const DEFAULT_REPO_LEARNING_OPTIONS: Readonly<RepoLearningOptions> = Object.freeze({
  enabled: REPO_LEARNING_OPTIONS_SCHEMA.enabled.default,
})

export type RepoLearningOptionsResult = {
  options: RepoLearningOptions
  diagnostics: string[]
}

const MAX_DIAGNOSTICS = 16

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Validate the object passed by the v2 plugin entry's `options` property. */
export function resolveRepoLearningOptions(value: unknown): RepoLearningOptionsResult {
  const diagnostics: string[] = []
  if (value === undefined) return { options: { ...DEFAULT_REPO_LEARNING_OPTIONS }, diagnostics }
  if (!isRecord(value)) {
    return {
      options: { ...DEFAULT_REPO_LEARNING_OPTIONS },
      diagnostics: ["repo-learning options must be an object; using enabled=true"],
    }
  }

  let enabled = DEFAULT_REPO_LEARNING_OPTIONS.enabled
  try {
    if (Object.prototype.hasOwnProperty.call(value, "enabled")) {
      const configured = value["enabled"]
      if (typeof configured === "boolean") enabled = configured
      else diagnostics.push("repo-learning option enabled must be a boolean; using enabled=true")
    }
    const unknown = Object.keys(value).filter((key) => key !== "enabled")
    if (unknown.length > 0) {
      diagnostics.push(`${unknown.length} unsupported repo-learning option${unknown.length === 1 ? "" : "s"} ignored`)
    }
  } catch {
    diagnostics.push("repo-learning options could not be read safely; using enabled=true")
    enabled = DEFAULT_REPO_LEARNING_OPTIONS.enabled
  }

  return {
    options: { enabled },
    diagnostics: diagnostics.slice(0, MAX_DIAGNOSTICS),
  }
}
