import type { Context } from "@opencode/plugin/tui/context"

export const FILE_NAVIGATOR_ICON = ">"
export const SESSION_COPY_ICON = "#"

export function directoryBasename(directory: string | undefined): string | undefined {
  const normalized = directory?.trim().replace(/[\\/]+$/, "")
  if (!normalized || normalized === ".") return undefined
  const basename = normalized.split(/[\\/]/).at(-1)
  return basename && basename !== "." ? basename : undefined
}

export function activeSessionDirectory(context: Pick<Context, "data" | "location">, sessionID: string): string | undefined {
  const sessionDirectory = context.data.session.get(sessionID)?.location?.directory
  return sessionDirectory?.trim() || context.location?.directory?.trim() || undefined
}

export function activeSessionDirectoryBasename(
  context: Pick<Context, "data" | "location">,
  sessionID: string,
): string | undefined {
  return directoryBasename(activeSessionDirectory(context, sessionID))
}
