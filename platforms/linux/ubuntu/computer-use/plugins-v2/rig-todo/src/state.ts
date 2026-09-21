import os from "node:os"
import path from "node:path"

import { normalizeTodos, type TodoItem } from "./store.ts"

/**
 * Server and CLI plugins both compute the mirror path from the shared launch
 * environment, so the rigid todo state written by the server can be read by
 * the sidebar panel without an RPC channel.
 */
export function todoDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  const base =
    env.XDG_DATA_HOME && env.XDG_DATA_HOME.trim().length > 0
      ? env.XDG_DATA_HOME
      : path.join(os.homedir(), ".local", "share")
  return path.join(base, "opencode", "rig-todo")
}

export function todoStatePath(sessionID: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(todoDataRoot(env), `${sessionID}.json`)
}

export function serializeTodoState(items: readonly TodoItem[]): string {
  return `${JSON.stringify({ items, updatedAt: new Date().toISOString() }, null, 2)}\n`
}

export function parseTodoState(text: string): TodoItem[] {
  try {
    const data = JSON.parse(text) as unknown
    if (Array.isArray(data)) return normalizeTodos(data)
    if (typeof data === "object" && data !== null && "items" in data) {
      return normalizeTodos((data as { items?: unknown }).items)
    }
  } catch {
    // A corrupt or partially written mirror shows an empty list, never throws.
  }
  return []
}
