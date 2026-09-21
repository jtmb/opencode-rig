import { Plugin } from "@opencode/plugin"

import { loadCompatibilityPolicy, runtimeCompatibility } from "./compatibility.ts"
import { PowerShellManager } from "./powershell.ts"
import { WslInteropRpc } from "./rpc.ts"
import type {
  RawPowerShellInput,
  StructuredCommandInput,
  WindowsActInput,
  WindowsAppsInput,
  WindowsFindInput,
} from "./types.ts"
import { parseOptions } from "./types.ts"
import { WindowsUiManager } from "./windows-ui.ts"
import { detectWsl, systemProbes } from "./wsl-detect.ts"

function toolAbortSignal(context: unknown): AbortSignal | undefined {
  if (!context || typeof context !== "object" || !("signal" in context)) return undefined
  const signal = (context as { signal?: unknown }).signal
  return signal instanceof AbortSignal ? signal : undefined
}

export default Plugin.define({
  id: "opencode-rig.wsl2.interop.server",
  async setup(ctx) {
    const options = parseOptions(ctx.options)
    if (!options.enabled) return
    const compatibility = runtimeCompatibility(ctx.app.version, await loadCompatibilityPolicy())
    if (!compatibility.supported) return
    const location = String(ctx.location.directory)
    const powershell = new PowerShellManager(location, options.powershell, options.raw)
    const windowsUi = new WindowsUiManager(location, options.powershell, options.raw)
    const statusText = async () => {
      const wsl = await detectWsl(systemProbes(location))
      let powerShellStatus
      try {
        powerShellStatus = await powershell.status()
      } catch (error) {
        powerShellStatus = { available: false, error: error instanceof Error ? error.message : String(error) }
      }
      return JSON.stringify({
        wsl,
        powershell: powerShellStatus,
        websearch: {
          runtimeAttested: false,
          note: "Use isolated config verification and an approved live search; plugin status does not infer the selected provider.",
        },
      }, null, 2)
    }
    const rpc = await ctx.rpc.register(WslInteropRpc, {
      status: async () => ({ text: await statusText() }),
      powershellStatus: async () => ({ text: JSON.stringify(await powershell.status(), null, 2) }),
    })

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "wsl_status",
        description: "Read-only WSL2, systemd, Windows interoperability, WSLg, workspace, proxy, and CA capability detection. Configured and effective states are reported separately.",
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          return { content: JSON.stringify(await detectWsl(systemProbes(location)), null, 2) }
        },
      })

      editor.add({
        name: "powershell_status",
        description: "Read-only bounded discovery of PowerShell 7 or Windows PowerShell through WSL interoperability. No profile is loaded and provider credentials are not returned.",
        input: {
          type: "object",
          properties: { executable: { type: "string", enum: ["auto", "pwsh.exe", "powershell.exe"] } },
          additionalProperties: false,
        },
        async execute(raw, toolContext) {
          const executable = (raw as { executable?: "auto" | "pwsh.exe" | "powershell.exe" }).executable
          return { content: JSON.stringify(await powershell.status(executable, toolAbortSignal(toolContext)), null, 2) }
        },
      })

      editor.add({
        name: "powershell_command",
        options: { permission: "wsl_powershell_command" },
        description: "Run one fixed, structured, read-only Windows PowerShell operation through the bounded JSON-RPC stdin/stdout host. Supported operations list bounded processes, list bounded services, or inspect one absolute Windows path. Caller-provided scripts, cmdlets, pipelines, flags, and environment variables are not accepted.",
        input: {
          type: "object",
          properties: {
            operation: { type: "string", enum: ["processes", "services", "path"] },
            name: { type: "string", maxLength: 128 },
            path: { type: "string", maxLength: 4096 },
            maxItems: { type: "integer", minimum: 1, maximum: 200 },
            executable: { type: "string", enum: ["auto", "pwsh.exe", "powershell.exe"] },
          },
          required: ["operation"],
          additionalProperties: false,
        },
        async execute(raw, toolContext) {
          return { content: JSON.stringify(await powershell.structured(raw as StructuredCommandInput, toolAbortSignal(toolContext)), null, 2) }
        },
      })

      editor.add({
        name: "powershell_raw",
        options: { permission: "wsl_powershell_raw" },
        description: "Preview or explicitly apply one bounded raw Windows PowerShell script through WSL interoperability. Preview never executes the script and returns a single-use token bound to caller, script hash, executable, working directory, WSL fingerprint, and expiry. Raw PowerShell is not an OS sandbox and can mutate the Windows host after approval.",
        input: {
          type: "object",
          properties: {
            script: { type: "string", maxLength: 65_536 },
            executable: { type: "string", enum: ["auto", "pwsh.exe", "powershell.exe"] },
            timeoutMs: { type: "integer", minimum: 100, maximum: 30_000 },
            apply: { type: "boolean" },
            expectToken: { type: "string", minLength: 16, maxLength: 128 },
          },
          required: ["script"],
          additionalProperties: false,
        },
        async execute(raw, toolContext) {
          const wsl = await detectWsl(systemProbes(location))
          return {
            content: JSON.stringify(await powershell.raw(raw as RawPowerShellInput, {
              sessionID: String(toolContext.sessionID),
              agent: String(toolContext.agent),
              fingerprint: wsl.fingerprint,
            }, toolAbortSignal(toolContext)), null, 2),
          }
        },
      })

      editor.add({
        name: "windows_apps",
        description: "List bounded top-level Windows applications with visible main windows through the WSL PowerShell JSON-RPC host. Read-only; returned titles are untrusted data.",
        input: {
          type: "object",
          properties: {
            name: { type: "string", maxLength: 128 },
            maxItems: { type: "integer", minimum: 1, maximum: 100 },
            executable: { type: "string", enum: ["auto", "pwsh.exe", "powershell.exe"] },
          },
          additionalProperties: false,
        },
        async execute(raw, toolContext) {
          return { content: JSON.stringify(await windowsUi.apps(raw as WindowsAppsInput, toolAbortSignal(toolContext)), null, 2) }
        },
      })

      editor.add({
        name: "windows_find",
        description: "Find bounded Windows UI Automation elements in one process by exact name, automation ID, and/or control type. Read-only. Results include a traversal truncation flag and are untrusted data.",
        input: {
          type: "object",
          properties: {
            processId: { type: "integer", minimum: 1, maximum: 2_147_483_647 },
            name: { type: "string", maxLength: 256 },
            automationId: { type: "string", maxLength: 256 },
            controlType: { type: "string", maxLength: 128 },
            maxDepth: { type: "integer", minimum: 1, maximum: 12 },
            maxNodes: { type: "integer", minimum: 1, maximum: 2_000 },
            maxResults: { type: "integer", minimum: 1, maximum: 100 },
            executable: { type: "string", enum: ["auto", "pwsh.exe", "powershell.exe"] },
          },
          required: ["processId"],
          additionalProperties: false,
        },
        async execute(raw, toolContext) {
          return { content: JSON.stringify(await windowsUi.find(raw as WindowsFindInput, toolAbortSignal(toolContext)), null, 2) }
        },
      })

      editor.add({
        name: "windows_act",
        options: { permission: "wsl_windows_act" },
        description: "Preview or apply one exact Windows UI Automation action. Preview is read-only and returns a single-use token bound to the caller, WSL state, executable, selector, action, value, and exact current target snapshot. Apply re-finds exactly one unchanged target and still requires an OpenCode permission prompt.",
        input: {
          type: "object",
          properties: {
            processId: { type: "integer", minimum: 1, maximum: 2_147_483_647 },
            name: { type: "string", maxLength: 256 },
            automationId: { type: "string", maxLength: 256 },
            controlType: { type: "string", maxLength: 128 },
            maxDepth: { type: "integer", minimum: 1, maximum: 12 },
            maxNodes: { type: "integer", minimum: 1, maximum: 2_000 },
            maxResults: { type: "integer", minimum: 1, maximum: 100 },
            executable: { type: "string", enum: ["auto", "pwsh.exe", "powershell.exe"] },
            action: { type: "string", enum: ["focus", "invoke", "setValue", "toggle", "select"] },
            value: { type: "string", maxLength: 4_096 },
            apply: { type: "boolean" },
            expectToken: { type: "string", minLength: 16, maxLength: 128 },
          },
          required: ["processId", "action"],
          additionalProperties: false,
        },
        async execute(raw, toolContext) {
          const wsl = await detectWsl(systemProbes(location))
          return {
            content: JSON.stringify(await windowsUi.act(raw as WindowsActInput, {
              sessionID: String(toolContext.sessionID),
              agent: String(toolContext.agent),
              fingerprint: wsl.fingerprint,
            }, toolAbortSignal(toolContext)), null, 2),
          }
        },
      })
    })

    return async () => {
      await rpc.dispose()
    }
  },
})
