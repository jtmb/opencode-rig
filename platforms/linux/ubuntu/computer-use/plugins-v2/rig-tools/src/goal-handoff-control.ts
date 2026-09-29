import { type ColorInput, type KeyEvent, type MouseEvent, type Renderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import type { JSX } from "@opentui/solid/jsx-runtime"
import { jsx } from "@opentui/solid/jsx-runtime"
import { createEffect, createSignal, onCleanup } from "solid-js"

import type { GoalStateSnapshot } from "./goal-state.ts"

export type GoalHandoffMode = "manual" | "auto"

function boundedObjective(value: string, maximum: number) {
  const characters = Array.from(value.replaceAll("\r", " ").replaceAll("\n", " ").replaceAll("\t", " ").trim())
  return characters.length > maximum ? `${characters.slice(0, maximum - 1).join("")}…` : characters.join("")
}

function footerGoalText(snapshot: GoalStateSnapshot): string {
  if (snapshot.status !== "ready") return `Goal: ${snapshot.status === "loading" ? "loading…" : "unavailable"}`
  const goal = snapshot.goal
  return goal.objective
    ? `Goal: ${goal.status} · ${boundedObjective(goal.objective, 52)}`
    : `Goal: ${goal.status} · no active objective`
}

function footerPreview(snapshot: GoalStateSnapshot): { heading: string; objective?: string } {
  if (snapshot.status !== "ready") {
    return { heading: snapshot.status === "loading" ? "Current Goal objective is loading." : "Current Goal objective is unavailable." }
  }
  const goal = snapshot.goal
  return {
    heading: `Current Goal · ${goal.status}`,
    objective: goal.objective ? boundedObjective(goal.objective, 128) : "No current Goal objective.",
  }
}

export function GoalSummary(props: {
  readonly snapshot: () => GoalStateSnapshot
  readonly textColor: ColorInput
  readonly accentColor: ColorInput
}): JSX.Element {
  return jsx("box", {
    flexDirection: "column",
    marginTop: 1,
    flexShrink: 0,
    children: [
      jsx("text", {
        fg: props.accentColor,
        get children() {
          const snapshot = props.snapshot()
          return snapshot.status === "ready"
            ? `Goal · ${snapshot.goal.status}`
            : `Goal · ${snapshot.status}`
        },
      }),
      jsx("text", {
        fg: props.textColor,
        wrapMode: "word",
        get children() {
          const snapshot = props.snapshot()
          return snapshot.status === "ready"
            ? snapshot.goal.objective
              ? `Objective: ${boundedObjective(snapshot.goal.objective, 160)}`
              : "No active Goal objective."
            : "The current Goal objective is unavailable."
        },
      }),
    ],
  })
}

export function GoalFooterSummary(props: {
  readonly sessionID: string
  readonly snapshot: () => GoalStateSnapshot
  readonly previewEnabled: boolean
  readonly textColor: ColorInput
  readonly accentColor: ColorInput
}): JSX.Element {
  const renderer = useRenderer()
  const [hovered, setHovered] = createSignal(false)
  const [focused, setFocused] = createSignal(false)
  let sessionID = props.sessionID
  const onFocusedRenderable = (renderable: Renderable | null) => {
    setFocused(renderable?.id === "opencode-rig.goal-summary")
  }
  renderer.on("focused_renderable", onFocusedRenderable)
  onCleanup(() => renderer.off("focused_renderable", onFocusedRenderable))
  createEffect(() => {
    if (sessionID !== props.sessionID) {
      sessionID = props.sessionID
      setHovered(false)
    }
  })

  return jsx("box", {
    id: "opencode-rig.goal-summary",
    width: "100%",
    minWidth: 0,
    flexShrink: 1,
    focusable: true,
    onMouseOver: () => setHovered(true),
    onMouseOut: () => setHovered(false),
    children: jsx("text", {
      fg: props.textColor,
      get wrapMode() {
        return props.previewEnabled && (hovered() || focused()) ? "word" : "none"
      },
      get truncate() {
        return !(props.previewEnabled && (hovered() || focused()))
      },
      get children() {
        const snapshot = props.snapshot()
        if (!props.previewEnabled || (!hovered() && !focused())) return footerGoalText(snapshot)
        const preview = footerPreview(snapshot)
        return [
          footerGoalText(snapshot),
          "\n",
          jsx("span", { fg: props.accentColor, children: preview.heading }),
          ...(preview.objective ? ["\n", preview.objective] : []),
        ]
      },
    }),
  })
}

export function GoalHandoffControl(props: {
  readonly mode?: GoalHandoffMode
  readonly busy?: boolean
  readonly textColor: ColorInput
  readonly accentColor: ColorInput
  readonly onToggle: () => void
}): JSX.Element {
  const activate = (event: MouseEvent & { __rigHandled?: boolean }) => {
    if (event.__rigHandled || event.button !== 0 || props.busy) return
    event.__rigHandled = true
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget?.focus()
    props.onToggle()
  }

  return jsx("box", {
    id: "opencode-rig.goal-handoff",
    flexDirection: "row",
    flexShrink: 0,
    focusable: true,
    onMouseDown: activate,
    onKeyDown: (event: KeyEvent) => {
      if (props.busy || (event.name !== "return" && event.name !== "space")) return
      event.preventDefault()
      event.stopPropagation()
      props.onToggle()
    },
    children: [
      jsx("text", { fg: props.textColor, wrapMode: "none", children: "Goal · " }),
      jsx("text", {
        fg: props.accentColor,
        wrapMode: "none",
        get children() {
          return `Handoff: ${props.busy ? "switching…" : props.mode === "auto" ? "Auto" : props.mode === "manual" ? "Manual" : "…"}`
        },
      }),
    ],
  })
}
