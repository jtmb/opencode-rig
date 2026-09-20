/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createSignal, For, Show } from "solid-js"

import { ARTIFACT_KINDS, type ArtifactKind, type ArtifactStatus, type LearnedArtifact } from "./artifacts.ts"
import { containsSensitive, redactText } from "./redact.ts"
import { RepoLearning, type RepoLearningOutput } from "./rpc.ts"
import type { ShadowRecord } from "./shadow.ts"

export const LEARN_PANEL_NAME = "opencode-rig.repo-learning"
export const LEARN_SLASH = { name: "learn-review", aliases: [] }
export const LEARN_COMMAND_SLASH = { name: "learn", arguments: true as const }
export const LEARN_BIND = "ctrl+alt+l"
export const MAX_PANEL_ARTIFACTS = 32
export const MAX_PANEL_BODY_CHARS = 2_000
export const MAX_PANEL_TITLE_CHARS = 160
export const MAX_PENDING_NOTICE_COUNT = 999

export type ReviewPanelCallbacks = {
  readonly onApprove?: (artifactId: string) => void
  readonly onReject?: (artifactId: string) => void
}

export type ReviewPanelData = {
  readonly artifacts: LearnedArtifact[]
  readonly shadows: Map<string, ShadowRecord>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function boundedText(value: string, maximum: number): string {
  return value.slice(0, maximum)
}

function safePanelText(value: unknown, maximum: number, allowEmpty = false): string | undefined {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > maximum) return undefined
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return undefined
  if (containsSensitive(value) || redactText(value) !== value) return undefined
  return value
}

function displayText(value: string, maximum: number): string {
  try {
    return boundedText(redactText(value), maximum)
  } catch {
    return "[REDACTED]"
  }
}

function boundedScore(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}

function isArtifactKind(value: unknown): value is ArtifactKind {
  return typeof value === "string" && (ARTIFACT_KINDS as readonly string[]).includes(value)
}

function isArtifactStatus(value: unknown): value is ArtifactStatus {
  return value === "candidate" || value === "approved" || value === "rejected" || value === "promoted"
}

function boundedArtifact(value: unknown): LearnedArtifact | undefined {
  if (!isRecord(value)) return undefined
  if (
    safePanelText(value.id, 256) === undefined ||
    !isArtifactKind(value.kind) ||
    safePanelText(value.title, MAX_PANEL_TITLE_CHARS) === undefined ||
    safePanelText(value.body, MAX_PANEL_BODY_CHARS) === undefined ||
    safePanelText(value.createdAt, 128) === undefined || !isArtifactStatus(value.status)
  ) return undefined
  const sourceSession = value.sourceSession === undefined ? undefined : safePanelText(value.sourceSession, 256)
  const baseHash = value.baseHash === undefined ? undefined : safePanelText(value.baseHash, 512)
  if ((value.sourceSession !== undefined && sourceSession === undefined) || (value.baseHash !== undefined && baseHash === undefined)) return undefined
  return {
    id: value.id as string,
    kind: value.kind,
    title: value.title as string,
    body: value.body as string,
    ...(sourceSession === undefined ? {} : { sourceSession }),
    createdAt: value.createdAt as string,
    ...(baseHash === undefined ? {} : { baseHash }),
    status: value.status,
  }
}

function boundedShadow(value: unknown): ShadowRecord | undefined {
  if (!isRecord(value)) return undefined
  if (
    safePanelText(value.id, 256) === undefined ||
    safePanelText(value.taskId, 256) === undefined ||
    safePanelText(value.artifactId, 256) === undefined ||
    !isRecord(value.score) ||
    typeof value.score.usefulness !== "number" || !Number.isFinite(value.score.usefulness) ||
    typeof value.score.novelty !== "number" || !Number.isFinite(value.score.novelty) ||
    typeof value.score.risk !== "number" || !Number.isFinite(value.score.risk) ||
    (value.verdict !== "keep" && value.verdict !== "drop" && value.verdict !== "needs-human") ||
    value.isolated !== true || value.influencedActive !== false || safePanelText(value.evaluatedAt, 128) === undefined
  ) return undefined
  return {
    id: value.id as string,
    taskId: value.taskId as string,
    artifactId: value.artifactId as string,
    score: {
      usefulness: boundedScore(value.score.usefulness),
      novelty: boundedScore(value.score.novelty),
      risk: boundedScore(value.score.risk),
    },
    verdict: value.verdict,
    isolated: true,
    influencedActive: false,
    evaluatedAt: value.evaluatedAt as string,
  }
}

/** Accept only bounded, already-compiled review data. Invalid entries are
 * dropped rather than rendered; no untrusted options object can expand the
 * panel or smuggle arbitrary nested data into it. */
export function boundReviewPanelData(input: unknown): ReviewPanelData {
  if (!isRecord(input)) return { artifacts: [], shadows: new Map() }
  const artifacts: LearnedArtifact[] = []
  if (Array.isArray(input.artifacts)) {
    for (const value of input.artifacts.slice(0, MAX_PANEL_ARTIFACTS)) {
      const artifact = boundedArtifact(value)
      if (artifact) artifacts.push(artifact)
    }
  }
  const shadows = new Map<string, ShadowRecord>()
  const rawShadows = input.shadows
  if (rawShadows instanceof Map) {
    for (const [key, value] of rawShadows) {
      if (shadows.size >= MAX_PANEL_ARTIFACTS) break
      const shadow = boundedShadow(value)
      if (shadow && typeof key === "string" && key.length <= 256) shadows.set(key, shadow)
    }
  } else if (isRecord(rawShadows)) {
    for (const key in rawShadows) {
      if (shadows.size >= MAX_PANEL_ARTIFACTS) break
      if (!Object.prototype.hasOwnProperty.call(rawShadows, key)) continue
      const value = rawShadows[key]
      const shadow = boundedShadow(value)
      if (shadow) shadows.set(boundedText(key, 256), shadow)
    }
  }
  return { artifacts, shadows }
}

/** Pure review-card renderer: exact text the panel shows for one artifact.
 * Kept free of UI dependencies so reviewers (and future tests) can assert
 * bounded card content without mounting the TUI. */
export function renderReviewCard(
  artifact: LearnedArtifact,
  shadow: ShadowRecord | undefined,
  pendingCount: number,
): string {
  const pending = Number.isFinite(pendingCount) && pendingCount > 0
    ? Math.min(MAX_PENDING_NOTICE_COUNT, Math.floor(pendingCount))
    : 0
  const lines = [
    `### [${artifact.kind}] ${displayText(artifact.title, MAX_PANEL_TITLE_CHARS)}`,
    `id: ${displayText(artifact.id, 256)} · status: ${artifact.status} · pending: ${pending}`,
    ...(artifact.baseHash ? [`base: ${displayText(artifact.baseHash, 512)}`] : []),
    "",
    displayText(artifact.body, MAX_PANEL_BODY_CHARS),
  ]
  if (shadow) {
    lines.push(
      "",
      `shadow ${displayText(shadow.id, 256)}: ${shadow.verdict} (usefulness ${boundedScore(shadow.score.usefulness).toFixed(2)}, ` +
        `novelty ${boundedScore(shadow.score.novelty).toFixed(2)}, risk ${boundedScore(shadow.score.risk).toFixed(2)}) · isolated, no active-task influence`,
    )
  } else {
    lines.push("", "shadow: not evaluated yet (measure-only; run shadow mode first)")
  }
  lines.push("", "Review is per artifact. This panel never applies changes without an approval backend.")
  return lines.join("\n")
}

export function passiveTaskEndNotice(pendingCount: number): string {
  if (!Number.isFinite(pendingCount) || pendingCount <= 0) return ""
  const count = Math.floor(pendingCount)
  const bounded = Math.min(MAX_PENDING_NOTICE_COUNT, count)
  const label = count > MAX_PENDING_NOTICE_COUNT ? `${MAX_PENDING_NOTICE_COUNT}+` : String(bounded)
  return `repo-learning: ${label} learned artifact${count === 1 ? "" : "s"} awaiting review — /learn-review when ready (passive notice; no action taken)`
}

function ReviewList(props: {
  artifacts: () => LearnedArtifact[]
  shadows: () => Map<string, ShadowRecord>
  callbacks?: ReviewPanelCallbacks
}) {
  const context = usePlugin()
  const [filter, setFilter] = createSignal<string>("all")
  const visible = () => {
    const current = filter()
    const artifacts = props.artifacts().slice(0, MAX_PANEL_ARTIFACTS)
    return current === "all" ? artifacts : artifacts.filter((artifact) => artifact.kind === current)
  }
  const canMutate = () => props.callbacks?.onApprove !== undefined && props.callbacks.onReject !== undefined
  const activate = (artifactId: string, action: "approve" | "reject") => {
    if (action === "approve") props.callbacks?.onApprove?.(artifactId)
    else props.callbacks?.onReject?.(artifactId)
  }
  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} padding={1}>
      <text fg={context.theme.hue.accent[200]}>
        <b>Learned artifacts ({visible().length} pending review)</b>
      </text>
      <box flexDirection="row" gap={1}>
        <text fg={context.theme.text.subdued}>filter: {filter()}</text>
        <For each={["all", ...ARTIFACT_KINDS]}>
          {(kind) => (
            <box focusable onMouseDown={() => setFilter(kind)} onKeyDown={(event) => {
              if (event.name === "return" || event.name === "space") {
                event.preventDefault()
                setFilter(kind)
              }
            }}>
              <text fg={filter() === kind ? context.theme.hue.accent[200] : context.theme.text.subdued}>{kind}</text>
            </box>
          )}
        </For>
      </box>
      <scrollbox flexGrow={1} minHeight={0} overflow="hidden">
        <For each={visible()}>
          {(artifact) => (
            <box flexDirection="column" borderStyle="single" borderColor={context.theme.border.default} paddingLeft={1} paddingRight={1}>
              <text fg={context.theme.hue.accent[200]}>
                [{artifact.kind}] {boundedText(artifact.title, MAX_PANEL_TITLE_CHARS)}
              </text>
              <text fg={context.theme.text.subdued}>
                {boundedText(artifact.id, 256)} · {artifact.status}
                {artifact.baseHash ? ` · base ${boundedText(artifact.baseHash, 12)}` : ""}
              </text>
              <text fg={context.theme.text.default}>{boundedText(artifact.body, MAX_PANEL_BODY_CHARS)}</text>
              <Show when={props.shadows().get(artifact.id)}>
                {(record) => (
                  <text fg={context.theme.text.subdued}>
                    shadow {boundedText(record().id, 256)}: {record().verdict} · isolated, no active-task influence
                  </text>
                )}
              </Show>
              <Show when={canMutate()} fallback={<text fg={context.theme.text.subdued}>read-only: approval backend is not registered</text>}>
                <box flexDirection="row" gap={1}>
                  <box focusable onMouseDown={() => activate(artifact.id, "approve")} onKeyDown={(event) => {
                    if (event.name === "return" || event.name === "space") {
                      event.preventDefault()
                      activate(artifact.id, "approve")
                    }
                  }}><text fg={context.theme.text.feedback.success.default}>approve</text></box>
                  <box focusable onMouseDown={() => activate(artifact.id, "reject")} onKeyDown={(event) => {
                    if (event.name === "return" || event.name === "space") {
                      event.preventDefault()
                      activate(artifact.id, "reject")
                    }
                  }}><text fg={context.theme.text.feedback.error.default}>reject</text></box>
                </box>
              </Show>
            </box>
          )}
        </For>
      </scrollbox>
      <Show when={!canMutate()}>
        <text fg={context.theme.text.subdued}>Read-only scaffold: no approve/reject action is advertised.</text>
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: "opencode-rig.repo-learning",
  setup(context) {
    const rpc = context.client.rpc(RepoLearning)
    const rpcOptions = { location: context.location }
    const initial = boundReviewPanelData(context.options)
    const [artifacts] = createSignal<LearnedArtifact[]>(initial.artifacts)
    const [shadows] = createSignal<Map<string, ShadowRecord>>(initial.shadows)

    const openReview = () => {
      const opened = context.ui.panel.open(LEARN_PANEL_NAME)
      if (!opened) void context.ui.dialog.alert({ title: "Repo learning", message: "This review view requires an active session." }).catch(() => undefined)
    }

    const currentSessionID = () => {
      const route = context.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }

    const showLearn = async (input?: string) => {
      const sessionID = currentSessionID()
      if (!sessionID) {
        await context.ui.dialog.alert({ title: "Repo learning", message: "The /learn command requires an active session." }).catch(() => undefined)
        return
      }
      let result: RepoLearningOutput
      try {
        result = await rpc.learn({ sessionID, command: input ?? "" }, rpcOptions) as RepoLearningOutput
      } catch {
        await context.ui.dialog.alert({ title: "Repo learning", message: "The command failed. Restart OpenCode if the server plugin is not loaded." }).catch(() => undefined)
        return
      }
      await context.ui.dialog.alert({ title: "Repo learning", message: result.text }).catch(() => undefined)
    }

    const stopPanel = context.ui.slot({
      append: "session.panel",
      render: (panel) => panel.name === LEARN_PANEL_NAME
        ? <ReviewList artifacts={artifacts} shadows={shadows} />
        : null,
    })

    const stopKeymap = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "repo-learning.learn",
              title: "Repo learning status",
              description: "Show bounded repo-learning status or audit without a model turn.",
              group: "Learning",
              palette: true,
              slash: LEARN_COMMAND_SLASH,
              run: (input) => void showLearn(input),
            },
            {
              id: "repo-learning.review",
              title: "Review learned artifacts",
              description: "Open the bounded read-only repo-learning review panel.",
              group: "Learning",
              bind: LEARN_BIND,
              palette: true,
              slash: LEARN_SLASH,
              run: openReview,
            },
          ],
        }))
        return null as never
      },
    })

    // Passive task-end notice: a bounded footer status line, never a dialog
    // or an action. It reports only a capped pending-review count.
    const stopFooter = context.ui.slot({
      append: "home.footer.status",
      render: () => {
        const pending = artifacts().filter((artifact) => artifact.status === "candidate").length
        const notice = passiveTaskEndNotice(pending)
        return notice ? <text>{notice}</text> : null
      },
    } as never)

    return () => {
      stopPanel()
      stopKeymap()
      stopFooter()
    }
  },
})
