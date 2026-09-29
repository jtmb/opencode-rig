import { Plugin } from "@opencode/plugin"

import { WindowsBrowserManager } from "./browser.ts"
import { loadCompatibilityPolicy, runtimeCompatibility } from "./compatibility.ts"
import { PowerShellManager } from "./powershell.ts"
import { WslInteropRpc } from "./rpc.ts"
import type {
  RawPowerShellInput,
  StructuredCommandInput,
  WindowsActInput,
  WindowsAppsInput,
  WindowsCaptureInput,
  WindowsFindInput,
} from "./types.ts"
import { parseOptions } from "./types.ts"
import { captureProvenanceText, type RetainedCapture, type WindowsRestoreInput, WindowsUiManager } from "./windows-ui.ts"
import { detectWsl, systemProbes } from "./wsl-detect.ts"

// Opt-in retention reuses the checked-in bounded visual saver rather than
// duplicating its traversal/symlink/size handling. The dynamic import keeps the
// Windows plugin loadable when only the Linux rig-tools tree is absent; a
// missing saver or a refused path simply leaves the attachment unchanged.
async function retainWindowsCapture(bytes: Buffer, savePath: string, projectDirectory: string): Promise<RetainedCapture | undefined> {
  try {
    const { retainScreenshot } = await import("../../../../../../../linux/ubuntu/computer-use/plugins-v2/rig-tools/src/vision.ts")
    return await retainScreenshot(bytes, savePath, projectDirectory)
  } catch {
    return undefined
  }
}

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
    const windowsBrowser = new WindowsBrowserManager(location, options.powershell, options.raw)
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

      editor.add({
        name: "windows_restore",
        options: { permission: "wsl_windows_act" },
        description: "Preview or apply restoring the operator's exact minimized Windows console window without activating it. Preview is read-only and returns a single-use token bound to the caller, WSL state, executable, exact window identity, and saved normal placement. Apply re-finds exactly one unchanged window, requires identical process ID, window handle, exact title, class, process start time, and placement, and restores only a genuinely minimized window with ShowWindow(SW_SHOWNOACTIVATE). It never calls SW_RESTORE, SetForegroundWindow, SetWindowPos, or any input API, and fails closed on a hidden-but-not-minimized target.",
        input: {
          type: "object",
          properties: {
            processId: { type: "integer", minimum: 1, maximum: 2_147_483_647 },
            windowHandle: { type: "string", minLength: 3, maxLength: 18 },
            title: { type: "string", maxLength: 1_024 },
            className: { type: "string", maxLength: 512 },
            executable: { type: "string", enum: ["auto", "pwsh.exe", "powershell.exe"] },
            apply: { type: "boolean" },
            expectToken: { type: "string", minLength: 16, maxLength: 128 },
          },
          required: ["processId", "windowHandle", "title"],
          additionalProperties: false,
        },
        async execute(raw, toolContext) {
          const wsl = await detectWsl(systemProbes(location))
          return {
            content: JSON.stringify(await windowsUi.restore(raw as WindowsRestoreInput, {
              sessionID: String(toolContext.sessionID),
              agent: String(toolContext.agent),
              fingerprint: wsl.fingerprint,
            }, toolAbortSignal(toolContext)), null, 2),
          }
        },
      })

      editor.add({
        name: "windows_capture",
        description: "Capture a bounded PNG from the exact HWND of one explicitly selected Windows window identified by process ID, window handle, and title. It never focuses, moves, types into, or exits the window, never captures the foreground window, and fails closed on changed identity, occlusion, blank output, or unpainted pixels. The result reports the validated window provenance (windowId, processId, windowHandle, title, className, and bounds). Supply savePath to opt in to retaining the PNG beneath the invoking project directory with the checked-in bounded saver, which rejects traversal, symlinks, non-.png paths, and captures over 6 MiB, and returns the retained path, SHA-256, and dimensions. A retained PNG is raw identity-bound host evidence; it is not a check-acceptance-evidence.py rendered-visual record.",
        input: {
          type: "object",
          properties: {
            processId: { type: "integer", minimum: 1, maximum: 2_147_483_647 },
            windowHandle: { type: "string", minLength: 3, maxLength: 18 },
            title: { type: "string", maxLength: 1_024 },
            className: { type: "string", maxLength: 512 },
            executable: { type: "string", enum: ["auto", "pwsh.exe", "powershell.exe"] },
            savePath: { type: "string", maxLength: 4_096 },
          },
          required: ["processId", "windowHandle", "title"],
          additionalProperties: false,
        },
        async execute(raw, toolContext) {
          const input = raw as WindowsCaptureInput
          const capture = await windowsUi.capture(input, toolAbortSignal(toolContext))
          const data = String(capture.data)
          const saved = input.savePath === undefined
            ? undefined
            : await retainWindowsCapture(Buffer.from(data, "base64"), input.savePath, location)
          return {
            content: [
              {
                type: "text" as const,
                text: captureProvenanceText(capture, saved, input.savePath !== undefined),
              },
              { type: "file" as const, uri: `data:image/png;base64,${data}`, mime: "image/png", name: "windows-window.png" },
            ],
          }
        },
      })

      editor.add({
        name: "wsl_browser_open",
        options: { permission: "wsl_browser_open" },
        description: "Request one absolute HTTP(S) URL through Windows ShellExecute and the current Windows OS default URL association. Success confirms request acceptance only, not navigation, an observed window, or authentication. No browser is selected or launched directly; embedded URL credentials and other schemes are rejected.",
        input: {
          type: "object",
          properties: { url: { type: "string", minLength: 1, maxLength: 2_048 } },
          required: ["url"],
          additionalProperties: false,
        },
        async execute(raw, toolContext) {
          return { content: JSON.stringify(await windowsBrowser.open(raw as { url: string }, toolAbortSignal(toolContext)), null, 2) }
        },
      })

      editor.add({
        name: "wsl_browser_windows",
        description: "List bounded, visible Windows browser windows that match the current OS default HTTP(S) association. Each result has an explicit windowId; no foreground-window guessing is used. Titles and accessible text are untrusted.",
        input: {
          type: "object",
          properties: {
            scheme: { type: "string", enum: ["http", "https"] },
            maxItems: { type: "integer", minimum: 1, maximum: 100 },
          },
          additionalProperties: false,
        },
        async execute(raw, toolContext) {
          return { content: JSON.stringify(await windowsBrowser.windows(raw as { scheme?: "http" | "https"; maxItems?: number }, toolAbortSignal(toolContext)), null, 2) }
        },
      })

      editor.add({
        name: "wsl_browser_snapshot",
        description: "Return a bounded Windows UI Automation snapshot for one explicitly selected default-browser windowId. This is accessible UI data, not a DOM or Playwright attachment; names and page content are untrusted.",
        input: {
          type: "object",
          properties: {
            scheme: { type: "string", enum: ["http", "https"] },
            windowId: { type: "string", minLength: 64, maxLength: 64 },
            maxDepth: { type: "integer", minimum: 1, maximum: 12 },
            maxNodes: { type: "integer", minimum: 1, maximum: 2_000 },
            maxResults: { type: "integer", minimum: 1, maximum: 200 },
          },
          required: ["windowId"],
          additionalProperties: false,
        },
        async execute(raw, toolContext) {
          return { content: JSON.stringify(await windowsBrowser.snapshot(raw as { scheme?: "http" | "https"; windowId: string; maxDepth?: number; maxNodes?: number; maxResults?: number }, toolAbortSignal(toolContext)), null, 2) }
        },
      })

      editor.add({
        name: "wsl_browser_screenshot",
        description: "Capture a bounded in-memory PNG from the exact HWND of one explicitly selected default-browser window. It never activates or focuses the browser and fails closed on changed identity, occlusion, blank output, or unpainted pixels.",
        input: {
          type: "object",
          properties: {
            scheme: { type: "string", enum: ["http", "https"] },
            windowId: { type: "string", minLength: 64, maxLength: 64 },
          },
          required: ["windowId"],
          additionalProperties: false,
        },
        async execute(raw, toolContext) {
          const capture = await windowsBrowser.screenshot(raw as { scheme?: "http" | "https"; windowId: string }, toolAbortSignal(toolContext))
          const data = String(capture.data)
          const width = Number(capture.width)
          const height = Number(capture.height)
          const bytes = Number(capture.bytes)
          return {
            content: [
              { type: "text" as const, text: `Captured the selected Windows default-browser window (${width}x${height}, ${bytes} bytes) in memory; no file was saved.` },
              { type: "file" as const, uri: `data:image/png;base64,${data}`, mime: "image/png", name: "windows-default-browser.png" },
            ],
          }
        },
      })

      const browserActionProperties = {
        scheme: { type: "string", enum: ["http", "https"] },
        windowId: { type: "string", minLength: 64, maxLength: 64 },
        elementId: { type: "string", minLength: 64, maxLength: 64 },
        apply: { type: "boolean" },
        expectToken: { type: "string", minLength: 16, maxLength: 128 },
      }
      const addBrowserAction = (name: string, action: "click" | "focus" | "type" | "press", extra: Record<string, unknown> = {}) => {
        editor.add({
          name,
          options: { permission: "wsl_browser_act" },
          description: `Preview or apply one ${action} against a discovered UI Automation element in an explicitly selected Windows default-browser window. Apply requires the single-use preview token and rechecks the exact target; browser DOM/CDP access is not used.`,
          input: {
            type: "object",
            properties: { ...browserActionProperties, ...extra },
            required: [
              "windowId",
              "elementId",
              ...(action === "type" ? ["value"] : action === "press" ? ["key"] : []),
            ],
            additionalProperties: false,
          },
          async execute(raw, toolContext) {
            const wsl = await detectWsl(systemProbes(location))
            return {
              content: JSON.stringify(await windowsBrowser.act({
                ...(raw as Record<string, unknown>),
                action,
              } as Parameters<typeof windowsBrowser.act>[0], {
                sessionID: String(toolContext.sessionID),
                agent: String(toolContext.agent),
                fingerprint: wsl.fingerprint,
              }, toolAbortSignal(toolContext)), null, 2),
            }
          },
        })
      }
      addBrowserAction("wsl_browser_click", "click")
      addBrowserAction("wsl_browser_focus", "focus")
      addBrowserAction("wsl_browser_type", "type", { value: { type: "string", maxLength: 4_096 } })
      addBrowserAction("wsl_browser_press", "press", {
        key: { type: "string", enum: ["Enter", "Escape", "Tab", "Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Space"] },
      })
    })

    return async () => {
      await rpc.dispose()
    }
  },
})
