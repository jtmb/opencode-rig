import { TextAttributes, type BoxRenderable, type ColorInput, type KeyEvent, type MouseEvent } from "@opentui/core"
import type { JSX } from "@opentui/solid/jsx-runtime"
import { jsx } from "@opentui/solid/jsx-runtime"

import { activeSubagentRowStyle, subagentActivityLabel, type ActiveSubagentRowTheme, type SubagentRow } from "./subagents.ts"

export type ActiveSubagentRowProps = {
  readonly row: SubagentRow
  readonly theme: ActiveSubagentRowTheme
  readonly focused: boolean
  readonly activityFrame?: string
  readonly onRef?: (value: BoxRenderable) => void
  readonly onMouseOver?: () => void
  readonly onFocus?: () => void
  readonly onOpen: () => void
  readonly onMove: (delta: number) => void
}

export function ActiveSubagentsHeading(props: {
  readonly count: number
  readonly collapsed: boolean
  readonly textColor: ColorInput
  readonly accentColor: ColorInput
  readonly onRef?: (value: BoxRenderable) => void
  readonly onFocus?: () => void
  readonly onToggle: () => void
}): JSX.Element {
  const activate = (event: MouseEvent & { __rigHandled?: boolean }) => {
    if (event.__rigHandled || event.button !== 0) return
    event.__rigHandled = true
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget?.focus()
    props.onFocus?.()
    props.onToggle()
  }
  return jsx("box", {
    id: "opencode-rig.active-subagents.heading",
    ref: (value: BoxRenderable) => props.onRef?.(value),
    flexDirection: "row",
    width: "100%",
    focusable: true,
    onMouseDown: activate,
    onKeyDown: (event: KeyEvent) => {
      if (event.name !== "return" && event.name !== "space") return
      event.preventDefault()
      event.stopPropagation()
      props.onFocus?.()
      props.onToggle()
    },
    children: [
      jsx("text", {
        fg: props.textColor,
        children: jsx("b", { get children() { return `${props.collapsed ? "+" : "-"} Active Subagents` } }),
      }),
      jsx("text", {
        fg: props.accentColor,
        attributes: TextAttributes.BOLD,
        get children() { return ` ${props.count}` },
      }),
    ],
  })
}

export function ActiveSubagentRow(props: ActiveSubagentRowProps): JSX.Element {
  const style = () => activeSubagentRowStyle(props.theme, props.focused)
  return jsx("box", {
    id: `opencode-rig.active-subagents.row.${props.row.sessionID}`,
    ref: (value: BoxRenderable) => props.onRef?.(value),
    flexDirection: "column",
    width: "100%",
    focusable: true,
    paddingLeft: 1,
    paddingRight: 1,
    get backgroundColor() { return style().backgroundColor },
    onMouseOver: () => props.onMouseOver?.(),
    onMouseDown: (event: MouseEvent) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      event.currentTarget?.focus()
      props.onFocus?.()
      props.onOpen()
    },
    onKeyDown: (event: KeyEvent) => {
      props.onFocus?.()
      if (event.name === "return" || event.name === "space") {
        event.preventDefault()
        event.stopPropagation()
        props.onOpen()
        return
      }
      if (event.name === "up" || event.name === "k" || event.name === "down" || event.name === "j") {
        event.preventDefault()
        event.stopPropagation()
        props.onMove(event.name === "up" || event.name === "k" ? -1 : 1)
      }
    },
    children: [
      jsx("text", {
        wrapMode: "word",
        children: [
          jsx("span", {
            get style() { return { fg: style().markerColor } },
            children: subagentActivityLabel(props.activityFrame),
          }),
          jsx("span", {
            get style() { return { fg: style().agentColor } },
            children: jsx("b", { children: ` · Agent · ${props.row.agent}` }),
          }),
        ],
      }),
      jsx("box", {
        flexDirection: "column",
        paddingLeft: 2,
        minWidth: 0,
        flexShrink: 1,
        children: [
          jsx("text", {
            wrapMode: "word",
            attributes: TextAttributes.DIM,
            get fg() { return style().modelColor },
            children: `Model · ${props.row.model}`,
          }),
          jsx("text", {
            wrapMode: "word",
            attributes: TextAttributes.DIM,
            get fg() { return style().taskColor },
            children: `Task · ${props.row.title}`,
          }),
        ],
      }),
    ],
  })
}
