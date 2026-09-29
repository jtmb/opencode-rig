import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import type { Context } from "@opencode/plugin/tui/context"
import { DEFAULT_ENFORCEMENTS, readEnforcementSettings } from "../../orchestration-policy/src/settings.ts"

import {
  DEFAULT_GOAL_UI_PREFERENCES,
  goalUIPreferenceEnabled,
  showGoalSettingsPalette,
  type GoalUIPreferences,
} from "../src/goal-ui-settings.ts"

function makeContext(projectRoot: string, choose: (options: readonly { title: string; value: string; disabled?: boolean }[]) => Promise<string | undefined>, prompt?: string) {
  const toasts: string[] = []
  const alerts: string[] = []
  let promptDescription = ""
  const context = {
    location: { directory: projectRoot },
    ui: {
      dialog: {
        select: async <Value>(input: { options: readonly { title: string; value: Value; disabled?: boolean }[] }) => {
          const value = await choose(input.options as readonly { title: string; value: string; disabled?: boolean }[])
          return value as Value | undefined
        },
        prompt: async (input: { description?: string }) => {
          promptDescription = input.description ?? ""
          return prompt
        },
        alert: async (input: { message: string }) => { alerts.push(input.message) },
      },
      toast: { show: (input: { message: string }) => toasts.push(input.message) },
    },
  } as unknown as Pick<Context, "location" | "ui">
  return {
    context,
    toasts,
    alerts,
    get promptDescription() { return promptDescription },
  }
}

test("workflow palette selects orchestration mode, reads it back on reopen, and cancels without writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-mode-settings-"))
  const settingsPath = join(root, "config", "opencode", "orchestration-policy-settings.json")
  let choices: (string | undefined)[] = ["orchestration", "single-subagent"]
  let mainTitle = ""
  const ui = makeContext(join(root, "project"), async (options) => {
    const main = options.find((option) => option.value === "orchestration")
    if (main) mainTitle = main.title
    else assert.deepEqual(options.map((option) => option.value), ["parallel", "single-subagent"])
    return choices.shift()
  })
  const open = () => showGoalSettingsPalette(ui.context, {
    settings: { ...DEFAULT_GOAL_UI_PREFERENCES }, updateSettings: async () => {},
    currentSessionID: () => undefined, handoffMode: () => undefined,
    refreshGoal: async () => {}, toggleHandoff: async () => {}, enforcementSettingsPath: settingsPath,
  })
  try {
    await open()
    assert.match(ui.alerts[0]!, /mode saved: single-subagent/)
    const saved = await readEnforcementSettings(join(root, "project"), settingsPath)
    assert.equal(saved.orchestrationMode, "single-subagent")
    assert.deepEqual(saved.enforcements, DEFAULT_ENFORCEMENTS)
    const bytes = await readFile(settingsPath, "utf8")
    choices = ["orchestration", undefined]
    await open()
    assert.match(mainTitle, /single-subagent/)
    assert.equal(await readFile(settingsPath, "utf8"), bytes)
    choices = ["orchestration", "parallel"]
    await open()
    assert.equal((await readEnforcementSettings(join(root, "project"), settingsPath)).orchestrationMode, "parallel")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("the single settings palette entry persists Goal visibility and per-session handoff choices", async () => {
  assert.deepEqual(DEFAULT_GOAL_UI_PREFERENCES, { footerGoal: true, sidebarGoal: true, hoverPreview: true })
  const root = await mkdtemp(join(tmpdir(), "rig-goal-settings-"))
  const projectRoot = join(root, "project")
  const settingsPath = join(root, "config", "orchestration-policy-settings.json")
  const persisted = new Map<string, GoalUIPreferences>()
  let settings = { ...DEFAULT_GOAL_UI_PREFERENCES }
  let choice: string | undefined
  let options: readonly { title: string; value: string; disabled?: boolean }[] = []
  let activeSession = "ses_current"
  const modes = new Map([["ses_current", "manual" as const], ["ses_other", "auto" as const]])
  const calls: string[] = []
  const ui = makeContext(projectRoot, async (items) => {
    options = items
    return choice
  })
  const openSettings = () => showGoalSettingsPalette(ui.context, {
    settings,
    updateSettings: async (mutation) => {
      const next = { ...settings }
      mutation(next)
      settings = next
      persisted.set("goal-ui-settings", { ...next })
    },
    currentSessionID: () => activeSession,
    handoffMode: (sessionID) => modes.get(sessionID),
    refreshGoal: async () => undefined,
    toggleHandoff: async (sessionID) => {
      calls.push(sessionID)
      modes.set(sessionID, modes.get(sessionID) === "manual" ? "auto" : "manual")
    },
    enforcementSettingsPath: settingsPath,
  })

  try {
    choice = "footerGoal"
    await openSettings()
    assert.equal(persisted.get("goal-ui-settings")?.footerGoal, false)
    assert.equal(goalUIPreferenceEnabled(persisted.get("goal-ui-settings")!, "sidebarGoal"), true)

    settings = { ...persisted.get("goal-ui-settings")! }
    choice = undefined
    await openSettings()
    assert.match(options.find((option) => option.value === "footerGoal")!.title, /Off/)
    assert.match(options.find((option) => option.value === "sidebarGoal")!.title, /On/)
    assert.match(options.find((option) => option.value === "hoverPreview")!.title, /On/)
    assert.match(options.find((option) => option.value === "handoff")!.title, /Manual/)
    assert.ok(options.some((option) => option.value === "enforcements"))

    choice = "sidebarGoal"
    await openSettings()
    choice = "hoverPreview"
    await openSettings()
    assert.deepEqual(persisted.get("goal-ui-settings"), { footerGoal: false, sidebarGoal: false, hoverPreview: false })

    choice = "handoff"
    await openSettings()
    assert.deepEqual(calls, ["ses_current"])
    assert.equal(modes.get("ses_current"), "auto")
    assert.equal(modes.get("ses_other"), "auto")

    choice = "enforcements"
    const enforcementContext = makeContext(projectRoot, async () => choice, "requireTaskDeclare off")
    await showGoalSettingsPalette(enforcementContext.context, {
      settings,
      updateSettings: async () => undefined,
      currentSessionID: () => activeSession,
      handoffMode: (sessionID) => modes.get(sessionID),
      refreshGoal: async () => undefined,
      toggleHandoff: async () => undefined,
      enforcementSettingsPath: settingsPath,
    })
    assert.match(enforcementContext.promptDescription, /Fixed safety core/)
    assert.match(enforcementContext.alerts[0] ?? "", /requireTaskDeclare is now OFF/)
    assert.match(await readFile(settingsPath, "utf8"), /"requireTaskDeclare": false/)

    choice = "handoff"
    activeSession = "ses_other"
    let staleSession = "ses_current"
    const stale = makeContext(projectRoot, async () => {
      staleSession = "ses_other"
      return choice
    })
    await showGoalSettingsPalette(stale.context, {
      settings,
      updateSettings: async () => undefined,
      currentSessionID: () => staleSession,
      handoffMode: (sessionID) => modes.get(sessionID),
      refreshGoal: async () => undefined,
      toggleHandoff: async (sessionID) => { calls.push(sessionID) },
      enforcementSettingsPath: settingsPath,
    })
    assert.equal(calls.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("settings palette reports select failures through the UI error path", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-goal-settings-error-"))
  const ui = makeContext(root, async () => { throw new Error("dialog failed") })
  try {
    await showGoalSettingsPalette(ui.context, {
      settings: { ...DEFAULT_GOAL_UI_PREFERENCES },
      updateSettings: async () => undefined,
      currentSessionID: () => undefined,
      handoffMode: () => undefined,
      refreshGoal: async () => undefined,
      toggleHandoff: async () => undefined,
    })
    assert.deepEqual(ui.toasts, ["Open Rig workflow settings could not be read or updated."])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
