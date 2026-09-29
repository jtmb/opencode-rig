import { PowerShellManager } from "./src/powershell.ts"
import type { PowerShellOptions, RawOptions } from "./src/types.ts"
import { WindowsUiManager } from "./src/windows-ui.ts"
import { detectWsl, systemProbes } from "./src/wsl-detect.ts"

const powershellOptions: PowerShellOptions = {
  preferred: "auto",
  timeoutMs: 10_000,
  maxOutputBytes: 262_144,
}
const rawOptions: RawOptions = {
  enabled: true,
  tokenTtlMs: 60_000,
  maxScriptBytes: 65_536,
  maxTokens: 128,
}

async function main(): Promise<void> {
  const cwd = process.cwd()
  const wsl = await detectWsl(systemProbes(cwd))
  if (!wsl.isWsl || wsl.version !== 2) throw new Error("live plugin probe requires WSL2")
  if (!wsl.systemd.running) throw new Error(`systemd is not running: ${wsl.systemd.state}`)
  if (!wsl.interop.registered) throw new Error("WSL interoperability is not registered")

  const powershell = new PowerShellManager(cwd, powershellOptions, rawOptions)
  const status = await powershell.status()
  if (!status.available || !status.executable) throw new Error(status.error ?? "PowerShell is unavailable")
  const processes = await powershell.structured({ operation: "processes", maxItems: 1, executable: status.executable })
  const preview = await powershell.raw(
    { script: "Get-Date", executable: status.executable },
    { sessionID: "live-source-probe", agent: "verification", fingerprint: wsl.fingerprint },
  )
  const windows = new WindowsUiManager(cwd, powershellOptions, rawOptions)
  const apps = await windows.apps({ maxItems: 5, executable: status.executable })
  const appItems = Array.isArray(apps.items) ? apps.items as Array<{ processId?: unknown }> : []
  let elements: Record<string, unknown> | undefined
  let uiPreview: Record<string, unknown> | undefined
  for (const app of appItems) {
    if (!Number.isInteger(app.processId)) continue
    const candidate = await windows.find({
      processId: Number(app.processId),
      controlType: "Window",
      maxDepth: 12,
      maxNodes: 2_000,
      maxResults: 100,
      executable: status.executable,
    })
    if (Array.isArray(candidate.items) && candidate.items.length > 0) {
      elements = candidate
      if (candidate.truncated === false && candidate.items.length === 1) {
        const target = candidate.items[0] as { processId?: unknown; name?: unknown; controlType?: unknown }
        if (Number.isInteger(target.processId) && typeof target.name === "string" && typeof target.controlType === "string") {
          uiPreview = await windows.act({
            processId: Number(target.processId),
            name: target.name,
            controlType: target.controlType,
            action: "focus",
            maxDepth: 12,
            maxNodes: 2_000,
            maxResults: 100,
            executable: status.executable,
          }, { sessionID: "live-source-probe", agent: "verification", fingerprint: wsl.fingerprint })
          break
        }
      }
    }
  }
  if (!elements) throw new Error("no visible Windows application exposed a UI Automation Window element")
  console.log(JSON.stringify({
    wsl,
    powershell: status,
    processes,
    rawPreview: preview,
    windowsApps: apps,
    windowsElements: elements,
    windowsActionPreview: uiPreview ?? {
      skipped: true,
      reason: "No bounded application traversal produced one unique, explicitly non-truncated target.",
    },
  }, null, 2))
}

await main()
