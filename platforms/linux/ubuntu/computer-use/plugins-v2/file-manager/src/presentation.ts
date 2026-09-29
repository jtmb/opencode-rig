import type { ColorInput, ScrollBoxRenderable } from "@opentui/core"
import { For, createEffect } from "solid-js"
import { jsx } from "@opentui/solid/jsx-runtime"

import { cellWidth, truncateToCellWidth, type TreeRow } from "./model.ts"

export const EXPLORER_TAB_LABEL_CELLS = 20
export const EXPLORER_TAB_PADDING_CELLS = 1

export interface ExplorerPalette {
  accent: ColorInput
  text: ColorInput
  subdued: ColorInput
  selected: ColorInput
}

export interface ExplorerTreeProps {
  rows: () => readonly TreeRow[]
  selected: () => string
  width: () => number
  palette: ExplorerPalette
  reviewed?: () => ReadonlySet<string>
  onActivate: (row: TreeRow) => void
  onHover?: (path: string | undefined) => void
  scrollRef?: (value: ScrollBoxRenderable) => void
}

export const explorerTreeRowId = (path: string) => `explorer-tree-row:${encodeURIComponent(path)}`
export const explorerTabId = (path: string) => `explorer-tab:${encodeURIComponent(path)}`
const SolidFor = For as unknown as (props: Record<string, unknown>) => ReturnType<typeof jsx>

export type ExplorerTreeRowPresentation = {
  selected: boolean
  paddingLeft: number
  marker: string
  branch: string
  label: string
  status: string
  cells: number
}

/** Compute the exact bounded pieces rendered by ExplorerTree. Keeping the
 * marker in the row text makes selection discernible even when theme
 * background colors are visually similar. */
export function explorerTreeRowPresentation(row: TreeRow, selectedPath: string, width: number): ExplorerTreeRowPresentation {
  const boundedWidth = Math.max(0, Math.floor(width))
  const marker = row.node.path === selectedPath ? "> " : "  "
  const branch = row.node.type === "directory" ? (row.expanded ? "- " : "+ ") : "  "
  const status = row.node.diffStatus === "modified" ? "M" : row.node.diffStatus === "added" ? "A" : row.node.diffStatus === "deleted" ? "D" : ""
  const fixedCells = cellWidth(marker) + cellWidth(branch) + 2
  const paddingLeft = Math.min(row.depth * 2 + 1, Math.max(0, boundedWidth - fixedCells))
  const label = truncateToCellWidth(row.node.name, Math.max(0, boundedWidth - paddingLeft - fixedCells))
  return {
    selected: row.node.path === selectedPath,
    paddingLeft,
    marker,
    branch,
    label,
    status,
    cells: paddingLeft + fixedCells + cellWidth(label),
  }
}

export type ExplorerTabEntry = { path: string; dirty: boolean }

export type ExplorerTabPresentation = {
  label: string
  dirtyMarker: string
  paddingLeft: number
  paddingRight: number
  cells: number
}

/** Tabs use real padding on both sides, so neighboring labels never merge and
 * the padding remains part of each tab's mouse hitbox. */
export function explorerTabPresentation(entry: ExplorerTabEntry): ExplorerTabPresentation {
  const label = truncateToCellWidth(entry.path.split("/").at(-1) ?? entry.path, EXPLORER_TAB_LABEL_CELLS)
  const dirtyMarker = entry.dirty ? " •" : ""
  return {
    label,
    dirtyMarker,
    paddingLeft: EXPLORER_TAB_PADDING_CELLS,
    paddingRight: EXPLORER_TAB_PADDING_CELLS,
    cells: EXPLORER_TAB_PADDING_CELLS * 2 + cellWidth(label) + cellWidth(dirtyMarker),
  }
}

/** Production tree rows, kept outside the plugin context so terminal hit
 * testing can exercise the exact boxes used by the live Explorer. */
export function ExplorerTree(props: ExplorerTreeProps) {
  let scrollBox: ScrollBoxRenderable | undefined
  createEffect(() => {
    const path = props.selected()
    if (path && scrollBox) scrollBox.scrollChildIntoView(explorerTreeRowId(path))
  })
  return jsx("scrollbox", {
    flexGrow: 1,
    minHeight: 0,
    overflow: "hidden",
    ref: (value: ScrollBoxRenderable) => {
      scrollBox = value
      props.scrollRef?.(value)
    },
    children: jsx(SolidFor, {
      get each() { return props.rows() },
      children: (row: TreeRow) => {
        const presentation = () => explorerTreeRowPresentation(row, props.selected(), props.width())
        return jsx("box", {
          id: explorerTreeRowId(row.node.path),
          height: 1,
          flexShrink: 0,
          flexDirection: "row",
          overflow: "hidden",
          get backgroundColor() { return presentation().selected ? props.palette.selected : undefined },
          get paddingLeft() { return presentation().paddingLeft },
          onMouseOver: () => props.onHover?.(row.node.path),
          onMouseOut: () => props.onHover?.(undefined),
          onMouseDown: (event: { button?: number; preventDefault?: () => void; __rigHandled?: boolean }) => {
            if (event.__rigHandled || (event.button !== undefined && event.button !== 0)) return
            event.__rigHandled = true
            event.preventDefault?.()
            props.onActivate(row)
          },
          children: [
            jsx("text", { fg: props.palette.accent, get children() { return presentation().marker } }),
            jsx("text", { get fg() { return presentation().selected ? props.palette.accent : props.palette.subdued }, get children() { return presentation().branch } }),
            jsx("text", { flexGrow: 1, get fg() { return props.reviewed?.().has(row.node.path) ? props.palette.subdued : presentation().selected ? props.palette.accent : props.palette.text }, get children() { return presentation().label } }),
            jsx("text", { get fg() { return props.palette.subdued }, get children() { return `${props.reviewed?.().has(row.node.path) ? "✓" : " "}${presentation().status || " "}` } }),
          ],
        })
      },
    }),
  })
}

export interface ExplorerTabsProps {
  paths: () => readonly ExplorerTabEntry[]
  active: () => string
  palette: ExplorerPalette
  onActivate: (path: string) => void
}

export function ExplorerTabs(props: ExplorerTabsProps) {
  return jsx("box", {
    flexDirection: "row",
    height: 1,
    flexShrink: 0,
    overflow: "hidden",
    children: jsx(SolidFor, {
      get each() { return props.paths() },
      children: (entry: ExplorerTabEntry) => {
        const presentation = explorerTabPresentation(entry)
        return jsx("box", {
          id: explorerTabId(entry.path),
          height: 1,
          flexShrink: 0,
          flexDirection: "row",
          overflow: "hidden",
          paddingLeft: presentation.paddingLeft,
          paddingRight: presentation.paddingRight,
          get backgroundColor() { return entry.path === props.active() ? props.palette.selected : undefined },
          onMouseDown: (event: { button?: number; preventDefault?: () => void; __rigHandled?: boolean }) => {
            if (event.__rigHandled || (event.button !== undefined && event.button !== 0)) return
            event.__rigHandled = true
            event.preventDefault?.()
            props.onActivate(entry.path)
          },
          children: [
            jsx("text", { get fg() { return entry.path === props.active() ? props.palette.accent : props.palette.text }, children: presentation.label }),
            entry.dirty ? jsx("text", { fg: props.palette.accent, children: presentation.dirtyMarker }) : null,
          ],
        })
      },
    }),
  })
}
