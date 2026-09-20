import type { AgentInfo, SessionInfo } from "@opencode/client"

export const MAX_SUBAGENT_ROWS = 32
export const MAX_ACTIVE_SUBAGENT_ROWS = 8
const MAX_DISPLAY_CHARS = 160

export type SubagentStatus = "running" | "idle" | "unknown"

export type SubagentRow = {
  sessionID: string
  agent: string
  model: string
  title: string
  status: SubagentStatus
}

type ParentSession = Pick<SessionInfo, "id" | "projectID" | "location">

function display(value: string, maximum = MAX_DISPLAY_CHARS): string {
  return Array.from(value.replace(/[\u0000-\u001f\u007f]/g, " ")).slice(0, maximum).join("") || "(untitled)"
}

function resolvedModel(model: SessionInfo["model"]): model is NonNullable<SessionInfo["model"]> {
  return Boolean(model && model.providerID && model.id && model.providerID !== "<unresolved>" && model.id !== "<unresolved>")
}

export function modelReference(model: SessionInfo["model"]): string {
  if (!resolvedModel(model)) return "<unresolved>"
  const variant = model.variant && model.variant !== "<unresolved>" ? `#${display(model.variant)}` : ""
  return `${display(model.providerID)}/${display(model.id)}${variant}`
}

export function resolveSubagentRows(
  sessions: readonly SessionInfo[],
  agents: readonly AgentInfo[],
  statuses: ReadonlyMap<string, SubagentStatus>,
  parent: ParentSession,
): SubagentRow[] {
  const children = sessions
    .filter((session) =>
      session.parentID === parent.id &&
      session.projectID === parent.projectID &&
      session.location.directory === parent.location.directory,
    )
    .slice(0, MAX_SUBAGENT_ROWS)
  const neededAgents = new Set(children.map((session) => session.agent).filter((agent): agent is string => agent !== undefined))
  const names = new Map(agents.filter((agent) => neededAgents.has(agent.id)).map((agent) => [agent.id, display(agent.name)]))
  const models = new Map(agents.filter((agent) => neededAgents.has(agent.id)).map((agent) => [agent.id, agent.model]))
  return children
    .map((session) => ({
      sessionID: session.id,
      agent: session.agent ? names.get(session.agent) ?? display(session.agent) : "(unknown agent)",
      model: modelReference(resolvedModel(session.model) ? session.model : models.get(session.agent ?? "")),
      title: display(session.title?.trim() || "(untitled)"),
      status: statuses.get(session.id) ?? "unknown",
    }))
}

export function formatSubagentRow(row: SubagentRow, width: number): string {
  const text = `${row.agent} · ${row.model}: ${row.title}`
  const limit = Math.max(1, Math.floor(width))
  if (Array.from(text).length <= limit) return text
  if (limit === 1) return "…"
  return `${Array.from(text).slice(0, limit - 1).join("")}…`
}

export function activeSubagentRows(rows: readonly SubagentRow[]): SubagentRow[] {
  return rows.filter((row) => row.status === "running").slice(0, MAX_ACTIVE_SUBAGENT_ROWS)
}

export function subagentStatus(session: Pick<SessionInfo, "outcome" | "time">, active: boolean): SubagentStatus {
  return active || (session.outcome === undefined && session.time.idle === undefined) ? "running" : "idle"
}

export function nextSubagentIndex(current: number, length: number, delta: number): number {
  if (length <= 0) return 0
  const start = Math.min(Math.max(0, Math.trunc(current)), length - 1)
  return (start + Math.trunc(delta) % length + length) % length
}

export function subagentAnimationsEnabled(configured: unknown, rendererWidth: number): boolean {
  return configured !== false && rendererWidth >= 100
}

export function subagentActivityLabel(frame?: string): string {
  return `${frame ? `${frame} ` : ""}running`
}
