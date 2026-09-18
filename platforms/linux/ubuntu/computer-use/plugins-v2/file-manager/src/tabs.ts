import { normalizeSafeRelative } from "./safety.ts"

export interface FileTab {
  path: string
  content: string
  original: string
  diskFingerprint?: string
  mode?: number
  revision?: number
}

export interface TabsState {
  open: FileTab[]
  active: string
  closed: string[]
}

export const EMPTY_TABS: TabsState = { open: [], active: "", closed: [] }

const MAX_CLOSED = 20

export function isDirtyTab(tab: FileTab): boolean {
  return tab.content !== tab.original
}

export function dirtyTabs(state: TabsState): FileTab[] {
  return state.open.filter(isDirtyTab)
}

export type DirtyGuard = {
  path: string
  revision: number
}

export function tabRevision(tab: FileTab): number {
  return tab.revision ?? 0
}

export function dirtyGuard(tab: FileTab): DirtyGuard {
  return { path: tab.path, revision: tabRevision(tab) }
}

export function dirtyGuards(state: TabsState): DirtyGuard[] {
  return dirtyTabs(state).map(dirtyGuard)
}

export function sameDirtyGuard(left: DirtyGuard | undefined, right: DirtyGuard | undefined): boolean {
  return !!left && !!right && left.path === right.path && left.revision === right.revision
}

export function dirtyGuardKey(guards: readonly DirtyGuard[]): string {
  return guards.map((guard) => `${guard.path}:${guard.revision}`).sort().join("|")
}

export type TabSaveSnapshot = {
  path: string
  content: string
  diskFingerprint: string
  mode: number
  revision: number
}

export function saveSnapshot(tab: FileTab): TabSaveSnapshot | undefined {
  if (tab.diskFingerprint === undefined || tab.mode === undefined) return undefined
  return {
    path: tab.path,
    content: tab.content,
    diskFingerprint: tab.diskFingerprint,
    mode: tab.mode,
    revision: tabRevision(tab),
  }
}

/** Open a file or activate it when already open (unsaved content wins). */
export function openTab(state: TabsState, tab: FileTab): TabsState {
  if (state.open.some((entry) => entry.path === tab.path)) {
    return { ...state, active: tab.path }
  }
  return { open: [...state.open, tab], active: tab.path, closed: state.closed }
}

/** Replace a loaded tab from disk while keeping its active/closed state. */
export function replaceTab(state: TabsState, tab: FileTab): TabsState {
  if (!state.open.some((entry) => entry.path === tab.path)) return openTab(state, tab)
  return {
    ...state,
    active: tab.path,
    open: state.open.map((entry) => (entry.path === tab.path ? tab : entry)),
  }
}

export function activateTab(state: TabsState, path: string): TabsState {
  return state.open.some((entry) => entry.path === path) ? { ...state, active: path } : state
}

export function updateTab(state: TabsState, path: string, content: string): TabsState {
  if (!state.open.some((entry) => entry.path === path)) return state
  return {
    ...state,
    open: state.open.map((entry) =>
      entry.path === path && entry.content !== content
        ? { ...entry, content, revision: tabRevision(entry) + 1 }
        : entry,
    ),
  }
}

/** Mark a tab's current content as the saved baseline. */
export function markSaved(state: TabsState, path: string): TabsState {
  return {
    ...state,
    open: state.open.map((entry) => (entry.path === path ? { ...entry, original: entry.content } : entry)),
  }
}

/** Mark only the exact snapshot as saved; newer edits remain dirty. */
export function markSavedSnapshot(
  state: TabsState,
  snapshot: TabSaveSnapshot,
  diskFingerprint: string,
  mode: number,
): TabsState {
  return {
    ...state,
    open: state.open.map((entry) => {
      if (entry.path !== snapshot.path) return entry
      const updated = { ...entry, diskFingerprint, mode }
      if (tabRevision(entry) !== snapshot.revision || entry.content !== snapshot.content) return updated
      return { ...updated, original: snapshot.content }
    }),
  }
}

export function closeTab(state: TabsState, path: string): TabsState {
  const index = state.open.findIndex((entry) => entry.path === path)
  if (index < 0) return state
  const open = state.open.filter((entry) => entry.path !== path)
  const active = state.active !== path ? state.active : (open[Math.min(index, open.length - 1)]?.path ?? "")
  const closed = [path, ...state.closed.filter((entry) => entry !== path)].slice(0, MAX_CLOSED)
  return { open, active, closed }
}

/** Pop the most recent closed path (or a specific one) so it can be reopened. */
export function takeClosed(state: TabsState, path?: string): { state: TabsState; path?: string } {
  const target = path ?? state.closed[0]
  if (!target) return { state }
  return { state: { ...state, closed: state.closed.filter((entry) => entry !== target) }, path: target }
}

export function nextTab(state: TabsState, delta: number): TabsState {
  if (state.open.length < 2) return state
  const index = state.open.findIndex((entry) => entry.path === state.active)
  const base = index < 0 ? 0 : index
  const count = state.open.length
  const next = (((base + delta) % count) + count) % count
  return { ...state, active: state.open[next].path }
}

export interface PersistedTabs {
  open: string[]
  active: string
}

export function persistTabs(state: TabsState): PersistedTabs {
  return { open: state.open.map((entry) => entry.path), active: state.active }
}

/** Rebuild an empty tab list from persisted paths; content loads lazily. */
export function restorePaths(saved: unknown): string[] {
  if (typeof saved !== "object" || saved === null) return []
  const open = (saved as { open?: unknown }).open
  if (!Array.isArray(open)) return []
  const seen = new Set<string>()
  const paths: string[] = []
  for (const entry of open) {
    if (typeof entry !== "string" || entry.length === 0) continue
    let normalized: string
    try {
      normalized = normalizeSafeRelative(entry)
    } catch {
      continue
    }
    if (seen.has(normalized)) continue
    seen.add(normalized)
    paths.push(normalized)
  }
  return paths
}

export function restoredActive(saved: unknown, paths: readonly string[]): string {
  const active = typeof saved === "object" && saved !== null ? (saved as { active?: unknown }).active : undefined
  if (typeof active === "string" && paths.includes(active)) return active
  return paths[0] ?? ""
}
