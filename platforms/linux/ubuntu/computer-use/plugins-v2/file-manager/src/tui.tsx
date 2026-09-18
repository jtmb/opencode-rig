/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
import { SyntaxStyle, getTreeSitterClient, type TextareaRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { spawn } from "node:child_process"
import { readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"

import {
  MAX_EDIT_BYTES,
  SEARCH_LIMIT,
  filetypeFor,
  flattenTree,
  isBinaryContent,
  isContained,
  isProtectedPath,
  nextIndex,
  normalizeRelative,
  normalizeSearchResults,
  tooLargeToEdit,
  type FileNode,
} from "./model.ts"
import { consumeMouseActivation, editorCursorPosition, type MouseActivation } from "./mouse.ts"
import { registerParsers, spikeParserAssets } from "./parsers.ts"
import {
  EMPTY_TABS,
  activateTab,
  closeTab,
  dirtyTabs,
  isDirtyTab,
  markSaved,
  nextTab,
  openTab,
  persistTabs,
  replaceTab,
  restorePaths,
  restoredActive,
  takeClosed,
  updateTab,
  type FileTab,
  type TabsState,
} from "./tabs.ts"

const PANEL_NAME = "file-manager.files"
const SEARCH_DEBOUNCE_MS = 150
const TREE_WIDTH = 36

type Mode = "tree" | "view" | "edit" | "search"

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

function projectDirectory(context: Context, sessionID: string): string {
  return (
    context.data.session.get(sessionID)?.location.directory ??
    context.location?.directory ??
    context.data.location.default().directory
  )
}

function createSyntaxStyle(theme: Context["theme"]): SyntaxStyle {
  return SyntaxStyle.fromStyles({
    default: { fg: theme.text.default },
    comment: { fg: theme.syntax.comment, italic: true },
    keyword: { fg: theme.syntax.keyword },
    string: { fg: theme.syntax.string },
    number: { fg: theme.syntax.number },
    boolean: { fg: theme.syntax.number },
    constant: { fg: theme.syntax.number },
    function: { fg: theme.syntax.function },
    variable: { fg: theme.syntax.variable },
    type: { fg: theme.syntax.type },
    operator: { fg: theme.syntax.operator },
    punctuation: { fg: theme.syntax.punctuation },
    property: { fg: theme.text.default },
  })
}

function FilesView(props: { sessionID: string; panel: PanelInput }) {
  const context = usePlugin()
  const directory = projectDirectory(context, props.sessionID)
  const root = directory
  const syntaxStyle = createSyntaxStyle(context.theme)

  const [children, setChildren] = createSignal<Map<string, FileNode[]>>(new Map())
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set())
  const [selected, setSelected] = createSignal("")
  const [hovered, setHovered] = createSignal<string | undefined>(undefined)
  const [tabs, setTabs] = createSignal<TabsState>(EMPTY_TABS)
  const [mode, setMode] = createSignal<Mode>("tree")
  const [cursor, setCursor] = createSignal<{ line: number; column: number }>({ line: 0, column: 0 })
  const [closeArmed, setCloseArmed] = createSignal(false)
  const [restored, setRestored] = createSignal(false)
  const [workspace, updateWorkspace] = context.storage.store("workspace", {
    initial: { tabs: {} as Record<string, { open: string[]; active: string }> },
  })
  let persistTimer: ReturnType<typeof setTimeout> | undefined
  const [results, setResults] = createSignal<string[]>([])
  const [resultIndex, setResultIndex] = createSignal(0)
  const [status, setStatus] = createSignal("")
  const [escapeArmed, setEscapeArmed] = createSignal(false)
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  let textareaRef: TextareaRenderable | undefined

  const rows = createMemo(() => flattenTree(children(), expanded()))
  const selectedIndex = createMemo(() => {
    const index = rows().findIndex((row) => row.node.path === selected())
    return index < 0 ? 0 : index
  })
  const activeTab = createMemo(() => tabs().open.find((entry) => entry.path === tabs().active))
  const dirty = createMemo(() => {
    const current = activeTab()
    return current ? isDirtyTab(current) : false
  })

  const loadDirectory = async (relative: string) => {
    try {
      const response = await context.client.file.list({ location: { directory }, path: relative })
      const nodes: FileNode[] = response.data.map((entry) => {
        const normalized = normalizeRelative(entry.path)
        return {
          name: basename(normalized),
          path: normalized,
          absolute: resolve(root, normalized),
          type: entry.type,
          ignored: false,
        }
      })
      setChildren((current) => {
        const next = new Map(current)
        next.set(relative, nodes)
        return next
      })
    } catch (error) {
      setStatus(`Cannot list ${relative || "."}: ${errorMessage(error)}`)
    }
  }

  const toggleDirectory = async (node: FileNode) => {
    const next = new Set(expanded())
    if (next.has(node.path)) {
      next.delete(node.path)
      setExpanded(next)
      return
    }
    next.add(node.path)
    setExpanded(next)
    if (!children().has(node.path)) await loadDirectory(node.path)
  }

  const readFileTab = async (relative: string): Promise<FileTab | undefined> => {
    if (isProtectedPath(relative)) {
      setStatus("Refusing to open .git contents")
      return undefined
    }
    const absolute = resolve(root, relative)
    if (!isContained(root, absolute)) {
      setStatus("Refusing to open a path outside the project")
      return undefined
    }
    try {
      const real = await realpath(absolute)
      if (!isContained(root, real)) {
        setStatus("Refusing to follow a symlink outside the project")
        return undefined
      }
      const info = await stat(real)
      if (tooLargeToEdit(info.size)) {
        setStatus(`${relative} is too large to open (limit ${Math.round(MAX_EDIT_BYTES / 1024)} KiB)`)
        return undefined
      }
      const bytes = await readFile(real)
      if (isBinaryContent(bytes)) {
        setStatus(`${relative} is binary and cannot be edited`)
        return undefined
      }
      const content = bytes.toString("utf8")
      return { path: relative, content, original: content }
    } catch (error) {
      setStatus(`Cannot read ${relative}: ${errorMessage(error)}`)
      return undefined
    }
  }

  const openFile = async (relative: string) => {
    const loaded = await readFileTab(relative)
    if (!loaded) return
    setTabs((state) => openTab(state, loaded))
    setMode("view")
    setEscapeArmed(false)
    setCloseArmed(false)
    setStatus("")
  }

  const reloadFile = async (relative: string) => {
    const loaded = await readFileTab(relative)
    if (!loaded) return
    setTabs((state) => replaceTab(state, loaded))
    setMode("view")
    setEscapeArmed(false)
    setCloseArmed(false)
    setStatus("")
  }

  const writeTab = async (current: FileTab): Promise<boolean> => {
    if (isProtectedPath(current.path)) {
      setStatus("Refusing to save .git contents")
      return false
    }
    const absolute = resolve(root, current.path)
    if (!isContained(root, absolute)) {
      setStatus("Refusing to save outside the project")
      return false
    }
    let temporary: string | undefined
    try {
      const real = await realpath(absolute)
      if (!isContained(root, real)) {
        setStatus("Refusing to follow a symlink outside the project")
        return false
      }
      temporary = join(dirname(real), `.${basename(real)}.${process.pid}.tmp`)
      await writeFile(temporary, current.content, "utf8")
      await rename(temporary, real)
      temporary = undefined
      setTabs((state) => markSaved(state, current.path))
      return true
    } catch (error) {
      setStatus(`Save failed: ${errorMessage(error)}`)
      return false
    } finally {
      if (temporary) await unlink(temporary).catch(() => undefined)
    }
  }

  const save = async () => {
    const current = activeTab()
    if (!current) return
    if (await writeTab(current)) setStatus(`Saved ${current.path}`)
  }

  const saveAll = async () => {
    const pending = dirtyTabs(tabs())
    if (pending.length === 0) {
      setStatus("Nothing to save")
      return
    }
    let saved = 0
    for (const entry of pending) {
      if (await writeTab(entry)) saved += 1
    }
    setStatus(saved === pending.length ? `Saved ${saved} files` : `Saved ${saved}/${pending.length} files`)
  }

  const closeActive = () => {
    const current = activeTab()
    if (!current) return
    if (dirty() && !closeArmed()) {
      setCloseArmed(true)
      setStatus("Unsaved changes: Alt+W again discards")
      return
    }
    setTabs((state) => closeTab(state, current.path))
    setCloseArmed(false)
    setEscapeArmed(false)
    setStatus("")
    if (!activeTab()) setMode("tree")
  }

  const reopenClosed = async () => {
    const popped = takeClosed(tabs())
    setTabs(popped.state)
    if (popped.path) await openFile(popped.path)
    else setStatus("No closed files to reopen")
  }

  const switchTab = (delta: number) => {
    setTabs((state) => nextTab(state, delta))
    setCloseArmed(false)
    setEscapeArmed(false)
    if (mode() === "edit") scheduleHighlight()
  }

  const goToLine = async () => {
    if (!activeTab() || !textareaRef || mode() !== "edit") {
      setStatus("Go to line is available in edit mode")
      return
    }
    const input = await context.ui.dialog.prompt({ title: "Go to line", placeholder: "Line number", value: "" })
    const line = Number.parseInt((input ?? "").trim(), 10)
    if (!Number.isFinite(line) || line < 1) return
    textareaRef.editBuffer.gotoLine(line - 1)
    scheduleHighlight()
  }

  // Click-to-position: the editable buffer has no built-in click handling, so
  // translate the mouse cell into a buffer row/column (display columns).
  const placeCursor = (event: { x: number; y: number; button?: number }) => {
    const area = textareaRef
    if (!area || mode() !== "edit") return
    if (event.button !== undefined && event.button !== 0) return
    const position = editorCursorPosition(
      event,
      {
        x: area.x,
        y: area.y,
        scrollY: area.scrollY,
        lineCount: area.lineCount,
        lines: area.plainText.split("\n"),
      },
    )
    if (position) area.editBuffer.setCursor(position.row, position.column)
  }

  const openExternal = async () => {
    const current = activeTab()
    if (!current) return
    const editor = (process.env.VISUAL || process.env.EDITOR || "").trim()
    if (!editor) {
      setStatus("Set $EDITOR or $VISUAL to open an external editor")
      return
    }
    const [command, ...editorArgs] = editor.split(/\s+/)
    const absolute = resolve(root, current.path)
    try {
      context.renderer.suspend()
      await new Promise<void>((done) => {
        const child = spawn(command, [...editorArgs, absolute], { stdio: "inherit" })
        child.on("error", () => done())
        child.on("exit", () => done())
      })
    } finally {
      context.renderer.resume()
    }
    await reloadFile(current.path)
  }

  const move = (delta: number) => {
    const list = rows()
    if (list.length === 0) return
    setSelected(list[nextIndex(selectedIndex(), list.length, delta)].node.path)
  }

  const openSelected = async () => {
    const row = rows()[selectedIndex()]
    if (!row) return
    if (row.node.type === "directory") {
      await toggleDirectory(row.node)
      return
    }
    await openFile(row.node.path)
  }

  // Mouse events can be hit-tested to the row box or to either text child
  // depending on the terminal/renderable, and they bubble. consumeMouseActivation
  // marks the event so the first handler that sees it acts exactly once.
  const activateRow = (event: MouseActivation, action: () => void) => {
    if (!consumeMouseActivation(event)) return
    event.preventDefault?.()
    action()
  }

  const activateNode = (node: FileNode) => {
    setSelected(node.path)
    if (node.type === "directory") void toggleDirectory(node)
    else void openFile(node.path)
  }

  const activateResult = (result: string, index: () => number) => {
    setResultIndex(index())
    void openFile(result)
  }

  // Spike: the editable textarea has no tree-sitter filetype hook in 0.5.11,
  // so highlights are computed through the host client and applied manually.
  let highlightTimer: ReturnType<typeof setTimeout> | undefined

  const styleIdFor = (capture: string): number | undefined => {
    const exact = syntaxStyle.getStyleId(capture)
    if (exact !== null && exact !== undefined) return exact
    const fallback = syntaxStyle.getStyleId(capture.split(".")[0])
    if (fallback !== null && fallback !== undefined) return fallback
    const base = syntaxStyle.getStyleId("default")
    return base === null || base === undefined ? undefined : base
  }

  const applyHighlights = async () => {
    const area = textareaRef
    const current = activeTab()
    if (!area || !current) return
    const filetype = filetypeFor(current.path)
    const buffer = area.editBuffer
    if (!filetype) {
      buffer.clearAllHighlights()
      return
    }
    try {
      const result = await getTreeSitterClient().highlightOnce(buffer.getText(), filetype)
      const highlights = result.highlights ?? []
      buffer.clearAllHighlights()
      for (const [start, end, capture] of highlights) {
        const styleId = styleIdFor(capture)
        if (styleId === undefined) continue
        buffer.addHighlightByCharRange({ start, end, styleId })
      }
    } catch {
      buffer.clearAllHighlights()
    }
  }

  const scheduleHighlight = () => {
    if (highlightTimer) clearTimeout(highlightTimer)
    highlightTimer = setTimeout(() => void applyHighlights(), 120)
  }

  const editSelected = async () => {
    await openSelected()
    if (activeTab()) {
      setMode("edit")
      scheduleHighlight()
    }
  }

  const externalSelected = async () => {
    await openSelected()
    if (activeTab()) await openExternal()
  }

  const expandSelected = async () => {
    const row = rows()[selectedIndex()]
    if (row?.node.type === "directory" && !row.expanded) await toggleDirectory(row.node)
  }

  const collapseOrParent = () => {
    const row = rows()[selectedIndex()]
    if (row?.node.type === "directory" && row.expanded) {
      const next = new Set(expanded())
      next.delete(row.node.path)
      setExpanded(next)
      return
    }
    const parent = row ? (row.node.path.includes("/") ? row.node.path.slice(0, row.node.path.lastIndexOf("/")) : "") : ""
    if (parent !== "") setSelected(parent)
  }

  const refresh = async () => {
    await Promise.all([...children().keys()].map((key) => loadDirectory(key)))
    const current = activeTab()
    if (current) {
      if (dirty()) setStatus("File changed on disk; save or reopen to refresh")
      else await reloadFile(current.path)
    }
  }

  const runSearch = (value: string) => {
    if (searchTimer) clearTimeout(searchTimer)
    const query = value.trim()
    if (!query) {
      setResults([])
      setResultIndex(0)
      return
    }
    searchTimer = setTimeout(async () => {
      try {
        const response = await context.client.file.find({ location: { directory }, query, type: "file", limit: SEARCH_LIMIT })
        setResults(normalizeSearchResults(response.data.map((entry) => entry.path), SEARCH_LIMIT))
        setResultIndex(0)
      } catch (error) {
        setStatus(`Search failed: ${errorMessage(error)}`)
        setResults([])
      }
    }, SEARCH_DEBOUNCE_MS)
  }

  const openSearchResult = async () => {
    const target = results()[resultIndex()]
    if (target) await openFile(target)
  }

  useKeyboard((key) => {
    if (!props.panel.focused) return
    const name = key.name
    if (key.ctrl && key.shift && name === "s") {
      key.preventDefault()
      key.stopPropagation()
      void saveAll()
      return
    }
    if (key.ctrl && name === "s") {
      if (mode() === "edit") {
        key.preventDefault()
        key.stopPropagation()
        void save()
      }
      return
    }
    if ((key.meta || key.option) && name === "w") {
      key.preventDefault()
      key.stopPropagation()
      closeActive()
      return
    }
    if ((key.meta || key.option) && name === "t") {
      key.preventDefault()
      key.stopPropagation()
      void reopenClosed()
      return
    }
    if ((key.meta || key.option) && (name === "right" || name === "left")) {
      key.preventDefault()
      key.stopPropagation()
      switchTab(name === "right" ? 1 : -1)
      return
    }
    if (key.ctrl && name === "g") {
      key.preventDefault()
      key.stopPropagation()
      void goToLine()
      return
    }

    if (mode() === "search") {
      if (name === "escape") {
        key.preventDefault()
        key.stopPropagation()
        setMode("tree")
        setResults([])
        return
      }
      if (name === "return") {
        key.preventDefault()
        key.stopPropagation()
        void openSearchResult()
        return
      }
      if (name === "up" || name === "k") {
        key.preventDefault()
        key.stopPropagation()
        setResultIndex((index) => nextIndex(index, results().length, -1))
        return
      }
      if (name === "down" || name === "j") {
        key.preventDefault()
        key.stopPropagation()
        setResultIndex((index) => nextIndex(index, results().length, 1))
      }
      return
    }

    if (mode() === "edit") {
      if (name === "escape") {
        key.preventDefault()
        key.stopPropagation()
        if (dirty() && !escapeArmed()) {
          setEscapeArmed(true)
          setStatus("Unsaved changes: Ctrl+S saves, Escape again discards")
          return
        }
        const current = activeTab()
        if (current) setTabs((state) => updateTab(state, current.path, current.original))
        setEscapeArmed(false)
        setMode("view")
        setStatus("")
      }
      return
    }

    if (name === "escape") {
      key.preventDefault()
      key.stopPropagation()
      if (mode() === "view") {
        setMode("tree")
        setStatus("")
        return
      }
      props.panel.close()
      return
    }

    if (mode() === "view") {
      if (name === "e" || name === "i") {
        key.preventDefault()
        key.stopPropagation()
        setMode("edit")
        scheduleHighlight()
        return
      }
      if (name === "o") {
        key.preventDefault()
        key.stopPropagation()
        void openExternal()
      }
      return
    }

    if (name === "up" || name === "k") {
      key.preventDefault()
      key.stopPropagation()
      move(-1)
      return
    }
    if (name === "down" || name === "j") {
      key.preventDefault()
      key.stopPropagation()
      move(1)
      return
    }
    if (name === "return") {
      key.preventDefault()
      key.stopPropagation()
      void openSelected()
      return
    }
    if (name === "right" || name === "l") {
      key.preventDefault()
      key.stopPropagation()
      void expandSelected()
      return
    }
    if (name === "left" || name === "h") {
      key.preventDefault()
      key.stopPropagation()
      collapseOrParent()
      return
    }
    if (name === "e") {
      key.preventDefault()
      key.stopPropagation()
      void editSelected()
      return
    }
    if (name === "o") {
      key.preventDefault()
      key.stopPropagation()
      void externalSelected()
      return
    }
    if (name === "/" || (key.ctrl && name === "p")) {
      key.preventDefault()
      key.stopPropagation()
      setMode("search")
      setResults([])
      setResultIndex(0)
      return
    }
    if (name === "f") {
      key.preventDefault()
      key.stopPropagation()
      props.panel.toggleFullscreen()
      return
    }
    if (name === "r") {
      key.preventDefault()
      key.stopPropagation()
      void refresh()
    }
  })

  const stopWatcher = context.data.on("filesystem.changed", (event) => {
    const changed = normalizeRelative(event.data.file)
    const current = activeTab()
    if (current && (changed === current.path || current.path.endsWith(`/${changed}`) || changed.endsWith(`/${current.path}`))) {
      if (dirty()) setStatus("File changed on disk; save or reopen to refresh")
      else void reloadFile(current.path)
    }
    void Promise.all([...children().keys()].map((key) => loadDirectory(key)))
  })

  onMount(() => {
    void (async () => {
      await loadDirectory("")
      const first = rows()[0]
      if (first) setSelected(first.node.path)
      const saved = workspace.tabs?.[props.sessionID]
      const paths = restorePaths(saved)
      if (paths.length > 0) {
        const desired = restoredActive(saved, paths)
        for (const path of paths) {
          const loaded = await readFileTab(path)
          if (loaded) setTabs((state) => openTab(state, loaded))
        }
        if (desired) setTabs((state) => activateTab(state, desired))
      }
      setRestored(true)
    })()
  })

  // Persist the tab list per session (paths only; content reloads on restore).
  createEffect(() => {
    if (!restored()) return
    const snapshot = persistTabs(tabs())
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      void updateWorkspace((draft) => {
        draft.tabs[props.sessionID] = snapshot
      })
    }, 400)
  })

  onCleanup(() => {
    stopWatcher()
    if (searchTimer) clearTimeout(searchTimer)
    if (highlightTimer) clearTimeout(highlightTimer)
    if (persistTimer) clearTimeout(persistTimer)
    syntaxStyle.destroy()
  })

  const theme = () => context.theme

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1}>
        <text fg={theme().hue.accent[200]}>
          <b>Files</b>
        </text>
        <text fg={theme().text.subdued}>{directory}</text>
        <box flexGrow={1} />
        <text fg={theme().text.subdued}>{status()}</text>
      </box>

      <Show when={tabs().open.length > 0}>
        <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1}>
          <For each={tabs().open}>
            {(entry) => (
              <box
                flexDirection="row"
                backgroundColor={entry.path === tabs().active ? theme().background.surface.offset : undefined}
                onMouseDown={(event) => activateRow(event, () => setTabs((state) => activateTab(state, entry.path)))}
              >
                <text fg={entry.path === tabs().active ? theme().hue.accent[200] : theme().text.default}>
                  {basename(entry.path)}
                </text>
                <Show when={isDirtyTab(entry)}>
                  <text fg={theme().text.feedback.warning.default}> •</text>
                </Show>
              </box>
            )}
          </For>
        </box>
      </Show>

      <box flexDirection="row" flexGrow={1} minHeight={0}>
        <box
          flexDirection="column"
          width={TREE_WIDTH}
          flexShrink={0}
          borderStyle="single"
          borderColor={theme().border.default}
        >
          <Show
            when={mode() === "search"}
            fallback={
              <Show
                when={rows().length > 0}
                fallback={<text fg={theme().text.subdued}> Loading...</text>}
              >
                <For each={rows()}>
                  {(row) => (
                    <box
                      flexDirection="row"
                      backgroundColor={selected() === row.node.path ? theme().background.surface.offset : undefined}
                      paddingLeft={row.depth * 2 + 1}
                      onMouseOver={() => setHovered(row.node.path)}
                      onMouseOut={() => setHovered((current) => (current === row.node.path ? undefined : current))}
                      onMouseDown={(event) => activateRow(event, () => activateNode(row.node))}
                    >
                      <text
                        fg={theme().text.subdued}
                        onMouseDown={(event) => activateRow(event, () => activateNode(row.node))}
                      >
                        {row.node.type === "directory" ? (row.expanded ? "- " : "+ ") : "  "}
                      </text>
                      <text
                        fg={hovered() === row.node.path ? theme().hue.accent[200] : theme().text.default}
                        onMouseDown={(event) => activateRow(event, () => activateNode(row.node))}
                      >
                        {row.node.name}
                      </text>
                    </box>
                  )}
                </For>
              </Show>
            }
          >
            <input
              focused
              placeholder="Search files"
              onInput={(value) => runSearch(value)}
              onSubmit={() => void openSearchResult()}
            />
            <For each={results()}>
              {(result, index) => (
                <box
                  flexDirection="row"
                  backgroundColor={index() === resultIndex() ? theme().background.surface.offset : undefined}
                  paddingLeft={1}
                  onMouseOver={() => setHovered(result)}
                  onMouseOut={() => setHovered((current) => (current === result ? undefined : current))}
                  onMouseDown={(event) => activateRow(event, () => activateResult(result, index))}
                >
                  <text
                    fg={hovered() === result ? theme().hue.accent[200] : theme().text.default}
                    onMouseDown={(event) => activateRow(event, () => activateResult(result, index))}
                  >
                    {result}
                  </text>
                </box>
              )}
            </For>
          </Show>
        </box>

        <box
          flexDirection="column"
          flexGrow={1}
          minHeight={0}
          borderStyle="single"
          borderColor={theme().border.default}
        >
          <Show keyed when={tabs().active} fallback={<text fg={theme().text.subdued}> Select a file to view or edit</text>}>
              <box flexDirection="column" flexGrow={1} minHeight={0}>
                <box flexDirection="row" gap={1} paddingLeft={1}>
                  <text fg={theme().hue.accent[200]}>{activeTab()!.path}</text>
                  <Show when={dirty()}>
                    <text fg={theme().text.feedback.warning.default}>*</text>
                  </Show>
                </box>
                <Show
                  when={mode() === "edit"}
                  fallback={
                    <scrollbox flexGrow={1} minHeight={0}>
                      <line_number fg={theme().text.subdued} minWidth={3} paddingRight={1}>
                        <code
                          content={activeTab()!.content}
                          filetype={filetypeFor(activeTab()!.path)}
                          syntaxStyle={syntaxStyle}
                          conceal={false}
                          fg={theme().text.default}
                        />
                      </line_number>
                    </scrollbox>
                  }
                >
                  <line_number fg={theme().text.subdued} minWidth={3} paddingRight={1} flexGrow={1}>
                    <textarea
                      ref={(value) => {
                        textareaRef = value
                      }}
                      focused
                      initialValue={activeTab()!.content}
                      syntaxStyle={syntaxStyle}
                      onCursorChange={(event) => setCursor({ line: event.line, column: event.visualColumn })}
                      onMouseDown={placeCursor}
                      onContentChange={() => {
                        const area = textareaRef
                        const active = activeTab()
                        if (active && area) setTabs((state) => updateTab(state, active.path, area.editBuffer.getText()))
                        scheduleHighlight()
                      }}
                    />
                  </line_number>
                </Show>
              </box>
          </Show>
        </box>
      </box>

      <Show when={activeTab()}>
        {(current) => (
          <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1}>
            <text fg={theme().text.subdued}>
              {current().path}
              {dirty() ? " • unsaved" : ""}
              {" • Ln "}
              {cursor().line + 1}
              {", Col "}
              {cursor().column + 1}
              {" • "}
              {filetypeFor(current().path) ?? "text"}
            </text>
          </box>
        )}
      </Show>

      <box paddingLeft={1}>
        <text fg={theme().text.subdued}>
          enter open · e edit · o external · / search · ctrl+s save · ctrl+shift+s save all · alt+←/→ tab · alt+w close · alt+t reopen · ctrl+g goto · f fullscreen · esc back
        </text>
      </box>
    </box>
  )
}

export default Plugin.define({
  id: "opencode-rig.file-manager",
  setup(context) {
    void registerParsers(spikeParserAssets())

    const stopPanel = context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === PANEL_NAME}>
          <FilesView sessionID={panel.sessionID} panel={panel} />
        </Show>
      ),
    })

    const stopKeymap = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "file-manager.open",
              title: "Open file manager",
              description: "Open the project file tree and editor panel.",
              group: "Files",
              bind: "ctrl+shift+e",
              palette: true,
              slash: { name: "files", aliases: ["explorer"] },
              run: () => {
                context.ui.panel.open(PANEL_NAME)
              },
            },
          ],
        }))
        return null as never
      },
    })

    const stopSidebar = context.ui.slot({
      append: "sidebar.content",
      render: () => (
        <box
          flexDirection="row"
          focusable
          onMouseDown={() => {
            context.ui.panel.open(PANEL_NAME)
          }}
          onKeyDown={(event) => {
            if (event.name === "return" || event.name === "space") {
              event.preventDefault()
              context.ui.panel.open(PANEL_NAME)
            }
          }}
        >
          <text fg={context.theme.hue.accent[200]}>
            <b>Explorer</b>
          </text>
        </box>
      ),
    })

    return () => {
      stopPanel()
      stopKeymap()
      stopSidebar()
    }
  },
})
