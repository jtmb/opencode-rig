import type { HermesHookEvent, HermesHookSnapshot } from "./hermes-hooks-snapshot.ts"

export type HermesPipelineStageID = "session" | "turn" | "model" | "tools" | "subagents"
export type HermesPipelineStageStatus = "idle" | "active" | "complete" | "error"

export type HermesPipelineStage = {
  id: HermesPipelineStageID
  label: string
  status: HermesPipelineStageStatus
  count: number
  latestAt?: string
  detail?: string
}

type StageDefinition = {
  id: HermesPipelineStageID
  label: string
  starts: ReadonlySet<HermesHookEvent["hook"]>
  ends: ReadonlySet<HermesHookEvent["hook"]>
  reference: "sessionRef" | "turnRef" | "requestRef" | "toolRef"
}

const DEFINITIONS: readonly StageDefinition[] = [
  {
    id: "session",
    label: "Session",
    starts: new Set(["on_session_start"]),
    ends: new Set(["on_session_finalize", "on_session_reset"]),
    reference: "sessionRef",
  },
  {
    id: "turn",
    label: "Turn",
    starts: new Set(["pre_llm_call"]),
    ends: new Set(["post_llm_call", "on_session_end"]),
    reference: "turnRef",
  },
  {
    id: "model",
    label: "Model",
    starts: new Set(["pre_api_request", "pre_auxiliary_call"]),
    ends: new Set(["post_api_request", "api_request_error", "post_auxiliary_call"]),
    reference: "requestRef",
  },
  {
    id: "tools",
    label: "Tools",
    starts: new Set(["pre_tool_call"]),
    ends: new Set(["post_tool_call"]),
    reference: "toolRef",
  },
  {
    id: "subagents",
    label: "Subagents",
    starts: new Set(["subagent_start"]),
    ends: new Set(["subagent_stop"]),
    reference: "sessionRef",
  },
]

function finalStatus(event: HermesHookEvent): HermesPipelineStageStatus {
  if (["error", "blocked", "cancelled", "interrupted"].includes(event.status)) return "error"
  if (["ok", "completed"].includes(event.status)) return "complete"
  return "idle"
}

function safeDetail(event: HermesHookEvent | undefined): string | undefined {
  if (!event) return undefined
  return event.tool ?? event.model ?? event.auxTask ?? event.provider ?? event.status
}

function stageFor(snapshot: HermesHookSnapshot, definition: StageDefinition): HermesPipelineStage {
  const relevant = snapshot.events
    .filter((event) => definition.starts.has(event.hook) || definition.ends.has(event.hook))
    .slice()
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
  const outstanding = new Set<string>()
  let latest: HermesHookEvent | undefined

  for (const [index, event] of relevant.entries()) {
    const reference = event[definition.reference] ?? `${definition.id}-${index}`
    latest = event
    if (definition.starts.has(event.hook)) {
      outstanding.add(reference)
    } else {
      outstanding.delete(reference)
      if (!event[definition.reference] && outstanding.size === 1) outstanding.clear()
    }
  }

  const status = outstanding.size
    ? "active"
    : latest && definition.ends.has(latest.hook)
      ? finalStatus(latest)
      : latest && definition.starts.has(latest.hook)
        ? "active"
        : "idle"

  return {
    id: definition.id,
    label: definition.label,
    status,
    count: relevant.length,
    ...(latest ? { latestAt: latest.at, detail: safeDetail(latest) } : {}),
  }
}

export function hermesPipelineStages(snapshot: HermesHookSnapshot): HermesPipelineStage[] {
  return DEFINITIONS.map((definition) => stageFor(snapshot, definition))
}
