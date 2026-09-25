import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"

import { PluginContextProvider } from "@opencode/plugin/tui"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
import { testRender } from "@opentui/solid"
import type { TestRendererSetup } from "@opentui/core/testing"
import { jsx } from "@opentui/solid/jsx-runtime"

import { ActiveSubagentRow, ActiveSubagentsHeading } from "../src/active-subagent-row.ts"
import type { SubagentRow } from "../src/subagents.ts"

const { createSignal } = await import(import.meta.resolve("solid-js/dist/solid.js")) as {
  createSignal: <T>(value: T) => [() => T, (value: T | ((current: T) => T)) => T]
}
const { transformSolidSource } = await import(new URL("./scripts/solid-transform.js", import.meta.resolve("@opentui/solid")).href) as {
  transformSolidSource: (source: string, options: {
    filename: string
    moduleName: string
    resolvePath: (specifier: string) => string
  }) => Promise<string>
}

const VIEWPORT = { columns: 140, rows: 60 }
const CAPTURE_VERSION = 1
const EVENT_VERSION = 3
const FOOTER = "CAPTURE_FOOTER"

type Component = (props: Record<string, unknown>) => ReturnType<typeof jsx>
type NormalizedSpan = {
  x: number
  y: number
  text: string
  width: number
  fg: [number, number, number, number]
  bg: [number, number, number, number]
  attributes: number
}
type NativeFrame = {
  version: 1
  cols: number
  rows: number
  cursor: [number, number]
  lines: Array<{ y: number; spans: NormalizedSpan[] }>
}
type Snapshot = {
  id: string
  frame: string
  spans: NativeFrame
  state: Record<string, unknown>
  frame_sha256: string
  spans_sha256: string
  state_sha256: string
}

function jsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonValue)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, jsonValue(entry)]))
  }
  return value
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(jsonValue(value))
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function createHash(algorithm: string) {
  return globalThis.process.getBuiltinModule("node:crypto").createHash(algorithm)
}

function colorInts(color: { toInts: () => [number, number, number, number] }): [number, number, number, number] {
  return color.toInts()
}

function normalizeFrame(captured: ReturnType<TestRendererSetup["captureSpans"]>): NativeFrame {
  return {
    version: 1,
    cols: captured.cols,
    rows: captured.rows,
    cursor: captured.cursor,
    lines: captured.lines.map((line, y) => {
      let x = 0
      const spans = line.spans.map((span) => {
        const normalized: NormalizedSpan = {
          x,
          y,
          text: span.text,
          width: span.width,
          fg: colorInts(span.fg),
          bg: colorInts(span.bg),
          attributes: span.attributes,
        }
        x += span.width
        return normalized
      })
      return { y, spans }
    }),
  }
}

function flushes(setup: TestRendererSetup, passes = 4): Promise<void> {
  return (async () => {
    for (let attempt = 0; attempt < passes; attempt += 1) {
      await setup.flush()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  })()
}

function snapshot(setup: TestRendererSetup, id: string, state: Record<string, unknown>): Snapshot {
  const frame = setup.captureCharFrame()
  const spans = normalizeFrame(setup.captureSpans())
  return {
    id,
    frame,
    spans,
    state,
    frame_sha256: sha256(frame),
    spans_sha256: sha256(canonicalJson(spans)),
    state_sha256: sha256(canonicalJson(state)),
  }
}

function binding(value: Snapshot) {
  return {
    snapshot_id: value.id,
    frame_sha256: value.frame_sha256,
    spans_sha256: value.spans_sha256,
    state_sha256: value.state_sha256,
  }
}

function event(
  id: string,
  phase: "test-setup" | "test-dispatch" | "test-teardown",
  action: Record<string, unknown>,
  dispatch: Record<string, unknown>,
  before: Snapshot,
  after: Snapshot,
  runID: string,
  dispatchMonotonicNS: string,
  transitionMonotonicNS: string,
) {
  const result = {
    status: "passed",
    target: action.target,
    observed: {
      visibility_before: before.state.visible === true,
      visibility_after: after.state.visible === true,
      frame_changed: before.frame_sha256 !== after.frame_sha256,
      spans_changed: before.spans_sha256 !== after.spans_sha256,
      state_changed: before.state_sha256 !== after.state_sha256,
    },
  }
  assert.ok(result.observed.frame_changed || result.observed.spans_changed || result.observed.state_changed, `${id} ${phase} did not change the observed native frame or state`)
  if (phase === "test-setup") assert.equal(result.observed.visibility_after, true)
  if (phase === "test-teardown") assert.equal(result.observed.visibility_before, true)
  const core = {
    version: EVENT_VERSION,
    phase,
    event_id: `${id}-${phase}-001`,
    action,
    dispatch,
    provenance: {
      scope: "native-test-renderer",
      run_id: runID,
      dispatch_id: `${id}-${phase}-dispatch-001`,
      transition_id: `${id}-${phase}-transition-001`,
      dispatch_monotonic_ns: dispatchMonotonicNS,
      transition_monotonic_ns: transitionMonotonicNS,
    },
    before: binding(before),
    after: binding(after),
    result,
  }
  return { ...core, native_event_sha256: sha256(canonicalJson(core)) }
}

function targetLocation(frame: NativeFrame, text: string): { x: number; y: number } {
  for (const line of frame.lines) {
    for (const span of line.spans) {
      if (span.text.includes(text)) return { x: span.x, y: line.y }
    }
  }
  throw new Error(`native frame did not contain target ${text}`)
}

function sectionTargets(frame: string, preferred: string[]): string[] {
  const targets = preferred.filter((target) => frame.includes(target))
  assert.ok(targets.length > 0, `native frame did not contain a preferred section: ${preferred.join(", ")}`)
  assert.ok(frame.includes(FOOTER), `native frame did not contain the footer:\n${frame}`)
  return [...new Set([...targets, FOOTER])]
}

function theme(): Context["theme"] {
  return {
    hue: { accent: { 200: "#d985b9" }, cyan: { 200: "#8cc8ff" } },
    text: {
      default: "#d8e1ee",
      subdued: "#9caec2",
      action: { primary: { default: "#8cc8ff", hovered: "#56d4dd" } },
      feedback: {
        info: { default: "#8cc8ff" },
        success: { default: "#8fd694" },
        warning: { default: "#e5c07b" },
        error: { default: "#e06c75" },
      },
    },
    diff: { text: { added: "#8fd694", removed: "#e06c75" } },
    border: { default: "#4f5b66" },
    background: {
      surface: { offset: "#27303a" },
      action: { primary: { default: "#161b22", hovered: "#30363d" } },
    },
    syntax: { keyword: "#bb9af7", type: "#bb9af7" },
  } as unknown as Context["theme"]
}

type StorageEntry = {
  value: Record<string, unknown>
  update: (mutation: (draft: Record<string, unknown>) => void) => void
}

type NativeContextOptions = {
  children?: () => readonly Record<string, unknown>[]
  active?: () => Record<string, { type: string }>
  eventListeners?: Map<string, Set<(event: unknown) => void>>
}

function reactiveStorage(initial: Record<string, unknown>): StorageEntry {
  const signals = new Map<string, [() => unknown, (value: unknown) => void]>()
  for (const [key, value] of Object.entries(initial)) {
    signals.set(key, createSignal(value) as [() => unknown, (value: unknown) => void])
  }
  const value = new Proxy({}, {
    get: (_target, property: string) => signals.get(property)?.[0](),
  }) as Record<string, unknown>
  return {
    value,
    update: (mutation) => {
      const draft = Object.fromEntries([...signals].map(([key, [read]]) => [key, read()]))
      mutation(draft)
      for (const [key, next] of Object.entries(draft)) signals.get(key)?.[1](next)
    },
  }
}

function context(
  root: string,
  dispatches: string[],
  storageValues: Map<string, StorageEntry>,
  options: NativeContextOptions = {},
): Context {
  const children = options.children ?? (() => [{ id: "ses_native_child", parentID: "ses_native_parent", projectID: "project", agent: "general", title: "Native sidebar capture", location: { directory: root } }])
  const active = options.active ?? (() => ({ ses_native_child: { type: "running" } }))
  const eventListeners = options.eventListeners ?? new Map<string, Set<(event: unknown) => void>>()
  return {
    options: { subagentAnimations: false },
    location: { directory: root },
    app: { version: "native-capture", channel: "test" },
    renderer: { width: VIEWPORT.columns } as Context["renderer"],
    client: {
      session: {
        get: async () => ({ id: "ses_native_parent", projectID: "project", location: { directory: root } }),
        list: async () => ({ data: children() }),
        active: async () => active(),
      },
      agent: { list: async () => ({ data: [{ id: "general", name: "General", model: { providerID: "openai", id: "gpt-5.6-luna", variant: "max" } }] }) },
      rpc: () => ({
        snapshot: async () => {
          dispatches.push("hermes.snapshot")
          return {
            schemaVersion: 1,
            updatedAt: "2026-09-25T12:00:05.000Z",
            events: [
              { at: "2026-09-25T12:00:01.000Z", hook: "pre_api_request", status: "started", requestRef: "aaaaaaaaaaaa", model: "gpt-6-luna", provider: "openai" },
              { at: "2026-09-25T12:00:03.000Z", hook: "post_api_request", status: "ok", requestRef: "aaaaaaaaaaaa", durationMs: 420 },
            ],
          }
        },
        events: { on: () => () => undefined },
      }),
      vcs: { diff: async () => ({ data: [] }) },
    } as unknown as Context["client"],
    data: {
      on: (type: string, listener: (event: unknown) => void) => {
        const listeners = eventListeners.get(type) ?? new Set<(event: unknown) => void>()
        listeners.add(listener)
        eventListeners.set(type, listeners)
        return () => listeners.delete(listener)
      },
      session: { get: () => ({ location: { directory: root } }) },
      location: { default: () => ({ directory: root }), vcs: { info: () => ({ branch: { current: "main" } }), sync: async () => undefined } },
    } as unknown as Context["data"],
    attention: {} as Context["attention"],
    theme: theme(),
    themeMode: "dark",
    markdown: { registerCodeBlockRenderer: () => () => undefined },
    keymap: { dispatch: (command: string) => dispatches.push(command) } as unknown as Context["keymap"],
    storage: {
      store: (key: string, options: { initial: Record<string, unknown> }) => {
        if (!storageValues.has(key)) {
          storageValues.set(key, reactiveStorage(options.initial))
        }
        const entry = storageValues.get(key)!
        return [entry.value, async (mutation: (draft: Record<string, unknown>) => void) => entry.update(mutation)]
      },
    } as unknown as Context["storage"],
    ui: {
      panel: { open: () => true },
      dialog: { clear: () => undefined, alert: async () => undefined },
      toast: { show: () => undefined },
      router: { navigate: (route: unknown) => dispatches.push(`router.navigate:${JSON.stringify(route)}`) },
    } as unknown as Context["ui"],
  } as unknown as Context
}

function withContext(value: Context, child: () => ReturnType<typeof jsx>) {
  return jsx(PluginContextProvider as unknown as Component, {
    value,
    get children() { return child() },
  })
}

function todoContext(root: string): Context {
  const settings = { collapsed: false }
  return {
    options: {},
    location: { directory: root },
    app: { version: "native-capture", channel: "test" },
    renderer: {} as Context["renderer"],
    client: {} as Context["client"],
    data: {
      on: () => () => undefined,
      session: { get: () => ({ location: { directory: root } }) },
      location: { default: () => ({ directory: root }), vcs: { info: () => ({ branch: { current: "main" } }), sync: async () => undefined } },
    } as unknown as Context["data"],
    attention: {} as Context["attention"],
    theme: theme(),
    themeMode: "dark",
    markdown: { registerCodeBlockRenderer: () => () => undefined },
    keymap: {} as Context["keymap"],
    storage: { store: () => [settings, async (mutation: (draft: typeof settings) => void) => mutation(settings)] } as unknown as Context["storage"],
    ui: { panel: { open: () => true }, toast: { show: () => undefined } } as unknown as Context["ui"],
  } as unknown as Context
}

function providerStore(id: string) {
  const providers = id === "mapping-02"
    ? [{ id: "openai", label: "OpenAI", status: "available" as const, detail: "Connected", usage: "Weekly: 28% left" }]
    : id === "mapping-03"
      ? [{ id: "opencode-zen", label: "OpenCode Zen", status: "unavailable" as const, detail: "Not connected" }]
      : [{ id: "deepseek", label: "DeepSeek", status: "quota-exhausted" as const, detail: "Insufficient balance (USD 0.00).", usage: "Weekly quota balance is exhausted." }]
  const state = {
    status: "ready" as const,
    providers,
  }
  const listeners = new Set<(value: typeof state) => void>()
  return {
    getState: () => state,
    subscribe: (listener: (value: typeof state) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    refresh: async () => { for (const listener of listeners) listener(state); return state },
    dispose: () => listeners.clear(),
  }
}

function sourceStore(count = 5) {
  const state = {
    status: "ready" as const,
    isGit: true,
    branch: "feature/sidebar",
    changes: Array.from({ length: count }, (_, index) => ({ file: `src/sidebar/native-preview-file-${index}.tsx`, additions: index + 1, deletions: index, status: index === 0 ? "added" as const : "modified" as const })),
  }
  return { getState: () => state, subscribe: () => () => undefined, refreshLocal: async () => undefined, refreshGithub: async () => undefined, dispose: () => undefined }
}

async function transformedModule(sourceURL: URL, replacements = new Map<string, string>(), importOverrides = new Map<string, string>()) {
  const sourceDirectory = new URL("./", sourceURL)
  const imports = await transformSolidSource(await readFile(sourceURL, "utf8"), {
    filename: sourceURL.pathname,
    moduleName: "@opentui/solid",
    resolvePath: (specifier) => {
      if (importOverrides.has(specifier)) return importOverrides.get(specifier)!
      if (specifier.startsWith(".")) return new URL(specifier, sourceDirectory).href
      if (specifier === "solid-js") return import.meta.resolve("solid-js/dist/solid.js")
      return import.meta.resolve(specifier)
    },
  })
  let mapped = imports
  for (const [from, to] of replacements) mapped = mapped.replaceAll(from, to)
  return await import(`data:text/javascript;base64,${Buffer.from(mapped).toString("base64")}`) as Record<string, unknown>
}

let componentsPromise: Promise<Record<string, Component>> | undefined
async function components() {
  if (!componentsPromise) {
    componentsPromise = (async () => {
      const codex = await transformedModule(new URL("../../codex-usage/src/tui.tsx", import.meta.url))
      const presentationURL = new URL("../../file-manager/src/presentation.ts", import.meta.url)
      const presentation = await transformedModule(presentationURL)
      const todoStub = `data:text/javascript;base64,${Buffer.from("export function TasksPanel() { return null }").toString("base64")}`
      const todo = await transformedModule(new URL("../../rig-todo/src/tui.tsx", import.meta.url), new Map(), new Map([["./tasks-panel.tsx", todoStub]]))
      const tasks = await transformedModule(new URL("../../rig-todo/src/tasks-panel.tsx", import.meta.url))
      const source = await transformedModule(new URL("../../source-control/src/tui.tsx", import.meta.url))
      const fileManager = await transformedModule(new URL("../../file-manager/src/tui.tsx", import.meta.url))
      const hermesStub = `data:text/javascript;base64,${Buffer.from('export const HERMES_HOOKS_PANEL_NAME = "opencode-rig.rig-tools.hermes-hooks"; export function HermesHooksPanel() { return null }').toString("base64")}`
      const tools = await transformedModule(new URL("../src/tui.tsx", import.meta.url), new Map(), new Map([["./hermes-hooks-panel.tsx", hermesStub]]))
      const hermes = await transformedModule(new URL("../src/hermes-hooks-panel.tsx", import.meta.url))
      return {
        ProviderRow: codex.ProviderRow as Component,
        UsagePanel: codex.UsagePanel as Component,
        ExplorerTree: presentation.ExplorerTree as Component,
        TodoPanel: todo.TodoPanel as Component,
        TodoRow: todo.TodoRow as Component,
        TasksPanel: tasks.TasksPanel as Component,
        HermesHooksPanel: hermes.HermesHooksPanel as Component,
        SourceControlPanel: source.SourceControlPanel as Component,
        FilesSidebar: fileManager.FilesSidebar as Component,
        ActiveSubagentsSidebar: tools.ActiveSubagentsSidebar as Component,
      }
    })()
  }
  return await componentsPromise
}

async function capture(id: string) {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-rig-native-capture-"))
  const runID = process.env.RIG_NATIVE_CAPTURE_RUN_ID
  assert.ok(runID, "RIG_NATIVE_CAPTURE_RUN_ID is required")
  const previousXdgDataHome = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = root
  const loaded = id === "mapping-10" || id === "mapping-11" || id === "active-subagent-row-exemplar"
    ? {} as Record<string, Component>
    : await components()
  const sessionID = "ses_native_parent"
  const dispatches: string[] = []
  const storageValues = new Map<string, StorageEntry>()
  const dynamicChildren = id === "mapping-09" || id === "integrated-sidebar" || id === "rig-tools-subagents" || id === "rig-tools-tui"
    ? createSignal<readonly Record<string, unknown>[]>([
        { id: "ses_native_child", parentID: "ses_native_parent", projectID: "project", agent: "general", title: "Native sidebar capture", location: { directory: root } },
      ])
    : undefined
  const eventListeners = new Map<string, Set<(event: unknown) => void>>()
  const ctx = context(root, dispatches, storageValues, {
    ...(dynamicChildren ? { children: () => dynamicChildren[0]() } : {}),
    ...(dynamicChildren ? { active: () => Object.fromEntries(dynamicChildren[0]().map((child) => [child.id, { type: "running" }])) } : {}),
    eventListeners,
  })
  const [visible, setVisible] = createSignal(false)
  const intermediateSnapshots: Record<string, Snapshot> = {}
  const retain = (setup: TestRendererSetup, snapshotID: string, snapshotState: Record<string, unknown>) => {
    intermediateSnapshots[snapshotID] = snapshot(setup, snapshotID, snapshotState)
  }
  const todoCaptures = new Set(["mapping-07", "mapping-08", "integrated-sidebar", "rig-todo-store", "rig-todo-tasks-panel", "rig-todo-tui"])
  const todos = id === "rig-todo-tasks-panel"
    ? [
        { content: "in-progress native capture", status: "in_progress" as const },
        { content: "pending native capture", status: "pending" as const },
        { content: "completed native capture", status: "completed" as const },
        { content: "cancelled native capture", status: "cancelled" as const },
      ]
    : id === "mapping-08"
      ? [
          { content: "in-progress native capture", status: "in_progress" as const },
          { content: "pending native capture", status: "pending" as const },
          { content: "completed native capture", status: "completed" as const },
          ...Array.from({ length: 3 }, (_, index) => ({ content: `stored completed ${index}`, status: "completed" as const })),
        ]
      : [
          { content: "in-progress native capture", status: "in_progress" as const },
          { content: "completed native capture", status: "completed" as const },
          ...Array.from({ length: 5 }, (_, index) => ({ content: `old completed ${index}`, status: "completed" as const })),
        ]
  if (todoCaptures.has(id)) {
    const { serializeTodoState, todoStatePath } = await import("../../rig-todo/src/state.ts")
    await mkdir(path.dirname(todoStatePath(sessionID)), { recursive: true })
    await writeFile(todoStatePath(sessionID), serializeTodoState(todos), "utf8")
    assert.ok((await readFile(todoStatePath(sessionID), "utf8")).includes("in-progress native capture"))
  }

  let body: () => ReturnType<typeof jsx>
  let state: (setup: TestRendererSetup) => Record<string, unknown>
  let interact: (setup: TestRendererSetup) => Promise<Record<string, unknown>>
  let preferred: string[]
  const emit = (type: string, data: Record<string, unknown>) => {
    for (const listener of eventListeners.get(type) ?? []) listener({ data })
  }

  if (id.startsWith("mapping-01") || id.startsWith("mapping-02") || id.startsWith("mapping-03")) {
    const store = providerStore(id)
    storageValues.delete("provider-usage-settings-v2")
    body = () => withContext(ctx, () => jsx(loaded.UsagePanel, { store, refreshMs: 60_000 }))
    state = (setup) => ({ visible: visible(), collapsed: setup.captureCharFrame().includes("+ Provider Usage"), dispatches: [...dispatches] })
    interact = async (setup) => {
      const target = targetLocation(normalizeFrame(setup.captureSpans()), "+ Provider Usage")
      await setup.mockMouse.click(target.x + 1, target.y)
      await flushes(setup)
      return { device: "mouse", method: "click", target: "provider-usage-header", input: { x: target.x + 1, y: target.y } }
    }
    preferred = ["+ Provider Usage", id === "mapping-02" ? "OpenAI" : id === "mapping-03" ? "OpenCode Zen" : "DeepSeek"]
  } else if (id === "mapping-04") {
    const clipboard = { writeText: async () => ({ host: { status: "not-attempted" as const }, terminal: { status: "attempted" as const, capability: "supported" as const } }) }
    body = () => withContext(ctx, () => jsx(loaded.FilesSidebar, { sessionID, clipboard }))
    state = (setup) => {
      const session = normalizeFrame(setup.captureSpans()).lines.flatMap((line) => line.spans).find((span) => span.text.includes(sessionID))
      return {
        visible: visible(),
        sessionIDVisible: Boolean(session),
        sessionIDHovered: Boolean(session && (session.attributes & 1) !== 0 && (session.attributes & 8) !== 0),
        dispatches: [...dispatches],
      }
    }
    interact = async (setup) => {
      const target = targetLocation(normalizeFrame(setup.captureSpans()), sessionID)
      const input = { x: target.x + 1, y: target.y }
      await setup.mockMouse.moveTo(input.x, input.y)
      await flushes(setup)
      const entered = normalizeFrame(setup.captureSpans()).lines.flatMap((line) => line.spans).find((span) => span.text.includes(sessionID))
      assert.ok(entered && (entered.attributes & 1) !== 0 && (entered.attributes & 8) !== 0)
      assert.deepEqual(entered.fg, [86, 212, 221, 255])
      retain(setup, `${id}-hover-enter`, state(setup))

      await setup.mockMouse.moveTo(0, Math.min(VIEWPORT.rows - 1, target.y + 2))
      await flushes(setup)
      const restored = normalizeFrame(setup.captureSpans()).lines.flatMap((line) => line.spans).find((span) => span.text.includes(sessionID))
      assert.ok(restored && (restored.attributes & 2) !== 0 && (restored.attributes & 1) === 0)
      retain(setup, `${id}-hover-restored`, state(setup))

      await setup.mockMouse.moveTo(input.x, input.y)
      await flushes(setup)
      return { device: "mouse", method: "moveTo+moveTo+moveTo", target: `repository-session-header:${sessionID}`, input: { steps: [input, { x: 0, y: Math.min(VIEWPORT.rows - 1, target.y + 2) }, input] } }
    }
    preferred = ["opencode-rig-native-capture", sessionID]
  } else if (id.startsWith("mapping-05") || id.startsWith("mapping-06")) {
    const treePrefix = id === "mapping-05" ? "presentation" : "theme"
    const themeModule = id === "mapping-06" ? await import("../../file-manager/src/theme.ts") : undefined
    const [themeMode, setThemeMode] = createSignal<"dark" | "light">("dark")
    const selectedPalette = () => themeModule!.normalizeExplorerTheme({
      hue: { accent: { 200: themeMode() === "dark" ? "#8cc8ff" : "#ff00aa" } },
    })
    const [selected, setSelected] = createSignal(`src/sidebar/${treePrefix}-preview-file-0.tsx`)
    let activations = 0
    const rows = Array.from({ length: 3 }, (_, index) => ({ node: { name: `${treePrefix}-preview-file-${index}.tsx`, path: `src/sidebar/${treePrefix}-preview-file-${index}.tsx`, type: "file", ignored: false }, depth: 0, expanded: false }))
    const palette = id === "mapping-06"
      ? { get accent() { return selectedPalette().hue.accent[200] }, text: "#ffffff", subdued: "#888888", selected: "#333333" }
      : { accent: "#8cc8ff", text: "#ffffff", subdued: "#888888", selected: "#333333" }
    body = () => jsx(loaded.ExplorerTree, { rows: () => rows, selected, width: () => 132, palette, onActivate: (row: { node: { path: string } }) => { activations += 1; setSelected(row.node.path) } })
    state = () => ({ visible: visible(), selected: selected(), activations, ...(id === "mapping-06" ? { themeMode: themeMode() } : {}), dispatches: [...dispatches] })
    interact = async (setup) => {
      if (id === "mapping-06") {
        const selectedSpan = () => setup.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("theme-preview-file-0.tsx"))
        const beforeTheme = selectedSpan()
        assert.ok(beforeTheme)
        assert.deepEqual(colorInts(beforeTheme.fg), [140, 200, 255, 255])
        retain(setup, `${id}-theme-before`, state(setup))

        setThemeMode("light")
        await flushes(setup)
        const afterTheme = selectedSpan()
        assert.ok(afterTheme)
        assert.deepEqual(colorInts(afterTheme.fg), [255, 0, 170, 255])
        retain(setup, `${id}-theme-after`, state(setup))
      }
      const target = targetLocation(normalizeFrame(setup.captureSpans()), `${treePrefix}-preview-file-1.tsx`)
      await setup.mockMouse.click(target.x + 1, target.y)
      return { device: "mouse", method: "click", target: `explorer-tree-row:${treePrefix}-preview-file-1.tsx`, input: { x: target.x + 1, y: target.y } }
    }
    preferred = [`${treePrefix}-preview-file-0.tsx`, `${treePrefix}-preview-file-1.tsx`]
  } else if (id.startsWith("mapping-07") || id.startsWith("mapping-08")) {
    body = () => withContext(todoContext(root), () => jsx("box", { width: "100%", children: jsx(loaded.TodoPanel, { sessionID }) }))
    state = (setup) => ({ visible: visible(), collapsed: setup.captureCharFrame().includes("+ Todo"), dispatches: [...dispatches] })
    interact = async (setup) => {
      const target = targetLocation(normalizeFrame(setup.captureSpans()), "- Todo")
      await setup.mockMouse.click(target.x + 1, target.y)
      return { device: "mouse", method: "click", target: "todo-header", input: { x: target.x + 1, y: target.y } }
    }
    preferred = ["+ Todo", "- Todo"]
  } else if (id === "rig-todo-store") {
    body = () => withContext(todoContext(root), () => jsx("box", { width: "100%", children: jsx(loaded.TodoPanel, { sessionID }) }))
    state = (setup) => ({ visible: visible(), collapsed: setup.captureCharFrame().includes("+ Todo"), dispatches: [...dispatches] })
    interact = async (setup) => {
      const target = targetLocation(normalizeFrame(setup.captureSpans()), "- Todo")
      await setup.mockMouse.click(target.x + 1, target.y)
      await flushes(setup)
      return { device: "mouse", method: "click", target: "todo-header", input: { x: target.x + 1, y: target.y } }
    }
    preferred = ["+ Todo", FOOTER]
  } else if (id === "rig-todo-tui") {
    body = () => withContext(todoContext(root), () => jsx("box", { width: "100%", children: jsx(loaded.TodoPanel, { sessionID }) }))
    state = (setup) => ({ visible: visible(), historyOpen: setup.captureCharFrame().includes("hide history"), dispatches: [...dispatches] })
    interact = async (setup) => {
      const target = targetLocation(normalizeFrame(setup.captureSpans()), "history")
      await setup.mockMouse.click(target.x + 1, target.y)
      await flushes(setup)
      return { device: "mouse", method: "click", target: "todo-history-toggle", input: { x: target.x + 1, y: target.y } }
    }
    preferred = ["- Todo", "hide history", FOOTER]
  } else if (id === "rig-todo-tasks-panel") {
    const panel = {
      name: "opencode-rig.todo.tasks",
      sessionID,
      width: 80,
      presentation: "fullscreen",
      focused: true,
      focus: () => undefined,
      close: () => dispatches.push("todo.close"),
      toggleFullscreen: () => dispatches.push("todo.resize"),
    } as unknown as PanelInput
    body = () => withContext(todoContext(root), () => jsx(loaded.TasksPanel, { panel }))
    state = (setup) => ({ visible: visible(), columnLabels: setup.captureSpans().lines.flatMap((line) => line.spans).filter((span) => span.text.includes("In Progress") || span.text.includes("To Do")).map((span) => ({ text: span.text, fg: colorInts(span.fg), attributes: span.attributes })), dispatches: [...dispatches] })
    interact = async (setup) => {
      await setup.mockInput.pressArrow("right")
      await flushes(setup)
      return { device: "keyboard", method: "pressArrow", target: "todo-kanban-next-column", input: "right" }
    }
    preferred = ["Todo tasks", "To Do", FOOTER]
  } else if (id === "rig-tools-hermes-hooks-panel") {
    const panel = {
      name: "opencode-rig.rig-tools.hermes-hooks",
      sessionID,
      width: VIEWPORT.columns - 4,
      presentation: "fullscreen",
      focused: true,
      focus: () => undefined,
      close: () => dispatches.push("hermes.close"),
      toggleFullscreen: () => undefined,
    } as unknown as PanelInput
    body = () => withContext(ctx, () => jsx(loaded.HermesHooksPanel, { panel }))
    state = () => ({ visible: visible(), snapshotCalls: dispatches.filter((entry) => entry === "hermes.snapshot").length, dispatches: [...dispatches] })
    interact = async (setup) => {
      await setup.mockInput.pressKey("r")
      await flushes(setup)
      return { device: "keyboard", method: "pressKey", target: "hermes-hooks-refresh", input: "r" }
    }
    preferred = ["Hermes /hooks", "Recent hook events", "pre_api_request", FOOTER]
  } else if (id === "mapping-09" || id === "rig-tools-subagents") {
    assert.ok(dynamicChildren)
    body = () => withContext(ctx, () => jsx(loaded.ActiveSubagentsSidebar, { sessionID }))
    state = (setup) => ({
      visible: visible(),
      collapsed: setup.captureCharFrame().includes("+ Active Subagents"),
      activeCount: dynamicChildren[0]().length,
      headingFocused: setup.renderer.currentFocusedRenderable?.id === "opencode-rig.active-subagents.heading",
      dispatches: [...dispatches],
    })
    interact = async (setup) => {
      const row = setup.renderer.root.findDescendantById("opencode-rig.active-subagents.row.ses_native_child")
      assert.ok(row)
      row.focus()
      await flushes(setup)
      assert.equal(setup.renderer.currentFocusedRenderable?.id, "opencode-rig.active-subagents.row.ses_native_child")
      const heading = targetLocation(normalizeFrame(setup.captureSpans()), "- Active Subagents")
      await setup.mockMouse.click(heading.x + 1, heading.y)
      await flushes(setup)
      const collapsedFrame = setup.captureCharFrame()
      assert.match(collapsedFrame, /\+ Active Subagents 1/)
      assert.doesNotMatch(collapsedFrame, /Native sidebar capture/)
      assert.equal(setup.renderer.currentFocusedRenderable?.id, "opencode-rig.active-subagents.heading")
      retain(setup, `${id}-collapsed`, state(setup))

      dynamicChildren[1]((current) => [...current, { id: "ses_native_second", parentID: "ses_native_parent", projectID: "project", agent: "general", title: "Native second child", location: { directory: root } }])
      emit("session.created", { parentID: "ses_native_parent", sessionID: "ses_native_second" })
      await flushes(setup, 12)
      assert.match(setup.captureCharFrame(), /\+ Active Subagents 2/)
      assert.doesNotMatch(setup.captureCharFrame(), /Native second child/)
      retain(setup, `${id}-collapsed-live-count`, state(setup))

      await setup.mockInput.pressEnter()
      await flushes(setup)
      assert.match(setup.captureCharFrame(), /- Active Subagents 2/)
      assert.match(setup.captureCharFrame(), /Native second child/)
      assert.equal(setup.renderer.currentFocusedRenderable?.id, "opencode-rig.active-subagents.heading")
      return {
        device: "mouse",
        method: "click+session.created+pressEnter",
        target: "active-subagents-header",
        input: {
          mouse: { method: "click", x: heading.x + 1, y: heading.y },
          lifecycle: { type: "session.created", parentID: "ses_native_parent", sessionID: "ses_native_second" },
          keyboard: { method: "pressEnter" },
        },
      }
    }
    preferred = ["- Active Subagents", "Native second child"]
  } else if (id === "rig-tools-tui") {
    body = () => withContext(ctx, () => jsx(loaded.ActiveSubagentsSidebar, { sessionID }))
    state = (setup) => ({ visible: visible(), collapsed: setup.captureCharFrame().includes("+ Active Subagents"), activeCount: dynamicChildren?.[0]().length ?? 0, dispatches: [...dispatches] })
    interact = async (setup) => {
      const heading = targetLocation(normalizeFrame(setup.captureSpans()), "- Active Subagents")
      await setup.mockMouse.click(heading.x + 1, heading.y)
      await flushes(setup)
      return { device: "mouse", method: "click", target: "active-subagents-header", input: { x: heading.x + 1, y: heading.y } }
    }
    preferred = ["+ Active Subagents", FOOTER]
  } else if (id === "mapping-10" || id === "mapping-11" || id === "active-subagent-row-exemplar") {
    const [selected, setSelected] = createSignal(0)
    let rowRef: { focus: () => void } | undefined
    const rowPrefix = id === "mapping-10" ? "Native" : "Subagents"
    const rows: SubagentRow[] = [
      { sessionID: "ses_native_child", agent: "General", model: "openai/gpt-5.6-luna#max", title: `${rowPrefix} sidebar capture`, status: "running" },
      { sessionID: "ses_native_second", agent: "General", model: "openai/gpt-5.6-luna#max", title: `${rowPrefix} second row`, status: "running" },
    ]
      body = () => jsx("box", { flexDirection: "column", children: [jsx(ActiveSubagentsHeading as unknown as Component, { count: rows.length, collapsed: false, textColor: "#d8e1ee", accentColor: "#bb9af7", onToggle: () => undefined }), ...rows.map((row, index) => jsx(ActiveSubagentRow as unknown as Component, { row, theme: { hue: { accent: { 200: "#d985b9" } }, text: { default: "#d8e1ee", subdued: "#9caec2", action: { primary: { default: "#f0d6a6" } } }, background: { default: "#182635", action: { primary: { default: "#334b63", selected: "#6a4f84" } } }, syntax: { keyword: "#bb9af7", type: "#bb9af7" } }, focused: selected() === index, activityFrame: "⠋", onRef: (value: { focus: () => void }) => { if (index === 0) rowRef = value }, onFocus: () => setSelected(index), onMove: (delta: number) => setSelected((current) => (current + delta + rows.length) % rows.length), onOpen: () => dispatches.push(`session.open:${row.sessionID}`) }))] })
    state = (setup) => ({ visible: visible(), selected: selected(), dispatches: [...dispatches], frameHasHeading: setup.captureCharFrame().includes("- Active Subagents") })
    interact = async (setup) => {
      rowRef?.focus()
      setup.mockInput.pressArrow("down")
      await flushes(setup)
      return { device: "keyboard", method: "pressArrow", target: "active-subagent-row:selection", input: "down" }
    }
    preferred = ["- Active Subagents", `${rowPrefix} sidebar capture`]
  } else if (id === "mapping-12") {
    const [sourceCollapsed, setSourceCollapsed] = createSignal(false)
    body = () => withContext(ctx, () => jsx(loaded.SourceControlPanel, { store: sourceStore(10), runtime: () => ({ refreshMs: 60_000, githubRefreshMs: 60_000, maxFiles: 3, startCollapsed: sourceCollapsed() }), setStartCollapsed: setSourceCollapsed, whenEmpty: "show" }))
    state = (setup) => ({ visible: visible(), page: setup.captureCharFrame().match(/More files ([^\n]+)/)?.[1] ?? "collapsed", dispatches: [...dispatches] })
    interact = async (setup) => {
      const more = targetLocation(normalizeFrame(setup.captureSpans()), "+7 more files")
      await setup.mockMouse.click(more.x + 1, more.y)
      await flushes(setup)
      assert.match(setup.captureCharFrame(), /More files 4-9 of 10/)
      retain(setup, `${id}-first-page`, state(setup))

      const next = setup.renderer.root.findDescendantById("opencode-rig.source-control.more.next") as { focus: () => void } | undefined
      assert.ok(next)
      next.focus()
      await setup.mockInput.pressEnter()
      await flushes(setup)
      assert.match(setup.captureCharFrame(), /More files 10-10 of 10/)
      assert.match(setup.captureCharFrame(), /native-preview-file-9\.tsx/)
      return {
        device: "mouse",
        method: "click+pressEnter",
        target: "source-control-pagination",
        input: { mouse: { method: "click", target: "+7 more files", x: more.x + 1, y: more.y }, keyboard: { method: "pressEnter", target: "next >" } },
      }
    }
    preferred = ["- Source Control", "More files 10-10 of 10", "native-preview-file-9.tsx"]
  } else if (id === "integrated-sidebar") {
    assert.ok(dynamicChildren)
    storageValues.delete("provider-usage-settings-v2")
    const clipboard = { writeText: async () => ({ host: { status: "not-attempted" as const }, terminal: { status: "attempted" as const, capability: "supported" as const } }) }
    body = () => jsx("box", {
      flexDirection: "column",
      width: "100%",
      children: [
        withContext(ctx, () => jsx(loaded.FilesSidebar, { sessionID, clipboard })),
        withContext(ctx, () => jsx(loaded.ActiveSubagentsSidebar, { sessionID })),
        withContext(ctx, () => jsx("box", { width: "100%", children: jsx(loaded.TodoPanel, { sessionID }) })),
        withContext(ctx, () => jsx(loaded.SourceControlPanel, {
          store: sourceStore(10),
          runtime: () => ({ refreshMs: 60_000, githubRefreshMs: 60_000, maxFiles: 3, startCollapsed: false }),
          setStartCollapsed: () => undefined,
          whenEmpty: "show",
        })),
        withContext(ctx, () => jsx(loaded.UsagePanel, { store: providerStore("mapping-02"), refreshMs: 60_000 })),
      ],
    })
    state = (setup) => ({
      visible: visible(),
      collapsed: setup.captureCharFrame().includes("+ Active Subagents"),
      activeCount: dynamicChildren[0]().length,
      headingFocused: setup.renderer.currentFocusedRenderable?.id === "opencode-rig.active-subagents.heading",
      todoCollapsed: setup.captureCharFrame().includes("+ Todo"),
      usageCollapsed: setup.captureCharFrame().includes("+ Provider Usage"),
      sourcePage: setup.captureCharFrame().match(/More files ([^\n]+)/)?.[1] ?? "collapsed",
      sessionIDVisible: setup.captureCharFrame().includes(sessionID),
      dispatches: [...dispatches],
    })
    interact = async (setup) => {
      const pointerSteps: Array<{ method: string; x: number; y: number }> = []
      const session = targetLocation(normalizeFrame(setup.captureSpans()), sessionID)
      const sessionPointer = { x: session.x + 1, y: session.y }
      await setup.mockMouse.moveTo(sessionPointer.x, sessionPointer.y)
      pointerSteps.push({ method: "moveTo", ...sessionPointer })
      await flushes(setup)
      const hoveredSession = normalizeFrame(setup.captureSpans()).lines.flatMap((line) => line.spans).find((span) => span.text.includes(sessionID))
      assert.ok(hoveredSession && (hoveredSession.attributes & 1) !== 0 && (hoveredSession.attributes & 8) !== 0)
      retain(setup, `${id}-repository-session-hover`, state(setup))

      const leave = { x: 0, y: Math.min(VIEWPORT.rows - 1, session.y + 2) }
      await setup.mockMouse.moveTo(leave.x, leave.y)
      pointerSteps.push({ method: "moveTo", ...leave })
      await flushes(setup)
      const restoredSession = normalizeFrame(setup.captureSpans()).lines.flatMap((line) => line.spans).find((span) => span.text.includes(sessionID))
      assert.ok(restoredSession && (restoredSession.attributes & 2) !== 0 && (restoredSession.attributes & 1) === 0)

      await setup.mockMouse.moveTo(sessionPointer.x, sessionPointer.y)
      pointerSteps.push({ method: "moveTo", ...sessionPointer })
      await flushes(setup)

      const heading = targetLocation(normalizeFrame(setup.captureSpans()), "- Active Subagents")
      await setup.mockMouse.click(heading.x + 1, heading.y)
      pointerSteps.push({ method: "click", x: heading.x + 1, y: heading.y })
      await flushes(setup)
      assert.match(setup.captureCharFrame(), /\+ Active Subagents 1/)
      assert.equal(setup.renderer.currentFocusedRenderable?.id, "opencode-rig.active-subagents.heading")
      retain(setup, `${id}-subagents-collapsed`, state(setup))

      dynamicChildren[1]((current) => [...current, { id: "ses_native_second", parentID: "ses_native_parent", projectID: "project", agent: "general", title: "Native second child", location: { directory: root } }])
      emit("session.created", { parentID: "ses_native_parent", sessionID: "ses_native_second" })
      await flushes(setup, 12)
      assert.match(setup.captureCharFrame(), /\+ Active Subagents 2/)
      assert.doesNotMatch(setup.captureCharFrame(), /Native second child/)
      retain(setup, `${id}-subagents-collapsed-live-count`, state(setup))

      await setup.mockInput.pressEnter()
      await flushes(setup)
      assert.match(setup.captureCharFrame(), /- Active Subagents 2/)
      assert.match(setup.captureCharFrame(), /Native second child/)
      assert.equal(setup.renderer.currentFocusedRenderable?.id, "opencode-rig.active-subagents.heading")

      const more = targetLocation(normalizeFrame(setup.captureSpans()), "+7 more files")
      await setup.mockMouse.click(more.x + 1, more.y)
      pointerSteps.push({ method: "click", x: more.x + 1, y: more.y })
      await flushes(setup)
      assert.match(setup.captureCharFrame(), /More files 4-9 of 10/)
      const next = setup.renderer.root.findDescendantById("opencode-rig.source-control.more.next") as { focus: () => void } | undefined
      assert.ok(next)
      next.focus()
      await setup.mockInput.pressEnter()
      await flushes(setup)
      assert.match(setup.captureCharFrame(), /More files 10-10 of 10/)
      assert.match(setup.captureCharFrame(), /native-preview-file-9\.tsx/)

      const provider = targetLocation(normalizeFrame(setup.captureSpans()), "+ Provider Usage")
      await setup.mockMouse.click(provider.x + 1, provider.y)
      pointerSteps.push({ method: "click", x: provider.x + 1, y: provider.y })
      await flushes(setup)
      assert.match(setup.captureCharFrame(), /OpenAI/)
      assert.match(setup.captureCharFrame(), /28%/)
      assert.match(setup.captureCharFrame(), /CAPTURE_FOOTER/)
      return {
        device: "mouse",
        method: "moveTo+click+session.created+pressEnter+click+pressEnter+click",
        target: "integrated-sidebar:repository-session-subagents-source-provider",
        input: {
          pointer: pointerSteps,
          lifecycle: { type: "session.created", parentID: "ses_native_parent", sessionID: "ses_native_second" },
          keyboard: [{ method: "pressEnter", target: "active-subagents-header" }, { method: "pressEnter", target: "source-control-next" }],
        },
      }
    }
    preferred = ["repository", sessionID, "- Active Subagents", "- Todo", "- Source Control", "- Provider Usage", "OpenAI", "28%"]
  } else {
    throw new Error(`unsupported native capture ${id}`)
  }
  let setup: TestRendererSetup | undefined
  const setupDispatchMonotonicNS = process.hrtime.bigint().toString()
  try {
    setup = await testRender(() => jsx("box", {
      width: VIEWPORT.columns,
      height: VIEWPORT.rows,
      flexDirection: "column",
      overflow: "hidden",
      children: [
        jsx("box", { flexGrow: 1, minHeight: 0, get children() { return visible() ? body() : null } }),
        jsx("text", { height: 1, flexShrink: 0, children: FOOTER }),
      ],
    }), { width: VIEWPORT.columns, height: VIEWPORT.rows })
    const mutableContext = ctx as unknown as { renderer: Context["renderer"] }
    mutableContext.renderer = setup.renderer
    await flushes(setup)
    const snapshots: Record<string, Snapshot> = {}
    const beforeOpen = snapshot(setup, `${id}-open-before`, { visible: false })
    snapshots[beforeOpen.id] = beforeOpen
    setVisible(true)
    await flushes(setup, 12)
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
    await flushes(setup, 4)
    if ((id.startsWith("mapping-07") || id.startsWith("mapping-08") || id === "integrated-sidebar" || id === "rig-todo-store" || id === "rig-todo-tui") && !setup.captureCharFrame().includes("Todo")) {
      throw new Error(`native TodoPanel did not become visible for ${id}:\n${setup.captureCharFrame()}`)
    }
    if (id === "rig-todo-tasks-panel" && !setup.captureCharFrame().includes("Todo tasks")) {
      throw new Error(`native TasksPanel did not become visible:\n${setup.captureCharFrame()}`)
    }
    if (id === "rig-tools-hermes-hooks-panel" && !setup.captureCharFrame().includes("Hermes /hooks")) {
      throw new Error(`native HermesHooksPanel did not become visible:\n${setup.captureCharFrame()}`)
    }
    const afterOpen = snapshot(setup, `${id}-open-after`, state(setup))
    snapshots[afterOpen.id] = afterOpen
    const setupTransitionMonotonicNS = process.hrtime.bigint().toString()
    const interactionBefore = snapshot(setup, `${id}-interact-before`, state(setup))
    snapshots[interactionBefore.id] = interactionBefore
    const interactionDispatchMonotonicNS = process.hrtime.bigint().toString()
    const dispatch = await interact(setup)
    await flushes(setup, 6)
    const interactionAfter = snapshot(setup, `${id}-interact-after`, state(setup))
    snapshots[interactionAfter.id] = interactionAfter
    const interactionTransitionMonotonicNS = process.hrtime.bigint().toString()
    Object.assign(snapshots, intermediateSnapshots)
    const teardownDispatchMonotonicNS = process.hrtime.bigint().toString()
    setVisible(false)
    await flushes(setup)
    const afterClose = snapshot(setup, `${id}-close-after`, { visible: false })
    snapshots[afterClose.id] = afterClose
    const teardownTransitionMonotonicNS = process.hrtime.bigint().toString()
    const dispatchMethod = typeof dispatch.method === "string" ? dispatch.method : ""
    const interactionType = dispatch.device === "keyboard" ? "key" : dispatchMethod.includes("+") || dispatchMethod.includes("moveTo") ? "input" : "click"
    const events = [
      event(id, "test-setup", { type: "setup", target: "capture-surface" }, { device: "lifecycle", method: "mount", target: "capture-surface" }, beforeOpen, afterOpen, runID, setupDispatchMonotonicNS, setupTransitionMonotonicNS),
      event(id, "test-dispatch", {
        type: interactionType,
        target: dispatch.target,
        input: dispatch.input,
      }, dispatch, interactionBefore, interactionAfter, runID, interactionDispatchMonotonicNS, interactionTransitionMonotonicNS),
      event(id, "test-teardown", { type: "teardown", target: "capture-surface" }, { device: "lifecycle", method: "unmount", target: "capture-surface" }, interactionAfter, afterClose, runID, teardownDispatchMonotonicNS, teardownTransitionMonotonicNS),
    ]
    return {
      version: CAPTURE_VERSION,
      id,
      run_id: runID,
      viewport: VIEWPORT,
      snapshots,
      final_snapshot_id: interactionAfter.id,
      reachable_targets: sectionTargets(interactionAfter.frame, preferred),
      events,
    }
  } finally {
    setup?.renderer.destroy()
    if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previousXdgDataHome
    await rm(root, { recursive: true, force: true })
  }
}

const requested = JSON.parse(process.env.RIG_NATIVE_CAPTURE_IDS ?? "[]") as string[]
const outputPath = process.env.RIG_NATIVE_CAPTURE_FILE
const runID = process.env.RIG_NATIVE_CAPTURE_RUN_ID

test("native OpenTUI capture fixture emits exact frames, semantic spans, and observed transitions", async () => {
  assert.ok(outputPath, "RIG_NATIVE_CAPTURE_FILE is required")
  assert.ok(runID, "RIG_NATIVE_CAPTURE_RUN_ID is required")
  assert.ok(requested.length > 0, "RIG_NATIVE_CAPTURE_IDS is required")
  const captures: Record<string, unknown> = {}
  for (const id of requested) captures[id] = await capture(id)
  const output = { version: CAPTURE_VERSION, renderer_api: "OpenTUI.testRender.captureCharFrame+captureSpans", run_id: runID, captures }
  await mkdir(path.dirname(outputPath!), { recursive: true })
  await writeFile(outputPath!, `${JSON.stringify(output, null, 2)}\n`, "utf8")
})
