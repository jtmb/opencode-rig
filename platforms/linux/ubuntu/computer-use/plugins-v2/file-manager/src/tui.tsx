/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
import type { FileDiffInfo } from "@opencode/client"
import { SyntaxStyle, getTreeSitterClient, type ScrollBoxRenderable, type TextareaRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { spawn } from "node:child_process"

import { explorerBinding, EXPLORER_SLASH } from "./commands.ts"
import {
  MAX_EDIT_BYTES,
  SEARCH_LIMIT,
  fileNodesFromDirectoryEntries,
  filetypeFor,
  flattenTree,
  nextIndex,
  normalizeSearchResults,
  tooLargeToEdit,
  truncateToCellWidth,
  type FileNode,
} from "./model.ts"
import { consumeMouseActivation, editorCursorPosition, type MouseActivation } from "./mouse.ts"
import { managedParserAssets, parserAvailability, parserHighlightRangeToUtf16, registerParsers } from "./parsers.ts"
import { ExplorerTabs, ExplorerTree } from "./presentation.ts"
import {
  diffSourceLabel,
  effectiveDiffView,
  mergeRepositoryNodes,
  nextRepositoryFile,
  normalizeDiffFiles,
  patchHunkRows,
  type DiffSource,
  type DiffView,
} from "./repository.ts"
import { beginGeneration, invalidateGeneration, isCurrentGeneration, type GenerationToken } from "./generation.ts"
import {
  createPathGuard,
  DiskConflictError,
  parseEditorCommand,
  type PathGuard,
} from "./safety.ts"
import {
  EMPTY_TABS,
  activateTab,
  closeTab,
  dirtyTabs,
  dirtyGuard,
  dirtyGuardKey,
  dirtyGuards,
  isDirtyTab,
  markSavedSnapshot,
  nextTab,
  openTab,
  persistTabs,
  replaceTab,
  restorePaths,
  restoredActive,
  sameDirtyGuard,
  saveSnapshot,
  takeClosed,
  type DirtyGuard,
  updateTab,
  type FileTab,
  type TabsState,
} from "./tabs.ts"

const PANEL_NAME = "file-manager.files"
const SEARCH_DEBOUNCE_MS = 150
let parserReady: Promise<unknown> = Promise.resolve()
let availableParsers = parserAvailability()

type Mode = "tree" | "view" | "edit" | "search"
type ViewerFocus = "files" | "content"

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
  const pathGuardPromise = createPathGuard(directory)
  const syntaxStyle = createSyntaxStyle(context.theme)

  const [children, setChildren] = createSignal<Map<string, FileNode[]>>(new Map())
  const [diffs, setDiffs] = createSignal<Map<string, FileDiffInfo>>(new Map())
  const [diffSource, setDiffSource] = createSignal<DiffSource>("working")
  const [diffView, setDiffView] = createSignal<DiffView>("split")
  const [diffLoading, setDiffLoading] = createSignal(false)
  const [diffError, setDiffError] = createSignal("")
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set())
  const [selected, setSelected] = createSignal("")
  const [viewPath, setViewPath] = createSignal("")
  const [viewerFocus, setViewerFocus] = createSignal<ViewerFocus>("files")
  const [treeVisible, setTreeVisible] = createSignal(true)
  const [allChanges, setAllChanges] = createSignal(true)
  const [reviewed, setReviewed] = createSignal<ReadonlySet<string>>(new Set())
  const [selectedHunk, setSelectedHunk] = createSignal(-1)
  const [hovered, setHovered] = createSignal<string | undefined>(undefined)
  const [tabs, setTabs] = createSignal<TabsState>(EMPTY_TABS)
  const [mode, setMode] = createSignal<Mode>("tree")
  const [cursor, setCursor] = createSignal<{ line: number; column: number }>({ line: 0, column: 0 })
  const cursorByPath = new Map<string, { line: number; column: number }>()
  const [closeArmed, setCloseArmed] = createSignal<DirtyGuard | undefined>(undefined)
  const [panelCloseArmed, setPanelCloseArmed] = createSignal("")
  const [parserStates, setParserStates] = createSignal(availableParsers)
  const [refreshArmed, setRefreshArmed] = createSignal("")
  const [restored, setRestored] = createSignal(false)
  const [workspace, updateWorkspace] = context.storage.store("workspace", {
    initial: { tabs: {} as Record<string, { open: string[]; active: string }> },
  })
  let persistTimer: ReturnType<typeof setTimeout> | undefined
  const [results, setResults] = createSignal<string[]>([])
  const [resultIndex, setResultIndex] = createSignal(0)
  const [status, setStatus] = createSignal("")
  const [escapeArmed, setEscapeArmed] = createSignal<DirtyGuard | undefined>(undefined)
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  let textareaRef: TextareaRenderable | undefined
  let searchScrollBox: ScrollBoxRenderable | undefined
  let contentScrollBox: ScrollBoxRenderable | undefined
  let pathGuard: PathGuard | undefined
  const directoryGenerations = new Map<string, number>()
  const fileGenerations = new Map<string, number>()
  const searchGenerations = new Map<string, number>()
  const highlightGenerations = new Map<string, number>()
  let persistQueue = Promise.resolve()

  const getPathGuard = async (): Promise<PathGuard> => {
    if (!pathGuard) pathGuard = await pathGuardPromise
    return pathGuard
  }

  const currentDirtyKey = () => dirtyGuardKey(dirtyGuards(tabs()))

  const rows = createMemo(() => flattenTree(children(), expanded()))
  const selectedIndex = createMemo(() => {
    const index = rows().findIndex((row) => row.node.path === selected())
    return index < 0 ? 0 : index
  })
  createEffect(() => {
    const result = results()[resultIndex()]
    if (result && searchScrollBox) searchScrollBox.scrollChildIntoView(`explorer-search-row:${encodeURIComponent(result)}`)
  })
  const activeTab = createMemo(() => tabs().open.find((entry) => entry.path === tabs().active))
  const viewedTab = createMemo(() => tabs().open.find((entry) => entry.path === viewPath()))
  const visibleDiffs = createMemo(() => [...diffs().values()].sort((left, right) => left.file.localeCompare(right.file)))
  const selectedDiff = createMemo(() => diffs().get(viewPath()))
  const canToggleDiffView = createMemo(() => allChanges() || selectedDiff()?.status === "modified")
  const headerDiffView = createMemo(() => {
    const current = selectedDiff()
    return current && !allChanges() ? effectiveDiffView(current.status, diffView()) : diffView()
  })
  const dirty = createMemo(() => {
    const current = viewedTab()
    return current ? isDirtyTab(current) : false
  })

  const loadDirectory = async (relative: string) => {
    const generation = beginGeneration(directoryGenerations, relative)
    try {
      const guard = await getPathGuard()
      const safeDirectory = relative ? guard.normalize(relative) : ""
      let physical: FileNode[]
      try {
        physical = fileNodesFromDirectoryEntries(await guard.listDirectory(safeDirectory))
      } catch (error) {
        const virtual = mergeRepositoryNodes(safeDirectory, [], diffs())
        if (virtual.length === 0) throw error
        physical = []
      }
      const nodes = mergeRepositoryNodes(safeDirectory, physical, diffs())
      if (!isCurrentGeneration(directoryGenerations, generation)) return
      setChildren((current) => {
        const next = new Map(current)
        next.set(safeDirectory, nodes)
        return next
      })
    } catch (error) {
      if (!isCurrentGeneration(directoryGenerations, generation)) return
      setStatus(`Cannot list ${relative || "."}: ${errorMessage(error)}`)
    }
  }

  const loadDiffs = async (source = diffSource()) => {
    setDiffLoading(true)
    setDiffError("")
    try {
      const files = source === "last-turn"
        ? await context.client.session.diff({ sessionID: props.sessionID, context: 12 })
        : (await context.client.vcs.diff({ location: { directory }, mode: source, context: 12 })).data
      setDiffs(normalizeDiffFiles(files))
      await Promise.all([...children().keys()].map((key) => loadDirectory(key)))
    } catch (error) {
      const message = errorMessage(error)
      setDiffError(message)
      setStatus(`Diff refresh failed: ${message}`)
    } finally {
      setDiffLoading(false)
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
    let normalized: string
    let generation: GenerationToken
    try {
      const guard = await getPathGuard()
      normalized = guard.normalize(relative)
      generation = beginGeneration(fileGenerations, normalized)
      const loaded = await guard.readText(normalized)
      if (!isCurrentGeneration(fileGenerations, generation)) return undefined
      if (tooLargeToEdit(loaded.info.size)) {
        setStatus(`${normalized} is too large to edit (limit ${Math.round(MAX_EDIT_BYTES / 1024)} KiB)`)
        return undefined
      }
      return {
        path: loaded.relative,
        content: loaded.content,
        original: loaded.content,
        diskFingerprint: loaded.fingerprint,
        mode: loaded.mode,
        revision: 0,
      }
    } catch (error) {
      setStatus(`Cannot read ${relative}: ${errorMessage(error)}`)
      return undefined
    }
  }

  const openFile = async (relative: string) => {
    const changed = diffs().get(relative)
    const loaded = changed?.status === "deleted" ? undefined : await readFileTab(relative)
    if (!loaded && !changed) return
    if (loaded) {
      // Navigation keeps dirty buffers open. Only close/discard/reload/panel
      // exit use the destructive confirmation guards.
      setTabs((state) => openTab(state, loaded))
    }
    setSelected(relative)
    setViewPath(loaded?.path ?? relative)
    setMode("view")
    setViewerFocus("content")
    setAllChanges(false)
    setSelectedHunk(-1)
    setEscapeArmed(undefined)
    setCloseArmed(undefined)
    if (loaded || changed?.status === "deleted") setStatus("")
  }

  const reloadFile = async (relative: string) => {
    const existing = tabs().open.find((entry) => entry.path === relative)
    if (existing && isDirtyTab(existing)) {
      setStatus(`Unsaved changes in ${relative}; save or discard before reloading`)
      return
    }
    const loaded = await readFileTab(relative)
    if (!loaded) return
    if (!tabs().open.some((entry) => entry.path === loaded.path)) return
    setTabs((state) => replaceTab(state, loaded))
    if (tabs().active === loaded.path) setMode("view")
    setEscapeArmed(undefined)
    setCloseArmed(undefined)
    setStatus("")
  }

  const writeTab = async (current: FileTab): Promise<{ saved: boolean; newer: boolean }> => {
    const snapshot = saveSnapshot(current)
    if (!snapshot) {
      setStatus(`Cannot save ${current.path}: no disk baseline is available`)
      return { saved: false, newer: false }
    }
    try {
      const guard = await getPathGuard()
      const written = await guard.writeText(snapshot)
      let newer = false
      setTabs((state) => {
        const next = markSavedSnapshot(state, snapshot, written.fingerprint, written.mode)
        const currentTab = next.open.find((entry) => entry.path === snapshot.path)
        newer = !!currentTab && isDirtyTab(currentTab)
        return next
      })
      return { saved: true, newer }
    } catch (error) {
      if (error instanceof DiskConflictError) {
        setStatus(`Save refused: ${current.path} changed on disk; reload or resolve the conflict`)
      } else {
        setStatus(`Save failed: ${errorMessage(error)}`)
      }
      return { saved: false, newer: false }
    }
  }

  const save = async () => {
    const current = activeTab()
    if (!current) return
    const result = await writeTab(current)
    if (result.saved) setStatus(result.newer ? `Saved ${current.path}; newer edits remain unsaved` : `Saved ${current.path}`)
  }

  const saveAll = async () => {
    const pending = dirtyTabs(tabs())
    if (pending.length === 0) {
      setStatus("Nothing to save")
      return
    }
    let saved = 0
    let newer = 0
    for (const entry of pending) {
      const result = await writeTab(entry)
      if (result.saved) saved += 1
      if (result.newer) newer += 1
    }
    setStatus(
      saved === pending.length
        ? newer > 0
          ? `Saved ${saved} files; newer edits remain unsaved`
          : `Saved ${saved} files`
        : `Saved ${saved}/${pending.length} files`,
    )
  }

  const closeActive = () => {
    const current = viewedTab()
    if (!current) {
      setViewPath("")
      setMode("tree")
      setViewerFocus("files")
      return
    }
    if (!current) return
    if (dirty()) {
      const guard = dirtyGuard(current)
      if (!sameDirtyGuard(closeArmed(), guard)) {
        setCloseArmed(guard)
        setStatus("Unsaved changes: Alt+W again discards")
        return
      }
    }
    setTabs((state) => closeTab(state, current.path))
    setViewPath(tabs().active)
    setCloseArmed(undefined)
    setEscapeArmed(undefined)
    setStatus("")
    if (!activeTab()) setMode("tree")
    else setMode("view")
  }

  const closePanel = () => {
    const key = currentDirtyKey()
    if (key && panelCloseArmed() !== key) {
      setPanelCloseArmed(key)
      setStatus("Unsaved changes in open tabs: press Escape again to close")
      return
    }
    props.panel.close()
  }

  const reopenClosed = async () => {
    const popped = takeClosed(tabs())
    setTabs(popped.state)
    if (popped.path) await openFile(popped.path)
    else setStatus("No closed files to reopen")
  }

  const switchTab = (delta: number) => {
    setTabs((state) => nextTab(state, delta))
    setViewPath(tabs().active)
    setCloseArmed(undefined)
    setEscapeArmed(undefined)
    if (mode() === "edit") scheduleHighlight()
  }

  const activatePath = (path: string) => {
    setTabs((state) => activateTab(state, path))
    setViewPath(path)
    setMode("view")
    setCloseArmed(undefined)
    setEscapeArmed(undefined)
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
    const current = viewedTab()
    if (!current) return
    if (isDirtyTab(current)) {
      setStatus("Save or discard unsaved changes before opening an external editor")
      return
    }
    const editor = (process.env.VISUAL || process.env.EDITOR || "").trim()
    if (!editor) {
      setStatus("Set $EDITOR or $VISUAL to open an external editor")
      return
    }
    const parsed = parseEditorCommand(editor)
    if (!parsed) {
      setStatus("External editor command is invalid or too long")
      return
    }
    let absolute: string
    let suspended = false
    try {
      const guard = await getPathGuard()
      const inspected = await guard.inspect(current.path)
      if (!inspected.info.isFile()) {
        setStatus("External editor requires a regular file")
        return
      }
      absolute = inspected.canonical
      context.renderer.suspend()
      suspended = true
      const succeeded = await new Promise<boolean>((done) => {
        let settled = false
        const finish = (value: boolean) => {
          if (settled) return
          settled = true
          done(value)
        }
        try {
          const child = spawn(parsed.command, [...parsed.args, absolute], { stdio: "inherit", shell: false })
          child.once("error", () => finish(false))
          child.once("exit", (code, signal) => finish(code === 0 && signal === null))
        } catch {
          finish(false)
        }
      })
      if (!succeeded) {
        setStatus("External editor failed; the current tab was not reloaded")
        return
      }
    } finally {
      if (suspended) context.renderer.resume()
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

  // The editable textarea has no tree-sitter filetype hook in 0.5.11, so
  // highlights are computed through the host client and applied manually.
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
    await parserReady
    const generation = { key: "editor", value: highlightGenerations.get("editor") ?? 0 }
    const area = textareaRef
    const current = activeTab()
    if (!area || !current) return
    const filetype = filetypeFor(current.path)
    const buffer = area.editBuffer
    const content = buffer.getText()
    const pathAtRequest = current.path
    if (!filetype) {
      buffer.clearAllHighlights()
      return
    }
    try {
      const result = await getTreeSitterClient().highlightOnce(content, filetype)
      const active = activeTab()
      if (
        !isCurrentGeneration(highlightGenerations, generation) ||
        !active ||
        active.path !== pathAtRequest ||
        textareaRef !== area ||
        buffer.getText() !== content
      ) {
        return
      }
      const highlights = result.highlights ?? []
      if (result.warning || result.error) setStatus(`${pathAtRequest}: ${result.warning ?? result.error}`)
      buffer.clearAllHighlights()
      const offsetMode = process.env.RIG_TREE_SITTER_OFFSETS === "bytes" ? "bytes" : "characters"
      for (const [start, end, capture] of highlights) {
        const styleId = styleIdFor(capture)
        if (styleId === undefined) continue
        buffer.addHighlightByCharRange({ ...parserHighlightRangeToUtf16(content, start, end, offsetMode), styleId })
      }
    } catch (error) {
      if (!isCurrentGeneration(highlightGenerations, generation) || textareaRef !== area || buffer.getText() !== content) return
      buffer.clearAllHighlights()
      setStatus(`${pathAtRequest}: syntax highlighting unavailable (${errorMessage(error)})`)
    }
  }

  const scheduleHighlight = () => {
    const generation = beginGeneration(highlightGenerations, "editor")
    if (highlightTimer) clearTimeout(highlightTimer)
    highlightTimer = setTimeout(() => {
      if (isCurrentGeneration(highlightGenerations, generation)) void applyHighlights()
    }, 120)
  }

  const editSelected = async () => {
    const row = rows()[selectedIndex()]
    if (!row || row.node.type !== "file") return
    await openFile(row.node.path)
    if (viewedTab()?.path === row.node.path) {
      setMode("edit")
      scheduleHighlight()
    }
  }

  const externalSelected = async () => {
    const row = rows()[selectedIndex()]
    if (!row || row.node.type !== "file") return
    await openFile(row.node.path)
    if (viewedTab()?.path === row.node.path) await openExternal()
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
    const dirtyKey = currentDirtyKey()
    if (dirtyKey && refreshArmed() !== dirtyKey) {
      setRefreshArmed(dirtyKey)
      setStatus("Unsaved changes in open tabs: press refresh again to refresh clean files")
      return
    }
    setRefreshArmed("")
    await loadDiffs()
    const current = viewedTab()
    if (current) {
      if (dirty()) setStatus("File changed on disk; save or reopen to refresh")
      else await reloadFile(current.path)
    }
  }

  const runSearch = (value: string) => {
    const generation = beginGeneration(searchGenerations, "query")
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
        if (!isCurrentGeneration(searchGenerations, generation)) return
        setResults(normalizeSearchResults(response.data.map((entry) => entry.path), SEARCH_LIMIT))
        setResultIndex(0)
      } catch (error) {
        if (!isCurrentGeneration(searchGenerations, generation)) return
        setStatus(`Search failed: ${errorMessage(error)}`)
        setResults([])
      }
    }, SEARCH_DEBOUNCE_MS)
  }

  const openSearchResult = async () => {
    const target = results()[resultIndex()]
    if (target) await openFile(target)
  }

  const persistWorkspace = () => {
    if (!restored()) return
    const snapshot = persistTabs(tabs())
    persistQueue = persistQueue.then(
      () => updateWorkspace((draft) => {
        draft.tabs[props.sessionID] = snapshot
      }),
      () => updateWorkspace((draft) => {
        draft.tabs[props.sessionID] = snapshot
      }),
    )
  }

  const jumpFile = async (delta: number) => {
    const target = nextRepositoryFile(rows(), viewPath() || selected(), delta)
    if (!target) return
    setSelected(target)
    await openFile(target)
  }

  const jumpHunk = (delta: number) => {
    const changed = diffs().get(viewPath())
    if (!changed) {
      setStatus("Hunk navigation is available for changed files")
      return
    }
    const hunks = patchHunkRows(changed.patch)
    if (hunks.length === 0) return
    const current = selectedHunk()
    const next = current < 0
      ? (delta > 0 ? 0 : hunks.length - 1)
      : (current + delta + hunks.length) % hunks.length
    setSelectedHunk(next)
    contentScrollBox?.scrollTo(Math.max(0, hunks[next] - 1))
  }

  const toggleReviewed = () => {
    const path = viewPath() || selected()
    if (!path) return
    setReviewed((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const toggleDiffView = () => setDiffView((value) => value === "split" ? "unified" : "split")

  const switchDiffSource = async () => {
    const source = await context.ui.dialog.select<DiffSource>({
      title: "Switch source",
      current: diffSource(),
      options: [
        { title: "Working tree", value: "working", description: "Show current Git changes" },
        { title: "Main branch", value: "branch", description: "Show changes compared with the main branch" },
        { title: "Last turn", value: "last-turn", description: "Show changes from the last assistant turn" },
      ],
    })
    if (!source) return
    setDiffSource(source)
    setAllChanges(true)
    setViewPath("")
    setMode("view")
    setViewerFocus("content")
    await loadDiffs(source)
  }

  const showHelp = () => context.ui.dialog.alert({
    title: "Explorer shortcuts",
    message: [
      "Tab focus files/content · j/k move or scroll · Enter open/toggle",
      "n/p next/previous file · ]/[ next/previous hunk",
      "a all/selected changes · v split/unified · t file tree · d source",
      "m mark reviewed · / search · e edit · o external editor · r refresh",
      "Ctrl+S save · q close · Esc back",
    ].join("\n"),
  })

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

    if (mode() !== "edit" && mode() !== "search") {
      if (name === "q") {
        key.preventDefault()
        key.stopPropagation()
        closePanel()
        return
      }
      if (name === "tab") {
        key.preventDefault()
        key.stopPropagation()
        if (viewerFocus() === "files") {
          setViewerFocus("content")
          setMode("view")
        } else {
          setTreeVisible(true)
          setViewerFocus("files")
          setMode("tree")
        }
        return
      }
      if (name === "t") {
        key.preventDefault()
        key.stopPropagation()
        setTreeVisible((value) => !value)
        setViewerFocus((value) => value === "files" ? "content" : value)
        setMode("view")
        return
      }
      if (name === "v") {
        key.preventDefault()
        key.stopPropagation()
        toggleDiffView()
        return
      }
      if (name === "a") {
        key.preventDefault()
        key.stopPropagation()
        setAllChanges((value) => !value)
        setViewerFocus("content")
        setMode("view")
        return
      }
      if (name === "d") {
        key.preventDefault()
        key.stopPropagation()
        void switchDiffSource()
        return
      }
      if (name === "m") {
        key.preventDefault()
        key.stopPropagation()
        toggleReviewed()
        return
      }
      if (name === "?" || (key.shift && name === "/")) {
        key.preventDefault()
        key.stopPropagation()
        void showHelp()
        return
      }
      if (name === "n") {
        key.preventDefault()
        key.stopPropagation()
        void jumpFile(1)
        return
      }
      if (name === "p") {
        key.preventDefault()
        key.stopPropagation()
        void jumpFile(-1)
        return
      }
      if (name === "]") {
        key.preventDefault()
        key.stopPropagation()
        jumpHunk(1)
        return
      }
      if (name === "[") {
        key.preventDefault()
        key.stopPropagation()
        jumpHunk(-1)
        return
      }
      if (viewerFocus() === "content" && (name === "pagedown" || name === "pageup")) {
        key.preventDefault()
        key.stopPropagation()
        contentScrollBox?.scrollBy(name === "pagedown" ? (contentScrollBox.height || 8) : -(contentScrollBox.height || 8))
        return
      }
    }

    if (mode() === "search") {
      if (name === "escape") {
        key.preventDefault()
        key.stopPropagation()
        invalidateGeneration(searchGenerations, "query")
        setMode("tree")
        setViewerFocus("files")
        setResults([])
        return
      }
      if (name === "return") {
        key.preventDefault()
        key.stopPropagation()
        void openSearchResult()
        return
      }
      if (key.option && name === "up") {
        key.preventDefault()
        key.stopPropagation()
        setResultIndex((index) => nextIndex(index, results().length, -1))
        return
      }
      if (key.option && name === "down") {
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
        const current = activeTab()
        if (current && isDirtyTab(current) && !sameDirtyGuard(escapeArmed(), dirtyGuard(current))) {
          setEscapeArmed(dirtyGuard(current))
          setStatus("Unsaved changes: Ctrl+S saves, Escape again discards")
          return
        }
        if (current) setTabs((state) => updateTab(state, current.path, current.original))
        setEscapeArmed(undefined)
        setMode("view")
        setViewerFocus("content")
        setStatus("")
      }
      return
    }

    if (name === "escape") {
      key.preventDefault()
      key.stopPropagation()
      if (mode() === "view") {
        setMode("tree")
        setTreeVisible(true)
        setViewerFocus("files")
        setStatus("")
        return
      }
      closePanel()
      return
    }

    if (mode() === "view") {
      if (name === "e" || name === "i") {
        key.preventDefault()
        key.stopPropagation()
        if (viewedTab()) {
          setMode("edit")
          scheduleHighlight()
        } else {
          setStatus("This diff-only file cannot be edited")
        }
        return
      }
      if (name === "o") {
        key.preventDefault()
        key.stopPropagation()
        void openExternal()
        return
      }
      if (name === "up" || name === "k") {
        key.preventDefault()
        key.stopPropagation()
        contentScrollBox?.scrollBy(-1)
        return
      }
      if (name === "down" || name === "j") {
        key.preventDefault()
        key.stopPropagation()
        contentScrollBox?.scrollBy(1)
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
      setTreeVisible(true)
      setViewerFocus("files")
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
    void (async () => {
      let changed: string
      try {
        changed = (await getPathGuard()).normalize(event.data.file)
      } catch {
        return
      }
      const current = viewedTab()
      if (current && (changed === current.path || current.path.endsWith(`/${changed}`) || changed.endsWith(`/${current.path}`))) {
        if (dirty()) setStatus("File changed on disk; save or reopen to refresh")
        else await reloadFile(current.path)
      }
      await loadDiffs()
    })()
  })

  onMount(() => {
    void parserReady.then(() => setParserStates(new Map(availableParsers)))
    void (async () => {
      await loadDiffs()
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
    tabs()
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(persistWorkspace, 400)
  })

  createEffect(() => {
    const path = tabs().active
    setCursor(path ? (cursorByPath.get(path) ?? { line: 0, column: 0 }) : { line: 0, column: 0 })
  })

  onCleanup(() => {
    stopWatcher()
    invalidateGeneration(searchGenerations, "query")
    invalidateGeneration(highlightGenerations, "editor")
    if (searchTimer) clearTimeout(searchTimer)
    if (highlightTimer) clearTimeout(highlightTimer)
    if (persistTimer) clearTimeout(persistTimer)
    persistWorkspace()
    syntaxStyle.destroy()
  })

  const theme = () => context.theme
  const treeWidth = () => Math.max(24, Math.min(36, Math.floor(props.panel.width * 0.25)))

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <box flexDirection="row" height={1} flexShrink={0} overflow="hidden" gap={1} paddingLeft={1} paddingRight={1}>
        <text fg={theme().text.default}><b>Explorer</b></text>
        <text fg={theme().text.subdued}>{diffSourceLabel(diffSource())}</text>
        <box flexGrow={1} />
        <Show when={diffLoading()}><text fg={theme().text.subdued}>Loading…</text></Show>
        <Show when={diffError()}><text fg={theme().text.feedback.error.default}>Diff unavailable</text></Show>
        <Show when={status()}><text fg={theme().text.subdued}>{truncateToCellWidth(status(), 42)}</text></Show>
        <Show when={allChanges() || selectedDiff()}>
          <Show when={canToggleDiffView()} fallback={
            <text fg={theme().text.subdued}>[Diff: full width]</text>
          }>
            <box
              focusable
              onMouseDown={(event) => activateRow(event, toggleDiffView)}
              onKeyDown={(event) => {
                if (event.name !== "return" && event.name !== "space") return
                event.preventDefault()
                toggleDiffView()
              }}
            >
              <text fg={theme().hue.accent[200]}><u>[Diff: {headerDiffView() === "split" ? "side by side" : "full width"}]</u></text>
            </box>
          </Show>
        </Show>
        <text fg={theme().text.subdued}>{visibleDiffs().length} changed</text>
      </box>

      <Show when={mode() === "edit" && tabs().open.length > 0}>
        <ExplorerTabs
          paths={() => tabs().open.map((entry) => ({ path: entry.path, dirty: isDirtyTab(entry) }))}
          active={() => tabs().active}
          palette={{ accent: theme().hue.accent[200], text: theme().text.default, subdued: theme().text.subdued, selected: theme().background.surface.offset }}
          onActivate={activatePath}
        />
      </Show>

      <box flexDirection="row" flexGrow={1} minHeight={0}>
        <Show when={treeVisible()}>
          <box
            flexDirection="column"
            width={treeWidth()}
            minWidth={24}
            maxWidth={36}
            flexShrink={0}
            borderStyle="single"
            borderColor={viewerFocus() === "files" ? theme().hue.accent[200] : theme().border.default}
          >
            <Show
              when={mode() === "search"}
              fallback={<ExplorerTree
                rows={() => rows()}
                selected={() => selected()}
                reviewed={reviewed}
                width={() => Math.max(0, treeWidth() - 2)}
                palette={{ accent: theme().hue.accent[200], text: theme().text.default, subdued: theme().text.subdued, selected: theme().background.surface.offset }}
                onHover={(path) => setHovered(path)}
                onActivate={(row) => activateNode(row.node)}
              />}
            >
              <input
                focused
                placeholder="Search files"
                onInput={(value) => runSearch(value)}
                onSubmit={() => void openSearchResult()}
              />
              <scrollbox ref={(value) => (searchScrollBox = value)} flexGrow={1} minHeight={0} overflow="hidden"><For each={results()}>
                {(result, index) => (
                  <box
                    id={`explorer-search-row:${encodeURIComponent(result)}`}
                    height={1}
                    flexShrink={0}
                    overflow="hidden"
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
                      {truncateToCellWidth(result, Math.max(4, treeWidth() - 3))}
                    </text>
                  </box>
                )}
              </For></scrollbox>
            </Show>
          </box>
        </Show>

        <box
          flexDirection="column"
          flexGrow={1}
          minHeight={0}
          borderStyle="single"
          borderColor={viewerFocus() === "content" ? theme().hue.accent[200] : theme().border.default}
        >
          <Show when={mode() === "edit" && viewedTab()} fallback={
            <Show when={allChanges() || !viewPath()} fallback={
              <Show when={diffs().get(viewPath())} fallback={
                <Show when={viewedTab()} fallback={<text fg={theme().text.subdued}> Select a file to view or edit</text>}>
                  {(current) => (
                    <box flexDirection="column" flexGrow={1} minHeight={0}>
                      <box flexDirection="row" paddingLeft={1} paddingRight={1}>
                        <text fg={theme().text.default}>{current().path}</text>
                        <box flexGrow={1} />
                        <Show when={isDirtyTab(current())}><text fg={theme().text.feedback.warning.default}>unsaved</text></Show>
                      </box>
                      <scrollbox ref={(value) => (contentScrollBox = value)} flexGrow={1} minHeight={0}>
                        <line_number fg={theme().text.subdued} minWidth={3} paddingRight={1}>
                          <code content={current().content} filetype={filetypeFor(current().path)} syntaxStyle={syntaxStyle} conceal={false} fg={theme().text.default} />
                        </line_number>
                      </scrollbox>
                    </box>
                  )}
                </Show>
              }>
                {(changed) => (
                  <box flexDirection="column" flexGrow={1} minHeight={0}>
                    <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1}>
                      <text fg={reviewed().has(changed().file) ? theme().text.subdued : theme().text.default}>{changed().file}</text>
                      <box flexGrow={1} />
                      <text fg={theme().diff.text.added}>+{changed().additions}</text>
                      <text fg={theme().diff.text.removed}>-{changed().deletions}</text>
                    </box>
                    <scrollbox ref={(value) => (contentScrollBox = value)} flexGrow={1} minHeight={0}>
                      <diff
                        diff={changed().patch}
                        view={effectiveDiffView(changed().status, diffView())}
                        filetype={filetypeFor(changed().file)}
                        syntaxStyle={syntaxStyle}
                        showLineNumbers={true}
                        wrapMode="char"
                        fg={theme().text.default}
                        addedBg={theme().diff.background.added}
                        removedBg={theme().diff.background.removed}
                        contextBg={theme().diff.background.context}
                        addedSignColor={theme().diff.highlight.added}
                        removedSignColor={theme().diff.highlight.removed}
                        lineNumberFg={theme().diff.lineNumber.text}
                        addedLineNumberBg={theme().diff.lineNumber.background.added}
                        removedLineNumberBg={theme().diff.lineNumber.background.removed}
                      />
                    </scrollbox>
                  </box>
                )}
              </Show>
            }>
              <Show when={!diffLoading() && visibleDiffs().length === 0}>
                <text fg={theme().text.subdued}>No changes. Select any repository file from the tree.</text>
              </Show>
              <scrollbox ref={(value) => (contentScrollBox = value)} flexGrow={1} minHeight={0}>
                <For each={visibleDiffs()}>
                  {(changed, index) => (
                    <box flexDirection="column">
                      <Show when={index() > 0}><text fg={theme().border.default}>────────────────────────────────────────</text></Show>
                      <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1}>
                        <text fg={reviewed().has(changed.file) ? theme().text.subdued : theme().text.default}>{changed.file}</text>
                        <box flexGrow={1} />
                        <text fg={theme().diff.text.added}>+{changed.additions}</text>
                        <text fg={theme().diff.text.removed}>-{changed.deletions}</text>
                      </box>
                      <diff
                        diff={changed.patch}
                        view={effectiveDiffView(changed.status, diffView())}
                        filetype={filetypeFor(changed.file)}
                        syntaxStyle={syntaxStyle}
                        showLineNumbers={true}
                        wrapMode="char"
                        fg={theme().text.default}
                        addedBg={theme().diff.background.added}
                        removedBg={theme().diff.background.removed}
                        contextBg={theme().diff.background.context}
                        addedSignColor={theme().diff.highlight.added}
                        removedSignColor={theme().diff.highlight.removed}
                        lineNumberFg={theme().diff.lineNumber.text}
                        addedLineNumberBg={theme().diff.lineNumber.background.added}
                        removedLineNumberBg={theme().diff.lineNumber.background.removed}
                      />
                    </box>
                  )}
                </For>
              </scrollbox>
            </Show>
          }>
            {(current) => (
              <box flexDirection="column" flexGrow={1} minHeight={0}>
                <box flexDirection="row" gap={1} paddingLeft={1}>
                  <text fg={theme().hue.accent[200]}>{current().path}</text>
                  <Show when={isDirtyTab(current())}><text fg={theme().text.feedback.warning.default}>*</text></Show>
                </box>
                <line_number fg={theme().text.subdued} minWidth={3} paddingRight={1} flexGrow={1}>
                  <textarea
                    ref={(value) => { textareaRef = value }}
                    focused
                    initialValue={current().content}
                    syntaxStyle={syntaxStyle}
                    onCursorChange={(event) => {
                      const position = { line: event.line, column: event.visualColumn }
                      cursorByPath.set(current().path, position)
                      setCursor(position)
                    }}
                    onMouseDown={placeCursor}
                    onContentChange={() => {
                      const area = textareaRef
                      if (area) setTabs((state) => updateTab(state, current().path, area.editBuffer.getText()))
                      scheduleHighlight()
                    }}
                  />
                </line_number>
              </box>
            )}
          </Show>
        </box>
      </box>

      <Show when={!allChanges() && viewedTab()}>
        {(current) => (
          <box flexDirection="row" height={1} flexShrink={0} overflow="hidden" gap={1} paddingLeft={1} paddingRight={1}>
            <scrollbox flexGrow={1} minWidth={0} scrollX={true} scrollY={false} overflow="hidden"><text fg={theme().text.subdued}>
              {current().path}
              {dirty() ? " • unsaved" : ""}
              {" • Ln "}
              {cursor().line + 1}
              {", Col "}
              {cursor().column + 1}
              {" • "}
              {filetypeFor(current().path) ?? "text"}
              {parserStates().get(filetypeFor(current().path) ?? "") === "unavailable" ? " (plain text; parser unavailable)" : ""}
            </text></scrollbox>
          </box>
        )}
      </Show>

      <box height={1} flexShrink={0} overflow="hidden" paddingLeft={1}>
        <scrollbox flexGrow={1} minWidth={0} scrollX={true} scrollY={false} overflow="hidden"><text fg={theme().text.subdued}>
          tab focus · n/p file · ]/[ hunk · a all/one · v split/unified · t tree · d source · m reviewed · ? help · e edit · q close
        </text></scrollbox>
      </box>
    </box>
  )
}

export default Plugin.define({
  id: "opencode-rig.file-manager",
  setup(context) {
    parserReady = registerParsers(managedParserAssets()).then((registrations) => {
      availableParsers = parserAvailability(registrations)
      const missing = registrations.filter((entry) => !entry.registered)
      if (missing.length > 0) console.warn(`[file-manager] syntax fallback: ${missing.map((entry) => `${entry.filetype} (${entry.reason})`).join(", ")}`)
    })

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
              title: "Open Explorer",
              description: "Open the project file tree and editor panel.",
              group: "Files",
              bind: explorerBinding(context.options),
              palette: true,
              slash: EXPLORER_SLASH,
              run: () => {
                context.ui.panel.open(PANEL_NAME, { presentation: "fullscreen" })
              },
            },
          ],
        }))
        return null as never
      },
    })

    const stopSidebar = context.ui.slot({
      before: "sidebar.content",
      render: () => (
        <box
          flexDirection="row"
          focusable
          onMouseDown={() => {
            context.ui.panel.open(PANEL_NAME, { presentation: "fullscreen" })
          }}
          onKeyDown={(event) => {
            if (event.name === "return" || event.name === "space") {
              event.preventDefault()
              context.ui.panel.open(PANEL_NAME, { presentation: "fullscreen" })
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
