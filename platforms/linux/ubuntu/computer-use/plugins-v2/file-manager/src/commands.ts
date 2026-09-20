export const EXPLORER_SLASH = {
  name: "explorer",
  aliases: ["editor", "files"],
}

export const DEFAULT_EXPLORER_BIND = "ctrl+alt+x"

export function explorerBinding(options: Readonly<Record<string, unknown>> | undefined): string {
  const bind = options?.bind
  return typeof bind === "string" && bind.trim() ? bind.trim() : DEFAULT_EXPLORER_BIND
}

export function explorerCommandNames(): string[] {
  return [EXPLORER_SLASH.name, ...EXPLORER_SLASH.aliases]
}
