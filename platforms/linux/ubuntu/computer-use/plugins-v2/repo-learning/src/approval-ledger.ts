import { createHash, randomBytes } from "node:crypto"

import {
  instructionPlanFingerprint,
  validateInstructionPlan,
  type CanonicalInstructionPlan,
} from "./repo-writer.ts"
import { containsSensitive, redactText } from "./redact.ts"

export const INSTRUCTION_APPROVAL_TTL_MS = 60_000
export const MAX_PENDING_INSTRUCTION_APPROVALS = 64

export type InstructionApprovalContext = {
  sessionID: string
  agent: string
  operatorID?: string
}

export type InstructionApprovalIntent = {
  action: "publish-learned-instruction"
  candidateID: string
  contentID: string
  repoNamespace: string
  targetPath: string
  targetDigest: string
  baseDigest: string
  contentDigest: string
  repositoryRootDigest: string
}

type ApprovalToken = {
  token: string
  contextDigest: string
  planFingerprint: string
  plan: CanonicalInstructionPlan
  intent: InstructionApprovalIntent
  expiresAt: number
}

export type InstructionApprovalPreview = {
  dryRun: true
  intent: InstructionApprovalIntent
  expectToken: string
  expiresAt: number
}

export type ConsumedInstructionApproval = {
  plan: CanonicalInstructionPlan
  contextDigest: string
}

const CONTROL = /[\u0000-\u001f\u007f]/
const MAX_IDENTITY_CHARS = 256
const MAX_DATE_MS = 8_640_000_000_000_000

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function checkedNow(now: () => number): number {
  const value = now()
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DATE_MS - INSTRUCTION_APPROVAL_TTL_MS) {
    throw new Error("instruction approval clock is invalid")
  }
  return value
}

function checkedText(value: string | undefined, label: string, optional = false): string | undefined {
  if (value === undefined && optional) return undefined
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_IDENTITY_CHARS || CONTROL.test(value)) {
    throw new Error(`${label} must be present and bounded`)
  }
  if (containsSensitive(value) || redactText(value) !== value) throw new Error(`${label} contains secret material`)
  return value
}

function contextFingerprint(context: InstructionApprovalContext): string {
  const sessionID = checkedText(context?.sessionID, "sessionID")
  const agent = checkedText(context?.agent, "agent")
  const operatorID = checkedText(context?.operatorID, "operatorID", true)
  return digest(JSON.stringify({ sessionID, agent, operatorID }))
}

function clonePlan(plan: CanonicalInstructionPlan): CanonicalInstructionPlan {
  return { ...plan }
}

function makeIntent(plan: CanonicalInstructionPlan): InstructionApprovalIntent {
  return {
    action: "publish-learned-instruction",
    candidateID: plan.candidateID,
    contentID: plan.contentID,
    repoNamespace: plan.repoNamespace,
    targetPath: plan.targetPath,
    targetDigest: plan.targetDigest,
    baseDigest: plan.baseDigest,
    contentDigest: plan.contentDigest,
    repositoryRootDigest: plan.repositoryRootDigest,
  }
}

export function createInstructionApprovalLedger(now: () => number = Date.now) {
  const tokens = new Map<string, ApprovalToken>()

  const prune = (nowMs: number): void => {
    for (const [token, record] of tokens) if (record.expiresAt <= nowMs) tokens.delete(token)
    while (tokens.size >= MAX_PENDING_INSTRUCTION_APPROVALS) {
      const oldest = tokens.keys().next().value as string | undefined
      if (!oldest) break
      tokens.delete(oldest)
    }
  }

  const preview = (plan: CanonicalInstructionPlan, context: InstructionApprovalContext): InstructionApprovalPreview => {
    validateInstructionPlan(plan)
    const safeContextDigest = contextFingerprint(context)
    const nowMs = checkedNow(now)
    prune(nowMs)
    const storedPlan = clonePlan(plan)
    const intent = makeIntent(storedPlan)
    const token = randomBytes(32).toString("base64url")
    const expiresAt = nowMs + INSTRUCTION_APPROVAL_TTL_MS
    tokens.set(token, {
      token,
      contextDigest: safeContextDigest,
      planFingerprint: instructionPlanFingerprint(storedPlan),
      plan: storedPlan,
      intent,
      expiresAt,
    })
    return { dryRun: true, intent: { ...intent }, expectToken: token, expiresAt }
  }

  const consume = (
    plan: CanonicalInstructionPlan,
    input: { approval?: boolean; expectToken?: string },
    context: InstructionApprovalContext,
  ): ConsumedInstructionApproval => {
    if (input?.approval !== true) throw new Error("publishing a learned instruction requires explicit approval=true")
    const safeContextDigest = contextFingerprint(context)
    const nowMs = checkedNow(now)
    const record = typeof input.expectToken === "string" ? tokens.get(input.expectToken) : undefined
    if (!record) throw new Error("instruction approval token is missing, expired, or already used")
    if (record.expiresAt <= nowMs) {
      tokens.delete(record.token)
      throw new Error("instruction approval token is expired")
    }
    if (record.contextDigest !== safeContextDigest) throw new Error("instruction approval token belongs to a different session, agent, or operator")
    validateInstructionPlan(plan)
    const currentFingerprint = instructionPlanFingerprint(plan)
    if (currentFingerprint !== record.planFingerprint || currentFingerprint !== instructionPlanFingerprint(record.plan)) {
      throw new Error("approved instruction target, base, or content changed after preview")
    }
    const currentIntent = makeIntent(plan)
    if (JSON.stringify(currentIntent) !== JSON.stringify(record.intent)) {
      throw new Error("instruction approval token does not match the exact publication intent")
    }
    tokens.delete(record.token)
    return { plan: clonePlan(record.plan), contextDigest: record.contextDigest }
  }

  return { preview, consume }
}
