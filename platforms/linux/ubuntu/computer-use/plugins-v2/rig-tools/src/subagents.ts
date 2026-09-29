import type { AgentInfo, SessionInfo } from "@opencode/client"
import type { ColorInput } from "@opentui/core"

import { sidebarPalette } from "./palette.ts"

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

export type ActiveSubagentRowTheme = {
  readonly hue: {
    readonly accent: Readonly<Record<200, ColorInput>>
  }
  readonly text: {
    readonly default: ColorInput
    readonly subdued: ColorInput
    readonly action: {
      readonly primary: {
        readonly default?: ColorInput
      }
    }
  }
  readonly background: {
    readonly default: ColorInput
    readonly action: {
      readonly primary: {
        readonly default: ColorInput
        readonly selected?: ColorInput
      }
    }
  }
  readonly syntax?: {
    readonly keyword?: ColorInput
    readonly type?: ColorInput
  }
}

export type ActiveSubagentRowStyle = {
  readonly backgroundColor: ColorInput
  readonly markerColor: ColorInput
  readonly agentColor: ColorInput
  readonly modelColor: ColorInput
  readonly taskColor: ColorInput
  readonly backgroundToken: "background.default" | "background.action.primary.default" | "background.action.primary.selected"
  readonly markerToken: "hue.accent.200"
  readonly agentToken: "text.default" | "text.action.primary.default"
  readonly modelToken: "text.default" | "text.subdued" | "text.action.primary.default"
  readonly taskToken: "text.default" | "text.subdued" | "text.action.primary.default"
}

export function activeSubagentRowStyle(theme: ActiveSubagentRowTheme, focused: boolean): ActiveSubagentRowStyle {
  void focused
  const palette = sidebarPalette(theme)
  return {
    backgroundColor: theme.background.default,
    markerColor: palette.sectionCount,
    agentColor: palette.primary,
    modelColor: palette.subdued,
    taskColor: palette.subdued,
    backgroundToken: "background.default",
    markerToken: "hue.accent.200",
    agentToken: "text.default",
    modelToken: "text.subdued",
    taskToken: "text.subdued",
  }
}

type ParentSession = Pick<SessionInfo, "id" | "projectID">

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
      session.projectID === parent.projectID,
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
