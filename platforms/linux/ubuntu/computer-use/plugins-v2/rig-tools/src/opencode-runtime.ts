import { createHash, randomBytes } from "node:crypto"

type JsonRecord = Record<string, unknown>

export type RuntimeTarget = "mcp" | "models" | "providers" | "all"

export type RuntimeApi = {
  version: string
  directory: string
  projectID: string
  mcpList(): Promise<unknown>
  pluginList(): Promise<unknown>
  modelList(): Promise<unknown>
  providerList(): Promise<unknown>
  reloadMcp(): Promise<void>
  reloadModels(): Promise<void>
  reloadProviders(): Promise<void>
}

export type RuntimeReloadInput = {
  target: RuntimeTarget
  action?: "preview" | "apply"
  expectToken?: string
}

type Preview = {
  token: string
  sessionID: string
  agent: string
  target: RuntimeTarget
  digest: string
  expiresAt: number
}

const MAX_ITEMS = 128
const PREVIEW_TTL_MS = 60_000
const MAX_PREVIEWS = 64

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function dataValues(value: unknown): unknown[] {
  return isRecord(value) && Array.isArray(value.data) ? value.data : []
}

function boundedValues(data: unknown[]) {
  return { items: data.slice(0, MAX_ITEMS), total: data.length, truncated: data.length > MAX_ITEMS }
}

function boundedData(value: unknown) {
  return boundedValues(dataValues(value))
}

function safeText(value: unknown, fallback = "unknown", maximum = 256) {
  if (typeof value !== "string") return fallback
  const result = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maximum)
  return result || fallback
}

function stateName(value: unknown) {
  return isRecord(value) ? safeText(value.status) : "unknown"
}

function sourceName(value: unknown) {
  if (!isRecord(value)) return "unknown"
  const type = safeText(value.type)
  if (type === "local") return `local:${safeText(value.path, "unknown", 512)}`
  if (type === "npm") return `npm:${safeText(value.package, "unknown", 256)}`
  return type
}

export function summarizeRuntimeResponses(input: {
  version: string
  directory: string
  projectID: string
  mcp: unknown
  plugins: unknown
  models: unknown
  providers: unknown
}) {
  const mcpData = boundedData(input.mcp)
  const allPlugins = dataValues(input.plugins)
  const pluginData = boundedValues(allPlugins.filter((value) => {
    const item = isRecord(value) ? value : {}
    const source = isRecord(item.source) ? safeText(item.source.type) : "unknown"
    return source !== "builtin" || stateName(item.state) !== "active"
  }))
  const modelData = boundedData(input.models)
  const providerData = boundedData(input.providers)
  const mcp = mcpData.items.map((value) => {
    const item = isRecord(value) ? value : {}
    return {
      name: safeText(item.name),
      status: stateName(item.status),
      ...(isRecord(item.status) && typeof item.status.error === "string"
        ? { error: safeText(item.status.error, "unknown", 512) }
        : {}),
    }
  })
  const plugins = pluginData.items.map((value) => {
    const item = isRecord(value) ? value : {}
    return {
      id: safeText(item.id, "anonymous"),
      source: sourceName(item.source),
      status: stateName(item.state),
      features: isRecord(item.features)
        ? Object.entries(item.features)
            .filter(([, enabled]) => enabled === true)
            .map(([name]) => safeText(name))
            .slice(0, 8)
        : [],
    }
  })
  const models = modelData.items
  const providers = providerData.items.map((value) => {
    const item = isRecord(value) ? value : {}
    return {
      id: safeText(item.id),
      activation: safeText(item.activation),
    }
  })
  const modelsByProvider: Record<string, number> = {}
  for (const value of models) {
    const item = isRecord(value) ? value : {}
    const id = safeText(item.providerID)
    modelsByProvider[id] = (modelsByProvider[id] ?? 0) + 1
  }
  const pluginSummary = {
    total: allPlugins.length,
    active: allPlugins.filter((value) => stateName(isRecord(value) ? value.state : undefined) === "active").length,
    failed: allPlugins.filter((value) => stateName(isRecord(value) ? value.state : undefined) === "failed").length,
    builtin: allPlugins.filter((value) => isRecord(value) && isRecord(value.source) && value.source.type === "builtin").length,
    external: allPlugins.filter((value) => !isRecord(value) || !isRecord(value.source) || value.source.type !== "builtin").length,
    detailPolicy: "external-and-failed",
  }
  return {
    version: safeText(input.version),
    location: {
      directory: safeText(input.directory, "unknown", 1024),
      projectID: safeText(input.projectID, "unknown", 256),
    },
    mcp,
    pluginSummary,
    plugins,
    providers,
    modelCount: modelData.total,
    modelsByProvider,
    bounded: {
      maximumItemsPerCollection: MAX_ITEMS,
      truncated: {
        mcp: mcpData.truncated,
        plugins: pluginData.truncated,
        models: modelData.truncated,
        providers: providerData.truncated,
      },
    },
  }
}

export function createOpenCodeRuntimeManager(api: RuntimeApi, now: () => number = Date.now) {
  const previews = new Map<string, Preview>()

  const status = async () => {
    const [mcp, plugins, models, providers] = await Promise.all([
      api.mcpList(),
      api.pluginList(),
      api.modelList(),
      api.providerList(),
    ])
    return summarizeRuntimeResponses({
      version: api.version,
      directory: api.directory,
      projectID: api.projectID,
      mcp,
      plugins,
      models,
      providers,
    })
  }

  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

  const prune = () => {
    const current = now()
    for (const [token, preview] of previews) if (preview.expiresAt <= current) previews.delete(token)
    while (previews.size >= MAX_PREVIEWS) {
      const oldest = previews.keys().next().value as string | undefined
      if (!oldest) break
      previews.delete(oldest)
    }
  }

  const reload = async (input: RuntimeReloadInput, sessionID: string, agent: string) => {
    const action = input.action ?? "preview"
    if (action === "preview") {
      prune()
      const before = await status()
      const token = randomBytes(24).toString("base64url")
      const preview: Preview = {
        token,
        sessionID,
        agent,
        target: input.target,
        digest: digest(before),
        expiresAt: now() + PREVIEW_TTL_MS,
      }
      previews.set(token, preview)
      return {
        dryRun: true,
        target: input.target,
        before,
        expectToken: token,
        expiresAt: preview.expiresAt,
        applyRequires: "action=apply with this expectToken in the same session and agent",
      }
    }

    const token = input.expectToken
    const preview = token ? previews.get(token) : undefined
    if (!preview || preview.expiresAt <= now()) throw new Error("OpenCode reload preview token is missing or expired")
    previews.delete(preview.token)
    if (preview.sessionID !== sessionID || preview.agent !== agent || preview.target !== input.target) {
      throw new Error("OpenCode reload preview token does not match this session, agent, and target")
    }
    const before = await status()
    if (digest(before) !== preview.digest) throw new Error("OpenCode runtime state changed after preview; preview again")

    if (input.target === "providers" || input.target === "all") await api.reloadProviders()
    if (input.target === "models" || input.target === "all") await api.reloadModels()
    if (input.target === "mcp" || input.target === "all") await api.reloadMcp()
    return { dryRun: false, target: input.target, before, after: await status() }
  }

  return { status, reload }
}
