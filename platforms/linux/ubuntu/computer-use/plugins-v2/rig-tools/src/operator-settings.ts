import {
  ENFORCEMENT_NAMES,
  ORCHESTRATION_MODES,
  readEnforcementSettings,
  writeEnforcementSettings,
  type EnforcementName,
  type LoadedEnforcementSettings,
  type OrchestrationMode,
} from "../../orchestration-policy/src/settings.ts"

const FIXED_SAFETY_CORE = {
  installedBinaryProtection: "installed OpenCode binaries and distribution files remain immutable",
  distributionFileProtection: "installed OpenCode distribution files remain immutable",
  commitApproval: "commits require the separate explicit approval gate",
  pushApproval: "pushes require the separate explicit approval gate",
  protectedPathEnforcement: "protected paths remain enforced",
  exactStagedScope: "commit and push approval remains bound to the exact staged scope",
  policyIndexIntegrity: "the configured policy index remains validated before repository mutations",
  secretHandling: "credentials may never be written to source, logs, settings, or evidence",
  failClosedSettings: "missing, unreadable, or malformed settings force all workflow enforcements ON",
} as const

function showSettings(state: LoadedEnforcementSettings, notice?: string) {
  const lines = ["Open Rig workflow enforcements:"]
  lines.push(`Orchestration mode: ${state.orchestrationMode ?? "parallel"}. Parallel fills configured capacity; single-subagent admits one child at a time. Existing children drain normally.`)
  for (const name of ENFORCEMENT_NAMES) {
    lines.push(`  ${name}: ${state.enforcements[name] ? "ON" : "OFF"}`)
  }
  const disabled = ENFORCEMENT_NAMES.filter((name) => !state.enforcements[name])
  if (disabled.length) lines.push(`REDUCED POSTURE: ${disabled.join(", ")} are OFF.`)
  if (state.status === "invalid") lines.push(state.message ?? "Settings are invalid; all workflow enforcements remain ON.")
  if (state.status === "missing") lines.push("No settings file yet; all workflow enforcements default to ON.")
  lines.push("Fixed safety core (always ON; not operator-toggleable here):")
  for (const [name, reason] of Object.entries(FIXED_SAFETY_CORE)) lines.push(`  ${name}: ON — ${reason}.`)
  lines.push("Usage: /settings <enforcement-name> on|off")
  lines.push("Orchestration: /settings mode parallel|single-subagent (operator-only; all other gates retain their settings).")
  if (notice) lines.unshift(notice)
  return lines.join("\n")
}

export async function runOperatorSettingsCommand(input: string, projectRoot?: string, settingsPath?: string) {
  if (Buffer.byteLength(input, "utf8") > 256) {
    return showSettings(await readEnforcementSettings(projectRoot, settingsPath), "Settings command input exceeded 256 bytes; no settings were changed.")
  }
  const args = input.trim() ? input.trim().split(/\s+/) : []
  const state = await readEnforcementSettings(projectRoot, settingsPath)
  if (!args.length) return showSettings(state)
  if (args.length === 2 && args[0] === "mode" && ORCHESTRATION_MODES.includes(args[1] as OrchestrationMode)) {
    try {
      await writeEnforcementSettings(state.enforcements, projectRoot, settingsPath, args[1] as OrchestrationMode)
      return showSettings(await readEnforcementSettings(projectRoot, settingsPath), `Orchestration mode saved: ${args[1]}. Applies to new admissions; running and admitted children are retained.`)
    } catch {
      return showSettings(state, "Orchestration mode was not changed; settings could not be saved.")
    }
  }
  if (args.length !== 2 || (args[1] !== "on" && args[1] !== "off")) {
    return showSettings(state, "Usage error: use /settings <enforcement-name> on|off.")
  }

  const [name, value] = args
  if (Object.hasOwn(FIXED_SAFETY_CORE, name!)) {
    return showSettings(state, `Refused: ${name} is fixed safety core and cannot be toggled; ${FIXED_SAFETY_CORE[name as keyof typeof FIXED_SAFETY_CORE]}.`)
  }
  if (!(ENFORCEMENT_NAMES as readonly string[]).includes(name!)) {
    return showSettings(state, `Unknown enforcement: ${name}. No settings were changed.`)
  }

  const next = { ...state.enforcements, [name as EnforcementName]: value === "on" }
  try {
    await writeEnforcementSettings(next, projectRoot, settingsPath, state.orchestrationMode)
  } catch {
    return showSettings(state, "Settings were not changed. The active runtime keeps its current state; unreadable or malformed settings fail closed to all ON.")
  }

  const saved = await readEnforcementSettings(projectRoot, settingsPath)
  const notice = state.status === "invalid"
    ? `Replaced invalid settings from fail-closed defaults; ${name} is now ${value.toUpperCase()}.`
    : `${name} is now ${value.toUpperCase()}. The server policy re-reads settings on each hook.`
  return showSettings(saved, notice)
}
