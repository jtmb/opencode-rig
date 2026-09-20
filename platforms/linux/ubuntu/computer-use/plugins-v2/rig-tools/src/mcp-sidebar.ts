import type { McpServer } from "@opencode/client"

export function mcpStatusText(server: Pick<McpServer, "status">): string {
  switch (server.status.status) {
    case "connected": return "Connected"
    case "pending": return "Connecting"
    case "disabled": return "Disabled"
    case "failed": return server.status.error
    case "needs_auth": return "Needs auth"
  }
}

export function mcpStatusCounts(servers: readonly Pick<McpServer, "status">[]): { active: number; errors: number } {
  return {
    active: servers.filter((server) => server.status.status === "connected").length,
    errors: servers.filter((server) => server.status.status === "failed" || server.status.status === "needs_auth").length,
  }
}
