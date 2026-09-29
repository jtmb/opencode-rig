import type { Context } from "@opencode/plugin/tui/context"

import { runOperatorSettingsCommand } from "./operator-settings.ts"
import { readEnforcementSettings, type OrchestrationMode } from "../../orchestration-policy/src/settings.ts"
import type { GoalHandoffMode } from "./goal-handoff-control.ts"

export type GoalUIPreferences = {
  footerGoal: boolean
  sidebarGoal: boolean
  hoverPreview: boolean
}

export type GoalUIPreferenceKey = keyof GoalUIPreferences

export const DEFAULT_GOAL_UI_PREFERENCES: GoalUIPreferences = {
  footerGoal: true,
  sidebarGoal: true,
  hoverPreview: true,
}

export function goalUIPreferenceEnabled(settings: GoalUIPreferences, key: GoalUIPreferenceKey): boolean {
  return settings[key] !== false
}

const PREFERENCE_LABELS: Record<GoalUIPreferenceKey, string> = {
  footerGoal: "Footer Goal summary",
  sidebarGoal: "Sidebar Goal summary",
  hoverPreview: "Footer Goal hover/focus preview",
}

type SettingsChoice = GoalUIPreferenceKey | "handoff" | "enforcements" | "orchestration"

export async function showGoalSettingsPalette(
  context: Pick<Context, "location" | "ui">,
  input: {
    settings: GoalUIPreferences
    updateSettings: (mutation: (draft: GoalUIPreferences) => void) => Promise<void>
    currentSessionID: () => string | undefined
    handoffMode: (sessionID: string) => GoalHandoffMode | undefined
    refreshGoal: (sessionID: string) => Promise<void>
    toggleHandoff: (sessionID: string) => Promise<void>
    enforcementSettingsPath?: string
  },
): Promise<void> {
  try {
    const sessionID = input.currentSessionID()
    if (sessionID) await input.refreshGoal(sessionID)
    const mode = sessionID ? input.handoffMode(sessionID) : undefined
    const operatorSettings = await readEnforcementSettings(context.location?.directory, input.enforcementSettingsPath)
    const choice = await context.ui.dialog.select<SettingsChoice>({
      title: "Open Rig workflow settings",
      options: [
        ...Object.keys(PREFERENCE_LABELS).map((key) => {
          const preference = key as GoalUIPreferenceKey
          return {
            title: `${PREFERENCE_LABELS[preference]}: ${goalUIPreferenceEnabled(input.settings, preference) ? "On" : "Off"}`,
            value: preference,
          }
        }),
        {
          title: `Current session Goal handoff: ${mode === "auto" ? "Auto" : mode === "manual" ? "Manual" : "Unavailable"}`,
          description: sessionID ? "Switch this session between Auto and Manual." : "Requires an active session.",
          value: "handoff",
          disabled: !sessionID || !mode,
        },
        { title: "Workflow enforcement settings…", value: "enforcements" },
        { title: `Orchestration mode: ${operatorSettings.status === "invalid" ? "Invalid — repair" : operatorSettings.orchestrationMode ?? "parallel"}`, value: "orchestration" },
      ],
    })
    if (!choice) return

    if (choice === "orchestration") {
      const selected = await context.ui.dialog.select<OrchestrationMode>({
        title: "Orchestration mode (new child admissions)",
        current: operatorSettings.orchestrationMode ?? "parallel",
        options: [
          { title: "Parallel (default)", value: "parallel", description: "Dispatch every eligible Todo up to configured maxConcurrent (hard ceiling 10)." },
          { title: "Single-subagent", value: "single-subagent", description: "Admit one child at a time; running and already admitted children finish normally. All other gates retain their settings." },
        ],
      })
      if (!selected) return
      const message = await runOperatorSettingsCommand(`mode ${selected}`, context.location?.directory, input.enforcementSettingsPath)
      await context.ui.dialog.alert({ title: "Open Rig orchestration mode", message })
      return
    }

    if (choice in PREFERENCE_LABELS) {
      const preference = choice as GoalUIPreferenceKey
      const next = !goalUIPreferenceEnabled(input.settings, preference)
      await input.updateSettings((draft) => {
        draft[preference] = next
      })
      context.ui.toast.show({
        message: `${PREFERENCE_LABELS[preference]} ${next ? "shown" : "hidden"}.`,
        variant: "success",
      })
      return
    }

    if (choice === "handoff") {
      if (!sessionID || input.currentSessionID() !== sessionID || input.handoffMode(sessionID) !== mode || !mode) {
        context.ui.toast.show({ message: "The active session changed; reopen settings before changing Goal handoff.", variant: "warning" })
        return
      }
      await input.toggleHandoff(sessionID)
      const next = input.handoffMode(sessionID)
      if (next === mode || !next) throw new Error("Goal handoff did not update")
      context.ui.toast.show({ message: `Goal handoff is now ${next === "auto" ? "Auto" : "Manual"} for this session.`, variant: "success" })
      return
    }

    const directory = context.location?.directory
    const current = await runOperatorSettingsCommand("", directory, input.enforcementSettingsPath)
    const value = await context.ui.dialog.prompt({
      title: "Open Rig workflow settings",
      description: `${current}\n\nEnter <enforcement-name> on|off to change one setting. Leave blank to close.`,
      placeholder: "requireTaskDeclare off",
    })
    if (!value?.trim()) return
    const message = await runOperatorSettingsCommand(value, directory, input.enforcementSettingsPath)
    await context.ui.dialog.alert({ title: "Open Rig workflow settings", message }).catch(() => undefined)
  } catch {
    context.ui.toast.show({ message: "Open Rig workflow settings could not be read or updated.", variant: "error" })
  }
}
