export const EXPLORER_SLASH = {
  name: "explorer",
  aliases: ["editor", "files"],
}

export function explorerCommandNames(): string[] {
  return [EXPLORER_SLASH.name, ...EXPLORER_SLASH.aliases]
}
