/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"

import { loadCompatibilityPolicy, runtimeCompatibility } from "./compatibility.ts"
import { WslInteropRpc, type WslInteropOutput } from "./rpc.ts"
import { parseOptions } from "./types.ts"

function WslSidebar(props: { status: () => string }) {
  const context = usePlugin()
  return (
    <box flexDirection="column">
      <text fg={context.theme.text.default}><b>Open Rig WSL2</b></text>
      <text fg={context.theme.text.subdued}>{props.status()}</text>
    </box>
  )
}

export default Plugin.define({
  id: "opencode-rig.wsl2.interop.tui",
  async setup(context) {
    const options = parseOptions(context.options)
    if (!options.enabled) return () => undefined
    const compatibility = runtimeCompatibility(context.app.version, await loadCompatibilityPolicy())
    if (!compatibility.supported) {
      context.ui.toast.show({ title: "Open Rig WSL2", message: compatibility.reason, variant: "warning", duration: 8_000 })
      return () => undefined
    }
    const rpc = context.client.rpc(WslInteropRpc)
    const location = context.location ?? context.data.location.default()
    const rpcOptions = { location }
    const [status, setStatus] = createSignal("Checking WSL capabilities…")
    let stopped = false
    const refresh = async () => {
      try {
        const result = await rpc.status({}, rpcOptions) as WslInteropOutput
        const parsed = JSON.parse(result.text) as { wsl?: { isWsl?: boolean; version?: number; systemd?: { running?: boolean }; interop?: { registered?: boolean } }; powershell?: { available?: boolean; version?: string } }
        const wsl = parsed.wsl
        const summary = !wsl?.isWsl
          ? "Not running under WSL"
          : `WSL${wsl.version ?? "?"} · systemd ${wsl.systemd?.running ? "ready" : "blocked"} · interop ${wsl.interop?.registered ? "ready" : "blocked"} · PowerShell ${parsed.powershell?.available ? parsed.powershell.version ?? "ready" : "unavailable"}`
        if (!stopped) setStatus(summary)
      } catch {
        if (!stopped) setStatus("WSL server status unavailable")
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), options.refreshMs)
    const stopSidebar = context.ui.slot({
      after: "sidebar.content",
      render: () => <WslSidebar status={status} />,
    })
    const stopCommands = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [{
            id: "open-rig-wsl2.status",
            title: "WSL2 status",
            description: "Show bounded WSL2, interop, PowerShell, and web-search configuration status.",
            group: "Open Rig WSL2",
            palette: true,
            slash: { name: "wsl-status" },
            run: async () => {
              try {
                const result = await rpc.status({}, rpcOptions) as WslInteropOutput
                await context.ui.dialog.alert({ title: "Open Rig WSL2 status", message: result.text })
              } catch {
                await context.ui.dialog.alert({ title: "Open Rig WSL2 status", message: "The WSL server plugin is unavailable." })
              }
            },
          }],
        }))
        return null as never
      },
    })
    return () => {
      stopped = true
      clearInterval(timer)
      stopSidebar()
      stopCommands()
    }
  },
})
