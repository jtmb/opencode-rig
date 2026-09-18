/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
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

const PANEL_NAME = "file-manager.files"
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
      context.renderer.suspend()
      await new Promise<void>((done) => {
        const child = spawn(command, [...editorArgs, absolute], { stdio: "inherit" })
        child.on("error", () => done())
        child.on("exit", () => done())
      })
    } finally {
      context.renderer.resume()
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
      props.panel.close()
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
                      onMouseDown={(event) => {
                        if (event.button !== 0) return
                        event.preventDefault()
                        setSelected(row.node.path)
                        if (row.node.type === "directory") void toggleDirectory(row.node)
                        else void openFile(row.node.path)
                      }}
                    >
                      <text fg={theme().text.subdued}>
                        {row.node.type === "directory" ? (row.expanded ? "- " : "+ ") : "  "}
                      </text>
                      <text fg={hovered() === row.node.path ? theme().hue.accent[200] : theme().text.default}>
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
                  onMouseDown={(event) => {
                    if (event.button !== 0) return
                    event.preventDefault()
                    setResultIndex(index())
                    void openFile(result)
                  }}
                >
                  <text fg={hovered() === result ? theme().hue.accent[200] : theme().text.default}>{result}</text>
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
          <Show when={tab()} fallback={<text fg={theme().text.subdued}> Select a file to view or edit</text>}>
            {(current) => (
              <box flexDirection="column" flexGrow={1} minHeight={0}>
                <box flexDirection="row" gap={1} paddingLeft={1}>
                  <text fg={theme().hue.accent[200]}>{current().path}</text>
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
                          content={current().content}
                          filetype={filetypeFor(current().path)}
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
        <text fg={theme().text.subdued}>
          up/down move · enter open · e edit · o external · / search · ctrl+s save · f fullscreen · esc back
        </text>
      </box>
    </box>
  )
}

export default Plugin.define({
  id: "opencode-rig.file-manager",
  setup(context) {
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
