import assert from "node:assert/strict"
import test from "node:test"

import { testRender } from "@opentui/solid"
import type { TestRendererSetup } from "@opentui/core/testing"
import { jsx } from "@opentui/solid/jsx-runtime"
import { createSignal } from "solid-js"

import { ExplorerTabs, ExplorerTree, explorerTabPresentation } from "../src/presentation.ts"
import type { FileNode, TreeRow } from "../src/model.ts"

const palette = { accent: "#8cc8ff", text: "#ffffff", subdued: "#888888", selected: "#333333" }
let renderUnavailable = ""
const node = (path: string, type: "file" | "directory" = "file"): FileNode => ({
  name: path.split("/").at(-1) ?? path,
  path,
  type,
  ignored: false,
})
const rows = (...nodes: FileNode[]): TreeRow[] => nodes.map((entry) => ({ node: entry, depth: 0, expanded: entry.type === "directory" }))

async function renderTree(treeRows: TreeRow[], width = 30, height = 8) {
  const [selected, setSelected] = createSignal(treeRows[0]?.node.path ?? "")
  let scrollBox: { scrollTop: number } | undefined
  let activations = 0
  let setup: TestRendererSetup
  try {
    setup = await testRender(() => jsx("box", {
    width,
    height,
    borderStyle: "single",
    children: jsx(ExplorerTree as unknown as (props: Record<string, unknown>) => ReturnType<typeof jsx>, {
      rows: () => treeRows,
      selected,
      width: () => width - 2,
      palette,
      scrollRef: (value: { scrollTop: number }) => (scrollBox = value),
      onActivate: (row: TreeRow) => {
        activations += 1
        setSelected(row.node.path)
      },
    }),
    }), { width, height })
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("OpenTUI native FFI is not available for this runtime yet")) throw error
    renderUnavailable = error.message
    return undefined
  }
  await setup.flush()
  return { setup, selected, setSelected, get scrollBox() { return scrollBox }, get activations() { return activations } }
}

test("rendered tree keeps hostile names inside one-line bordered rows", async () => {
  const view = await renderTree(rows(node("very-long\nname\t東京"), node("普通-unicode.ts")), 24, 6)
  if (!view) return test.skip(`OpenTUI rendered harness unavailable: ${renderUnavailable}`)
  const frame = view.setup.captureCharFrame()
  const lines = frame.split("\n")
  assert.ok(lines.length >= 6)
  assert.ok(lines.every((line) => line.length <= 24), frame)
  assert.ok(lines.some((line) => line.includes("�") || line.includes("…")))
  assert.ok(frame.includes("> "), frame)
  assert.ok(view.setup.captureSpans())
  view.setup.renderer.destroy()
})

test("mockMouse bubbles a row click once and tabs activate once", async () => {
  const view = await renderTree(rows(node("src", "directory"), node("file.ts")), 30, 6)
  if (!view) return test.skip(`OpenTUI rendered harness unavailable: ${renderUnavailable}`)
  assert.ok(view.setup.captureCharFrame().includes("> - src"), view.setup.captureCharFrame())
  await view.setup.mockMouse.click(6, 2)
  await view.setup.flush()
  assert.equal(view.activations, 1)
  assert.equal(view.selected(), "file.ts")
  assert.ok(view.setup.captureCharFrame().includes(">   file.ts"), view.setup.captureCharFrame())
  view.setup.renderer.destroy()

  let active = "a.ts"
  let tabActivations = 0
  const tabs = await testRender(() => jsx(ExplorerTabs as unknown as (props: Record<string, unknown>) => ReturnType<typeof jsx>, {
    paths: () => [{ path: "a.ts", dirty: true }, { path: "b.ts", dirty: false }],
    active: () => active,
    palette,
    onActivate: (path: string) => { active = path; tabActivations += 1 },
  }), { width: 30, height: 2 })
  await tabs.flush()
  const tabFrame = tabs.captureCharFrame()
  assert.ok(tabFrame.includes("a.ts •  b.ts"), tabFrame)
  assert.ok(tabFrame.split("\n").every((line) => line.length <= 30), tabFrame)
  await tabs.mockMouse.click(explorerTabPresentation({ path: "a.ts", dirty: true }).cells + 1, 0)
  await tabs.flush()
  assert.equal(tabActivations, 1)
  assert.equal(active, "b.ts")
  tabs.renderer.destroy()
})

test("rendered tree scrolls the selected row into view at narrow and normal widths", async () => {
  const treeRows = rows(...Array.from({ length: 16 }, (_, index) => node(`nested-${index}-with-a-long-name.ts`)))
  for (const [width, height] of [[22, 5], [60, 8]] as const) {
    const view = await renderTree(treeRows, width, height)
    if (!view) return test.skip(`OpenTUI rendered harness unavailable: ${renderUnavailable}`)
    view.setSelected(treeRows.at(-1)!.node.path)
    await view.setup.flush()
    assert.ok((view.scrollBox?.scrollTop ?? 0) > 0)
    const frame = view.setup.captureCharFrame()
    assert.ok(frame.split("\n").every((line) => line.length <= width), `${width}x${height}\n${frame}`)
    view.setup.renderer.destroy()
  }
})
