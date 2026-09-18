/** @jsxImportSource @opentui/solid */
import type {
  TuiDialogSelectOption,
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui"

import {
  DEFAULT_GEAR_ORDER,
  DISPLAY_SETTINGS,
  KEYS,
  SECTIONS,
  SIDEBAR_ANCHORS,
  SIDEBAR_AUTO_MIN_WIDTH,
  SIDEBAR_PANELS,
  SOURCE_CONTROL_PRESETS,
  anchorForOrder,
  clampSidebarOrder,
  dialogSizeFor,
  displayLabel,
  formatInterval,
  readDisplaySetting,
  readSidebarPanelOrder,
  readSidebarVisibility,
  readSourceControlNumber,
  readSourceControlStartCollapsed,
  sidebarVisibilityLabel,
  toggleDisplaySetting,
  toggleSourceControlStartCollapsed,
  writeSidebarPanelAnchor,
  writeSidebarVisibility,
  writeSourceControlNumber,
  type SettingsSectionId,
  type SidebarAnchorId,
  type SidebarPanelId,
} from "./settings.ts"

const id = "local.tui-settings"

type PluginOptions = {
  order?: number
}

function pluginOptions(value: unknown): PluginOptions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  const options = value as Record<string, unknown>
  return typeof options.order === "number" && Number.isFinite(options.order) ? { order: options.order } : {}
}

function openSelect(
  api: TuiPluginApi,
  title: string,
  options: TuiDialogSelectOption<string>[],
  onSelect: (value: string) => void,
  current?: string,
): void {
  try {
    api.ui.dialog.setSize(dialogSizeFor(api.renderer.width))
    api.ui.dialog.replace(() =>
      api.ui.DialogSelect({
        title,
        options,
        current,
        onSelect: (option) => onSelect(option.value),
      }),
    )
  } catch {
    api.ui.toast({ variant: "warning", title: "Settings", message: "Unable to open the settings dialog." })
  }
}

function sectionFooter(api: TuiPluginApi, section: SettingsSectionId): string {
  if (section === "appearance") return `${api.theme.selected} - ${api.theme.mode()}`
  if (section === "sidebar") return `visibility ${readSidebarVisibility(api.kv)}`
  if (section === "source-control") {
    return readSourceControlStartCollapsed(api.kv) ? "starts minimized" : "starts expanded"
  }
  if (section === "plugins") return `${api.plugins.list().length} loaded`
  return ""
}

function showSections(api: TuiPluginApi): void {
  const options: TuiDialogSelectOption<string>[] = SECTIONS.map((section) => ({
    title: section.title,
    value: section.id,
    description: section.description,
    footer: sectionFooter(api, section.id),
  }))
  options.push({ title: "Close", value: "close", description: "Close settings" })
  openSelect(api, "Settings", options, (value) => {
    if (value === "close") {
      api.ui.dialog.clear()
      return
    }
    showSection(api, value as SettingsSectionId)
  })
}

function showSection(api: TuiPluginApi, section: SettingsSectionId): void {
  if (section === "appearance") return showAppearance(api)
  if (section === "display") return showDisplay(api)
  if (section === "plugins") return showPlugins(api)
  if (section === "source-control") return showSourceControl(api)
  if (section === "sidebar") return showSidebar(api)
  if (section === "about") return showAbout(api)
  showSections(api)
}

function dispatch(api: TuiPluginApi, command: string, label: string): void {
  try {
    const result = api.keymap.dispatchCommand(command)
    if (!result.ok) {
      api.ui.toast({ variant: "warning", title: "Settings", message: `${label} is unavailable.` })
      return
    }
    api.ui.dialog.clear()
  } catch {
    api.ui.toast({ variant: "warning", title: "Settings", message: `${label} is unavailable.` })
  }
}

function showAppearance(api: TuiPluginApi): void {
  const options: TuiDialogSelectOption<string>[] = [
    { title: "Theme", value: "theme", description: "Open the built-in theme picker", footer: api.theme.selected },
    { title: "Dark / light mode", value: "mode", description: "Switch the active color mode", footer: api.theme.mode() },
    { title: "Back", value: "back", description: "Return to settings" },
  ]
  openSelect(api, "Appearance", options, (value) => {
    if (value === "theme") return dispatch(api, "theme.switch", "The theme picker")
    if (value === "mode") return dispatch(api, "theme.switch_mode", "The mode switch")
    showSections(api)
  })
}

function showDisplay(api: TuiPluginApi): void {
  const options: TuiDialogSelectOption<string>[] = DISPLAY_SETTINGS.map((setting) => ({
    title: setting.title,
    value: setting.key,
    description: "Toggle this display option",
    footer: displayLabel(setting, readDisplaySetting(api.kv, setting)),
  }))
  options.push({ title: "Back", value: "back", description: "Return to settings" })
  openSelect(api, "Display", options, (value) => {
    if (value === "back") {
      showSections(api)
      return
    }
    const setting = DISPLAY_SETTINGS.find((candidate) => candidate.key === value)
    if (setting) toggleDisplaySetting(api.kv, setting)
    showDisplay(api)
  })
}

function showPlugins(api: TuiPluginApi): void {
  const options: TuiDialogSelectOption<string>[] = [
    { title: "Manage plugins", value: "manage", description: "Open the built-in plugin manager" },
  ]
  for (const plugin of api.plugins.list()) {
    options.push({
      title: plugin.id,
      value: `plugin:${plugin.id}`,
      description: `${plugin.source} - ${plugin.active ? "active" : "inactive"}${plugin.enabled ? "" : " (disabled)"}`,
      disabled: true,
    })
  }
  options.push({ title: "Back", value: "back", description: "Return to settings" })
  openSelect(api, "Plugins", options, (value) => {
    if (value === "manage") return dispatch(api, "plugins.list", "The plugin manager")
    showSections(api)
  })
}

function showSourceControl(api: TuiPluginApi): void {
  const options: TuiDialogSelectOption<string>[] = SOURCE_CONTROL_PRESETS.map((preset) => ({
    title: preset.title,
    value: preset.key,
    description: "Choose a preset value",
    footer: formatInterval(readSourceControlNumber(api.kv, preset)),
  }))
  options.push({
    title: "Start collapsed",
    value: "startCollapsed",
    description: "Whether the panel starts minimized",
    footer: readSourceControlStartCollapsed(api.kv) ? "on" : "off",
  })
  options.push({ title: "Back", value: "back", description: "Return to settings" })
  openSelect(api, "Source Control", options, (value) => {
    if (value === "back") {
      showSections(api)
      return
    }
    if (value === "startCollapsed") {
      toggleSourceControlStartCollapsed(api.kv)
      showSourceControl(api)
      return
    }
    const preset = SOURCE_CONTROL_PRESETS.find((candidate) => candidate.key === value)
    if (preset) showSourceControlPreset(api, preset.key)
    else showSourceControl(api)
  })
}

function showSourceControlPreset(api: TuiPluginApi, key: string): void {
  const preset = SOURCE_CONTROL_PRESETS.find((candidate) => candidate.key === key)
  if (!preset) {
    showSourceControl(api)
    return
  }
  const current = readSourceControlNumber(api.kv, preset)
  const options: TuiDialogSelectOption<string>[] = preset.values.map((value) => ({
    title: formatInterval(value),
    value: String(value),
    description: preset.key === "maxFiles" ? "Rows before +N more" : "Refresh interval",
  }))
  options.push({ title: "Back", value: "back", description: "Return to Source Control" })
  openSelect(
    api,
    `${preset.title} - current ${formatInterval(current)}`,
    options,
    (value) => {
      if (value === "back") {
        showSourceControl(api)
        return
      }
      writeSourceControlNumber(api.kv, preset, Number(value))
      api.ui.toast({
        variant: "info",
        title: "Settings",
        message: `${preset.title} applies within the next refresh tick.`,
      })
      showSourceControl(api)
    },
    String(current),
  )
}

function showSidebar(api: TuiPluginApi): void {
  const width = api.renderer.width
  const options: TuiDialogSelectOption<string>[] = [
    {
      title: "Sidebar visibility",
      value: "visibility",
      description: `Auto shows the sidebar when the terminal is wider than ${SIDEBAR_AUTO_MIN_WIDTH}`,
      footer: sidebarVisibilityLabel(readSidebarVisibility(api.kv), width),
    },
  ]
  for (const panel of SIDEBAR_PANELS) {
    options.push({
      title: `${panel.title} position`,
      value: `panel:${panel.id}`,
      description: "Applies after the next OpenCode restart",
      footer: anchorForOrder(readSidebarPanelOrder(api.kv, panel)).title,
    })
  }
  options.push({ title: "Back", value: "back", description: "Return to settings" })
  openSelect(api, "Sidebar", options, (value) => {
    if (value === "back") {
      showSections(api)
      return
    }
    if (value === "visibility") {
      showSidebarVisibility(api)
      return
    }
    if (value.startsWith("panel:")) {
      showSidebarPanel(api, value.slice("panel:".length) as SidebarPanelId)
      return
    }
    showSidebar(api)
  })
}

function showSidebarVisibility(api: TuiPluginApi): void {
  const options: TuiDialogSelectOption<string>[] = [
    {
      title: "Auto",
      value: "auto",
      description: `Visible only when the terminal width exceeds ${SIDEBAR_AUTO_MIN_WIDTH}`,
    },
    { title: "Hidden", value: "hide", description: "Always hide the session sidebar" },
    { title: "Back", value: "back", description: "Return to Sidebar" },
  ]
  openSelect(
    api,
    "Sidebar visibility",
    options,
    (value) => {
      if (value === "back") {
        showSidebar(api)
        return
      }
      writeSidebarVisibility(api.kv, value === "hide" ? "hide" : "auto")
      showSidebar(api)
    },
    readSidebarVisibility(api.kv),
  )
}

function showSidebarPanel(api: TuiPluginApi, panelId: SidebarPanelId): void {
  const panel = SIDEBAR_PANELS.find((candidate) => candidate.id === panelId)
  if (!panel) {
    showSidebar(api)
    return
  }
  const current = anchorForOrder(readSidebarPanelOrder(api.kv, panel))
  const options: TuiDialogSelectOption<string>[] = SIDEBAR_ANCHORS.map((anchor) => ({
    title: anchor.title,
    value: anchor.id,
    description: `Sidebar order ${anchor.order}`,
  }))
  options.push({ title: "Back", value: "back", description: "Return to Sidebar" })
  openSelect(
    api,
    `${panel.title} position`,
    options,
    (value) => {
      if (value === "back") {
        showSidebar(api)
        return
      }
      writeSidebarPanelAnchor(api.kv, panel, value as SidebarAnchorId)
      api.ui.toast({
        variant: "info",
        title: "Settings",
        message: `${panel.title} moves after the next OpenCode restart.`,
      })
      showSidebar(api)
    },
    current.id,
  )
}

function showAbout(api: TuiPluginApi): void {
  const width = api.renderer.width
  const message = [
    `OpenCode: ${api.app.version}`,
    `Terminal: ${width}x${api.renderer.height}`,
    `Sidebar visibility: ${sidebarVisibilityLabel(readSidebarVisibility(api.kv), width)}`,
    `Loaded plugins: ${api.plugins.list().length}`,
    `Directory: ${api.state.path.directory}`,
    `Worktree: ${api.state.path.worktree}`,
  ].join("\n")
  try {
    api.ui.dialog.setSize(dialogSizeFor(width))
    api.ui.dialog.replace(() =>
      api.ui.DialogAlert({
        title: "About",
        message,
        onConfirm: () => showSections(api),
      }),
    )
  } catch {
    api.ui.toast({ variant: "warning", title: "Settings", message: "Unable to open the about dialog." })
  }
}

function openSettings(api: TuiPluginApi): void {
  showSections(api)
}

function SettingsRow(props: { api: TuiPluginApi }) {
  const open = () => openSettings(props.api)
  return (
    <box flexDirection="row" justifyContent="flex-end">
      <box
        focusable
        onMouseDown={open}
        onKeyDown={(event) => {
          if (event.name === "return" || event.name === "space") {
            event.preventDefault()
            open()
          }
        }}
      >
        <text fg={props.api.theme.current.accent}>
          <b>Settings</b>
        </text>
      </box>
    </box>
  )
}

const tui: TuiPlugin = async (api, rawOptions) => {
  const options = pluginOptions(rawOptions)
  const order = clampSidebarOrder(api.kv.get(KEYS.gearOrder), options.order ?? DEFAULT_GEAR_ORDER)

  const stopCommands = api.command?.register(() => [
    {
      title: "Open settings",
      value: "tui-settings.open",
      description: "Appearance, display, plugins, source control, and sidebar positioning.",
      category: "System",
      slash: { name: "settings" },
      onSelect: () => openSettings(api),
    },
  ])
  if (stopCommands) api.lifecycle.onDispose(stopCommands)

  api.slots.register({
    order,
    slots: {
      sidebar_content() {
        return <SettingsRow api={api} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = { id, tui }
export default plugin
