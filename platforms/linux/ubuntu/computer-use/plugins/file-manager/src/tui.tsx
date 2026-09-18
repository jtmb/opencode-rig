/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { SyntaxStyle, type TextareaRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
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
  isDirty,
  isProtectedPath,
  nextIndex,
  normalizeRelative,
  normalizeSearchResults,
  tooLargeToEdit,
  type FileNode,
} from "./model.ts"

const id = "local.file-manager"
const ROUTE = "files"
const SEARCH_DEBOUNCE_MS = 150
const TREE_WIDTH = 36

type Mode = "tree" | "view" | "edit" | "search"

type Tab = {
  path: string
  content: string
  original: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

function currentSessionID(api: TuiPluginApi): string | undefined {
  const route = api.route.current
  return route.name === "session" && "params" in route ? (route.params?.sessionID as string | undefined) : undefined
}

function openFiles(api: TuiPluginApi): void {
  api.route.navigate(ROUTE, { sessionID: currentSessionID(api) })
  api.ui.dialog.clear()
}

function createSyntaxStyle(api: TuiPluginApi): SyntaxStyle {
  const theme = api.theme.current
  return SyntaxStyle.fromStyles({
    default: { fg: theme.text },
    comment: { fg: theme.syntaxComment, italic: true },
    keyword: { fg: theme.syntaxKeyword },
    string: { fg: theme.syntaxString },
    number: { fg: theme.syntaxNumber },
    boolean: { fg: theme.syntaxNumber },
    constant: { fg: theme.syntaxNumber },
    function: { fg: theme.syntaxFunction },
    variable: { fg: theme.syntaxVariable },
    type: { fg: theme.syntaxType },
    operator: { fg: theme.syntaxOperator },
    punctuation: { fg: theme.syntaxPunctuation },
    property: { fg: theme.text },
  })
}

function ExplorerRow(props: { api: TuiPluginApi }) {
  const open = () => openFiles(props.api)
  return (
    <box
      flexDirection="row"
      focusable
      onMouseDown={open}
      onKeyDown={(event) => {
        if (event.name === "return" || event.name === "space") {
          event.preventDefault()
          open()
        }
      }}
    >
      <text fg={props.api.theme.current.accent}>
        <b>Explorer</b>
      </text>
    </box>
  )
}

function FilesView(props: { api: TuiPluginApi; sessionID?: string }) {
  const api = props.api
  const directory = api.state.session.get(props.sessionID ?? "")?.directory ?? api.state.path.directory
  const root = api.state.path.worktree || directory
  const syntaxStyle = createSyntaxStyle(api)

  const [children, setChildren] = createSignal<Map<string, FileNode[]>>(new Map())
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set())
  const [selected, setSelected] = createSignal("")
  const [tab, setTab] = createSignal<Tab>()
  const [mode, setMode] = createSignal<Mode>("tree")
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
  const dirty = createMemo(() => {
    const current = tab()
    return current ? isDirty(current.original, current.content) : false
  })

  const loadDirectory = async (relative: string) => {
    try {
      const response = (await api.client.file.list({ directory, path: relative })) as unknown as {
        data?: FileNode[]
        error?: unknown
      }
      if (response.error !== undefined || !response.data) {
        setStatus(`Cannot list ${relative || "."}`)
        return
      }
      const nodes: FileNode[] = response.data.map((entry) => ({
        name: entry.name,
        path: normalizeRelative(entry.path),
        absolute: entry.absolute,
        type: entry.type,
        ignored: entry.ignored,
      }))
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

  const openFile = async (relative: string) => {
    if (isProtectedPath(relative)) {
      setStatus("Refusing to open .git contents")
      return
    }
    const absolute = resolve(root, relative)
    if (!isContained(root, absolute)) {
      setStatus("Refusing to open a path outside the project")
      return
    }
    try {
      const real = await realpath(absolute)
      if (!isContained(root, real)) {
        setStatus("Refusing to follow a symlink outside the project")
        return
      }
      const info = await stat(real)
      if (tooLargeToEdit(info.size)) {
        setStatus(`${relative} is too large to open (limit ${Math.round(MAX_EDIT_BYTES / 1024)} KiB)`)
        return
      }
      const bytes = await readFile(real)
      if (isBinaryContent(bytes)) {
        setStatus(`${relative} is binary and cannot be edited`)
        return
      }
      const content = bytes.toString("utf8")
      setTab({ path: relative, content, original: content })
      setMode("view")
      setEscapeArmed(false)
      setStatus("")
    } catch (error) {
      setStatus(`Cannot read ${relative}: ${errorMessage(error)}`)
    }
  }

  const save = async () => {
    const current = tab()
    if (!current) return
    if (isProtectedPath(current.path)) {
      setStatus("Refusing to save .git contents")
      return
    }
    const absolute = resolve(root, current.path)
    if (!isContained(root, absolute)) {
      setStatus("Refusing to save outside the project")
      return
    }
    let temporary: string | undefined
    try {
      const real = await realpath(absolute)
      if (!isContained(root, real)) {
        setStatus("Refusing to follow a symlink outside the project")
        return
      }
      temporary = join(dirname(real), `.${basename(real)}.${process.pid}.tmp`)
      await writeFile(temporary, current.content, "utf8")
      await rename(temporary, real)
      temporary = undefined
      setTab({ ...current, original: current.content })
      setMode("view")
      setStatus(`Saved ${current.path}`)
    } catch (error) {
      setStatus(`Save failed: ${errorMessage(error)}`)
    } finally {
      if (temporary) await unlink(temporary).catch(() => undefined)
    }
  }

  const openExternal = async () => {
    const current = tab()
    if (!current) return
    const editor = (process.env.VISUAL || process.env.EDITOR || "").trim()
    if (!editor) {
      setStatus("Set $EDITOR or $VISUAL to open an external editor")
      return
    }
    const [command, ...editorArgs] = editor.split(/\s+/)
    const absolute = resolve(root, current.path)
    try {
      api.renderer.suspend()
      await new Promise<void>((done) => {
        const child = spawn(command, [...editorArgs, absolute], { stdio: "inherit" })
        child.on("error", () => done())
        child.on("exit", () => done())
      })
    } finally {
      api.renderer.resume()
    }
    await openFile(current.path)
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

  const editSelected = async () => {
    await openSelected()
    if (tab()) setMode("edit")
  }

  const externalSelected = async () => {
    await openSelected()
    if (tab()) await openExternal()
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
    const current = tab()
    if (current) {
      if (dirty()) setStatus("File changed on disk; save or reopen to refresh")
      else await openFile(current.path)
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
        const response = (await api.client.find.files({
          directory,
          query,
          type: "file",
          limit: SEARCH_LIMIT,
        })) as unknown as { data?: string[]; error?: unknown }
        if (response.error !== undefined || !response.data) {
          setResults([])
          return
        }
        setResults(normalizeSearchResults(response.data, SEARCH_LIMIT))
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
    const name = key.name
    if (key.ctrl && name === "s") {
      if (mode() === "edit") {
        key.preventDefault()
        key.stopPropagation()
        void save()
      }
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
        const current = tab()
        if (current) setTab({ ...current, content: current.original })
        setEscapeArmed(false)
        setMode("view")
        setStatus("")
      }
      return
    }

    if (name === "escape") {
      key.preventDefault()
      key.stopPropagation()
      if (tab()) {
        setTab(undefined)
        setMode("tree")
        setStatus("")
        return
      }
      api.route.navigate("home")
      return
    }

    if (mode() === "view") {
      if (name === "e" || name === "i") {
        key.preventDefault()
        key.stopPropagation()
        setMode("edit")
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
    if (name === "r") {
      key.preventDefault()
      key.stopPropagation()
      void refresh()
    }
  })

  const stopWatcher = api.event.on("file.watcher.updated", (event) => {
    const changed = normalizeRelative(event.properties.file)
    const current = tab()
    if (current && (changed === current.path || current.path.endsWith(`/${changed}`) || changed.endsWith(`/${current.path}`))) {
      if (dirty()) setStatus("File changed on disk; save or reopen to refresh")
      else void openFile(current.path)
    }
    void Promise.all([...children().keys()].map((key) => loadDirectory(key)))
  })

  onMount(() => {
    void (async () => {
      await loadDirectory("")
      const first = rows()[0]
      if (first) setSelected(first.node.path)
    })()
  })

  onCleanup(() => {
    stopWatcher()
    if (searchTimer) clearTimeout(searchTimer)
    syntaxStyle.destroy()
  })

  return (
    <box
      position="absolute"
      zIndex={2500}
      left={0}
      top={0}
      width="100%"
      height="100%"
      flexDirection="column"
      backgroundColor={api.theme.current.background}
    >
      <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1}>
        <text fg={api.theme.current.accent}>
          <b>Files</b>
        </text>
        <text fg={api.theme.current.textMuted}>{directory}</text>
        <box flexGrow={1} />
        <text fg={api.theme.current.textMuted}>{status()}</text>
      </box>

      <box flexDirection="row" flexGrow={1} minHeight={0}>
        <box
          flexDirection="column"
          width={TREE_WIDTH}
          flexShrink={0}
          borderStyle="single"
          borderColor={api.theme.current.border}
        >
          <Show
            when={mode() === "search"}
            fallback={
              <Show
                when={rows().length > 0}
                fallback={<text fg={api.theme.current.textMuted}> Loading...</text>}
              >
                <For each={rows()}>
                  {(row) => (
                    <box
                      flexDirection="row"
                      backgroundColor={selected() === row.node.path ? api.theme.current.backgroundElement : undefined}
                      paddingLeft={row.depth * 2 + 1}
                    >
                      <text fg={api.theme.current.textMuted}>
                        {row.node.type === "directory" ? (row.expanded ? "- " : "+ ") : "  "}
                      </text>
                      <text fg={api.theme.current.text}>{row.node.name}</text>
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
                  backgroundColor={index() === resultIndex() ? api.theme.current.backgroundElement : undefined}
                  paddingLeft={1}
                >
                  <text fg={api.theme.current.text}>{result}</text>
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
          borderColor={api.theme.current.border}
        >
          <Show when={tab()} fallback={<text fg={api.theme.current.textMuted}> Select a file to view or edit</text>}>
            {(current) => (
              <box flexDirection="column" flexGrow={1} minHeight={0}>
                <box flexDirection="row" gap={1} paddingLeft={1}>
                  <text fg={api.theme.current.accent}>{current().path}</text>
                  <Show when={dirty()}>
                    <text fg={api.theme.current.warning}>*</text>
                  </Show>
                </box>
                <Show
                  when={mode() === "edit"}
                  fallback={
                    <scrollbox flexGrow={1} minHeight={0}>
                      <line_number fg={api.theme.current.textMuted} minWidth={3} paddingRight={1}>
                        <code
                          content={current().content}
                          filetype={filetypeFor(current().path)}
                          syntaxStyle={syntaxStyle}
                          conceal={false}
                          fg={api.theme.current.text}
                        />
                      </line_number>
                    </scrollbox>
                  }
                >
                  <line_number fg={api.theme.current.textMuted} minWidth={3} paddingRight={1} flexGrow={1}>
                    <textarea
                      ref={(value) => {
                        textareaRef = value
                      }}
                      focused
                      initialValue={current().content}
                      syntaxStyle={syntaxStyle}
                      onContentChange={() => {
                        const active = tab()
                        if (active && textareaRef) setTab({ ...active, content: textareaRef.editBuffer.getText() })
                      }}
                    />
                  </line_number>
                </Show>
              </box>
            )}
          </Show>
        </box>
      </box>

      <box paddingLeft={1}>
        <text fg={api.theme.current.textMuted}>
          up/down move · enter open · e edit · o external · / search · ctrl+s save · esc back
        </text>
      </box>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.route.register([{ name: ROUTE, render: (input) => <FilesView api={api} sessionID={input.params?.sessionID as string | undefined} /> }])

  api.keymap.registerLayer({
    commands: [
      {
        name: "files.open",
        title: "Open file manager",
        category: "Files",
        namespace: "palette",
        slashName: "files",
        slashAliases: ["explorer"],
        run() {
          openFiles(api)
        },
      },
    ],
    bindings: [{ key: "ctrl+shift+e", cmd: "files.open", desc: "Open file manager" }],
  })

  api.slots.register({
    order: 60,
    slots: {
      sidebar_content() {
        return <ExplorerRow api={api} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = { id, tui }
export default plugin
