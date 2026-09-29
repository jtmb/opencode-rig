import { TextAttributes, type ColorInput } from "@opentui/core"
import type { JSX } from "@opentui/solid/jsx-runtime"
import { jsx } from "@opentui/solid/jsx-runtime"

import type { SubagentHistoryEventRow } from "./subagent-history.ts"

export type SubagentsHistoryProps = {
  readonly rows: readonly SubagentHistoryEventRow[]
  readonly page: number
  readonly hasMore: boolean
  readonly truncated: boolean
  readonly loaded: boolean
  readonly textColor: ColorInput
  readonly subduedColor: ColorInput
  readonly accentColor: ColorInput
}

function shortTime(at: string): string {
  return at.includes("T") ? at.replace("T", " ").slice(0, 19) : at
}

/**
 * Read-only history section for the `/subagents` audit panel. It renders only
 * public raw-observation rows (no session IDs, no prompts) and wraps long
 * titles instead of truncating them.
 */
export function SubagentsHistory(props: SubagentsHistoryProps): JSX.Element {
  const children: JSX.Element[] = [
    jsx("text", { fg: props.accentColor, children: jsx("b", { children: "History" }) }),
  ]
  if (props.loaded && props.rows.length === 0) {
    children.push(jsx("text", { fg: props.subduedColor, children: "No archived subagent history yet." }))
  }
  for (const row of props.rows) {
    children.push(jsx("text", {
      wrapMode: "word",
      fg: props.subduedColor,
      children: `${shortTime(row.at)} · ${row.status} · ${row.agent} · ${row.model}: ${row.title}`,
    }))
  }
  children.push(jsx("text", {
    fg: props.subduedColor,
    attributes: TextAttributes.DIM,
    children: `history page ${props.page + 1}${props.hasMore ? " · more available" : ""}${props.truncated ? " · bounded scan" : ""}`,
  }))
  return jsx("box", { flexDirection: "column", width: "100%", children })
}
