import assert from "node:assert/strict"
import test from "node:test"
import type { TuiKV } from "@opencode-ai/plugin/tui"

import {
  DISPLAY_SETTINGS,
  KEYS,
  SECTIONS,
  SIDEBAR_ANCHORS,
  SIDEBAR_PANELS,
  SOURCE_CONTROL_PRESETS,
  anchorForOrder,
  clampSidebarOrder,
  dialogSizeFor,
  displayLabel,
  formatInterval,
  isCompactLayout,
  readDisplaySetting,
  readSidebarPanelOrder,
  readSidebarVisibility,
  readSourceControlNumber,
  readSourceControlStartCollapsed,
  sidebarAutoVisible,
  toggleDisplaySetting,
  toggleSourceControlStartCollapsed,
  writeSidebarPanelAnchor,
  writeSidebarVisibility,
  writeSourceControlNumber,
} from "../src/settings.ts"

function memoryKv(initial: Record<string, unknown> = {}, ready = true): TuiKV & { values: Map<string, unknown> } {
  const values = new Map(Object.entries(initial))
  return {
    ready,
    values,
    get: <Value = unknown>(key: string, fallback?: Value) =>
      values.has(key) ? (values.get(key) as Value) : (fallback as Value),
    set: (key: string, value: unknown) => {
      values.set(key, value)
    },
  }
}

test("exposes a unique, ordered settings section list", () => {
  const ids = SECTIONS.map((section) => section.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.deepEqual(ids, ["appearance", "display", "plugins", "source-control", "sidebar", "about"])
  for (const section of SECTIONS) {
    assert.ok(section.title.length > 0)
    assert.ok(section.description.length > 0)
  }
})

test("reads and writes sidebar visibility", () => {
  const kv = memoryKv()
  assert.equal(readSidebarVisibility(kv), "auto")
  writeSidebarVisibility(kv, "hide")
  assert.equal(kv.values.get(KEYS.sidebar), "hide")
  assert.equal(readSidebarVisibility(kv), "hide")
  writeSidebarVisibility(kv, "auto")
  assert.equal(readSidebarVisibility(kv), "auto")
})

test("applies the host auto-visibility width rule", () => {
  assert.equal(sidebarAutoVisible(120), false)
  assert.equal(sidebarAutoVisible(121), true)
  assert.equal(sidebarAutoVisible(200), true)
})

test("toggles each display setting kind", () => {
  const kv = memoryKv()
  const booleanSetting = DISPLAY_SETTINGS.find((setting) => setting.key === "tool_details_visibility")!
  const hideShowSetting = DISPLAY_SETTINGS.find((setting) => setting.key === "timestamps")!
  const enumSetting = DISPLAY_SETTINGS.find((setting) => setting.key === "diff_wrap_mode")!

  assert.equal(readDisplaySetting(kv, booleanSetting), true)
  assert.equal(toggleDisplaySetting(kv, booleanSetting), false)
  assert.equal(readDisplaySetting(kv, booleanSetting), false)
  assert.equal(displayLabel(booleanSetting, false), "off")

  assert.equal(readDisplaySetting(kv, hideShowSetting), "hide")
  assert.equal(toggleDisplaySetting(kv, hideShowSetting), "show")
  assert.equal(readDisplaySetting(kv, hideShowSetting), "show")

  assert.equal(readDisplaySetting(kv, enumSetting), "word")
  assert.equal(toggleDisplaySetting(kv, enumSetting), "none")
  assert.equal(toggleDisplaySetting(kv, enumSetting), "word")
})

test("ignores invalid display values and falls back to defaults", () => {
  const kv = memoryKv({ timestamps: "sometimes", tool_details_visibility: "yes", diff_wrap_mode: "characters" })
  const booleanSetting = DISPLAY_SETTINGS.find((setting) => setting.key === "tool_details_visibility")!
  const hideShowSetting = DISPLAY_SETTINGS.find((setting) => setting.key === "timestamps")!
  const enumSetting = DISPLAY_SETTINGS.find((setting) => setting.key === "diff_wrap_mode")!
  assert.equal(readDisplaySetting(kv, booleanSetting), true)
  assert.equal(readDisplaySetting(kv, hideShowSetting), "hide")
  assert.equal(readDisplaySetting(kv, enumSetting), "word")
})

test("clamps sidebar orders to the supported range", () => {
  assert.equal(clampSidebarOrder(undefined, 10), 10)
  assert.equal(clampSidebarOrder(0, 10), 1)
  assert.equal(clampSidebarOrder(1000, 10), 999)
  assert.equal(clampSidebarOrder(12.9, 10), 12)
  assert.equal(clampSidebarOrder("12", 10), 10)
})

test("resolves the nearest lower sidebar anchor", () => {
  assert.equal(anchorForOrder(1).id, "top")
  assert.equal(anchorForOrder(10).id, "top")
  assert.equal(anchorForOrder(120).id, "before-context")
  assert.equal(anchorForOrder(400).id, "after-lsp")
  assert.equal(anchorForOrder(900).id, "after-files")
})

test("reads and writes plugin panel positions", () => {
  const kv = memoryKv()
  const panel = SIDEBAR_PANELS.find((candidate) => candidate.id === "source-control")!
  assert.equal(readSidebarPanelOrder(kv, panel), 50)
  const order = writeSidebarPanelAnchor(kv, panel, "after-todo")
  assert.equal(order, 450)
  assert.equal(kv.values.get(panel.orderKey), 450)
  assert.equal(readSidebarPanelOrder(kv, panel), 450)
})

test("reads and writes source-control runtime options", () => {
  const kv = memoryKv()
  const refresh = SOURCE_CONTROL_PRESETS.find((preset) => preset.key === "refreshMs")!
  const maxFiles = SOURCE_CONTROL_PRESETS.find((preset) => preset.key === "maxFiles")!

  assert.equal(readSourceControlNumber(kv, refresh), 15_000)
  assert.equal(readSourceControlNumber(kv, maxFiles), 8)
  writeSourceControlNumber(kv, refresh, 30_000)
  assert.equal(kv.values.get(refresh.kvKey), 30_000)
  assert.equal(readSourceControlNumber(kv, refresh), 30_000)

  const bad = memoryKv({ [refresh.kvKey]: "fast" })
  assert.equal(readSourceControlNumber(bad, refresh), 15_000)
})

test("toggles the source-control start state with a minimized default", () => {
  const kv = memoryKv()
  assert.equal(readSourceControlStartCollapsed(kv), true)
  assert.equal(toggleSourceControlStartCollapsed(kv), false)
  assert.equal(readSourceControlStartCollapsed(kv), false)
})

test("selects a compact dialog size for narrow terminals", () => {
  assert.equal(isCompactLayout(95), true)
  assert.equal(isCompactLayout(96), false)
  assert.equal(dialogSizeFor(80), "medium")
  assert.equal(dialogSizeFor(120), "large")
})

test("formats refresh intervals compactly", () => {
  assert.equal(formatInterval(5_000), "5s")
  assert.equal(formatInterval(120_000), "2m")
  assert.equal(formatInterval(8), "8")
})

test("keeps anchors ordered and unique", () => {
  const orders = SIDEBAR_ANCHORS.map((anchor) => anchor.order)
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b))
  assert.equal(new Set(orders).size, orders.length)
})
