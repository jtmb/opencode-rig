import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

import orchestrationPolicy from "../src/index.ts"
import { assertPlanParent, createGoalManager, goalDisplayState, recoverableStoredGoal } from "../src/goal.ts"

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../../../../..")

function fixture(agent = "build", persisted = new Map<string, unknown>()) {
  const state: {
    taskIncomplete: boolean
    buildAvailable: boolean
    sessionStatus: "busy" | "idle"
    waitCalls: number
    waitFails: boolean
    dispatchError?: string
  } = { taskIncomplete: false, buildAvailable: true, sessionStatus: "idle", waitCalls: 0, waitFails: false }
  let session: {
    id: string
    projectID: string
    agent?: string
    parentID?: string
    model?: { providerID: string; id: string; variant?: string }
  } = {
    id: agent === "plan" ? "ses_plan" : "ses_goal",
    projectID: "project",
    agent,
    model: { providerID: "openai", id: "gpt-test", variant: "high" },
  }
  const prompts: { sessionID: string; text: string }[] = []
  const admittedPrompts: { sessionID: string; stale: boolean }[] = []
  const stateUpdates: string[] = []
  const switchedModels: { providerID: string; id: string; variant?: string }[] = []
  let consumePromptDuringAdmission = false
  let cancelPromptDuringAdmission = false
  let rejectPromptDuringAdmission = false
  let nextInboxID = 0
  const manager = createGoalManager({
    storage: {
      get: async (key) => structuredClone(persisted.get(key)),
      set: async (key, value) => { persisted.set(key, structuredClone(value)) },
    },
    onStateChange: async (sessionID) => { stateUpdates.push(sessionID) },
    getSession: async (sessionID) => {
      assert.equal(sessionID, session.id)
      return session
    },
    waitForIdle: managerDependenciesWait,
    buildAgentAvailable: async () => state.buildAvailable,
    switchAgent: async (_sessionID, selected) => {
      session = { ...session, agent: selected, model: { providerID: "build-provider", id: "build-default" } }
    },
    switchModel: async (_sessionID, selected) => {
      switchedModels.push(selected)
      session = { ...session, model: selected }
    },
    prompt: async (sessionID, text) => {
      prompts.push({ sessionID, text })
      nextInboxID += 1
      const id = `msg_${nextInboxID}`
      if (consumePromptDuringAdmission) {
        admittedPrompts.push({ sessionID, stale: (await manager.consumeQueuedPrompt(sessionID, text)).stale })
      }
      if (cancelPromptDuringAdmission) await manager.finishInbox(sessionID, id, true)
      if (rejectPromptDuringAdmission) throw new Error("prompt admission failed")
      return { id }
    },
    taskIncomplete: async () => state.taskIncomplete,
    requireDispatch: async () => { if (state.dispatchError) throw new Error(state.dispatchError) },
  })
  let localAgent = agent
  return {
    manager,
    state,
    prompts,
    admittedPrompts,
    stateUpdates,
    switchedModels,
    persisted,
    setLocalAgent: (selected: string) => { localAgent = selected },
    setServerAgent: (selected: string) => { session = { ...session, agent: selected } },
    consumePromptDuringAdmission: () => { consumePromptDuringAdmission = true },
    cancelPromptDuringAdmission: () => { cancelPromptDuringAdmission = true },
    rejectPromptDuringAdmission: () => { rejectPromptDuringAdmission = true },
    localAgent: () => localAgent,
    session: () => session,
    waitForIdle: managerDependenciesWait,
    completeWait: async (sessionID: string, executionID: string) => {
      await managerDependenciesWait(sessionID)
      return manager.observeWaitedIdle(sessionID, executionID)
    },
    observeStatus: async (sessionID: string, status: "busy" | "idle" | "retry", eventID: string) => {
      state.sessionStatus = status === "idle" ? "idle" : "busy"
      return manager.observeStatus(sessionID, status, eventID)
    },
    observeExecution: async (sessionID: string, outcome: "started" | "succeeded" | "failed" | "interrupted", eventID: string) => {
      if (outcome === "started") state.sessionStatus = "busy"
      return manager.observeExecution(sessionID, outcome, eventID)
    },
  }

  async function managerDependenciesWait(sessionID: string) {
    assert.equal(sessionID, session.id)
    state.waitCalls++
    if (state.waitFails) throw new Error("wait failed")
    state.sessionStatus = "idle"
  }
}

test("manual Goal commands persist, pause, resume, clear, and invalidate queued markers", async () => {
  const harness = fixture()
  const started = await harness.manager.command("ses_goal", "Preserve this objective")
  assert.match(started.text, /Objective: Preserve this objective/)
  assert.equal(harness.prompts.length, 1)
  const queued = harness.prompts[0]!.text
  assert.equal((await harness.manager.get("ses_goal")).queuedPrompt?.inboxID, "msg_1")

  const restarted = fixture("build", harness.persisted)
  assert.equal((await restarted.manager.get("ses_goal")).originalObjective, "Preserve this objective")
  assert.equal((await restarted.manager.get("ses_goal")).handoff, "manual")

  await harness.manager.finishInbox("ses_goal", "msg_1")
  const accepted = await harness.manager.consumeQueuedPrompt("ses_goal", queued)
  assert.equal(accepted.stale, false)
  assert.doesNotMatch(accepted.prompt, /open-rig-goal-prompt/)

  await harness.manager.command("ses_goal", "pause")
  assert.equal((await harness.manager.get("ses_goal")).status, "paused")
  assert.equal((await harness.manager.consumeQueuedPrompt("ses_goal", queued)).stale, true)

  await harness.manager.command("ses_goal", "resume")
  assert.equal(harness.prompts.length, 2)
  assert.match(harness.prompts[1]!.text, /Resume the active Goal/)

  const cleared = await harness.manager.command("ses_goal", "clear")
  assert.equal(cleared.cancelInboxID, "msg_2")
  assert.equal((await harness.manager.get("ses_goal")).status, "cleared")
  assert.equal((await harness.manager.consumeQueuedPrompt("ses_goal", harness.prompts[1]!.text)).stale, true)
})

test("Goal display state contains only bounded objective, status, and handoff", async () => {
  const harness = fixture()
  await harness.manager.command("ses_goal", "Keep the exact objective")
  await harness.observeExecution("ses_goal", "started", "goal-execution")
  await harness.manager.report("ses_goal", { status: "progress", evidence: "Private evidence must not enter the summary." })

  const state = goalDisplayState(await harness.manager.get("ses_goal"))
  assert.deepEqual(state, {
    status: "active",
    handoff: "manual",
    objective: "Keep the exact objective",
  })
  assert.deepEqual(Object.keys(state).sort(), ["handoff", "objective", "status"])
  assert.ok(harness.stateUpdates.length >= 2)
})

test("server state-change notifications cover handoff, Plan, report, and lifecycle writes", async () => {
  const build = fixture()
  await build.manager.command("ses_goal", "Notify after Goal commands")
  await build.manager.toggleHandoff("ses_goal")
  await build.observeExecution("ses_goal", "started", "build-execution")
  await build.manager.report("ses_goal", { status: "progress", evidence: "A bounded progress update." })
  assert.ok(build.stateUpdates.length >= 3)
  assert.ok(build.stateUpdates.every((sessionID) => sessionID === "ses_goal"))

  const plan = fixture("plan")
  await plan.observeExecution("ses_plan", "started", "plan-execution")
  await plan.manager.planReady("ses_plan", {
    objective: "Implement from Plan",
    acceptanceCriteria: ["The state refreshes"],
    plan: "Implement and verify.",
  })
  await plan.observeExecution("ses_plan", "succeeded", "plan-execution")
  assert.ok(plan.stateUpdates.length >= 2)
})

test("cancelling a queued Goal prompt blocks retry until resume and rejects its marker", async () => {
  const harness = fixture()
  await harness.manager.command("ses_goal", "Retry only after an explicit resume")
  const prompt = harness.prompts[0]!.text
  await harness.manager.finishInbox("ses_goal", "msg_1", true)
  assert.equal((await harness.manager.get("ses_goal")).status, "blocked")
  assert.equal((await harness.manager.get("ses_goal")).queuedPrompt, undefined)
  assert.equal((await harness.manager.consumeQueuedPrompt("ses_goal", prompt)).stale, true)
})

test("Auto waits for a successful idle Plan without queued user input and preserves the selected model variant", async () => {
  const harness = fixture("plan")
  await harness.manager.toggleHandoff("ses_plan")
  await harness.observeExecution("ses_plan", "started", "plan-execution")
  await harness.manager.planReady("ses_plan", {
    objective: "Implement the feature",
    acceptanceCriteria: ["The feature is verified"],
    plan: "Inspect, implement, and run the focused checks.",
  })
  const executionID = await harness.observeExecution("ses_plan", "succeeded", "plan-finished")
  assert.equal(executionID, "plan-execution")
  assert.ok(executionID)
  await harness.manager.observeInbox("ses_plan", "msg_user", { type: "user", delivery: "queue" })
  assert.equal(await harness.completeWait("ses_plan", executionID), "")
  assert.equal(await harness.observeStatus("ses_plan", "idle", "plan-idle"), "")

  assert.equal(harness.session().agent, "plan")
  assert.equal(harness.prompts.length, 0)

  await harness.manager.finishInbox("ses_plan", "msg_user")
  assert.equal(await harness.observeStatus("ses_plan", "idle", "plan-idle-after-input"), "Build handoff queued.")
  assert.equal(harness.session().agent, "build")
  assert.deepEqual(harness.session().model, { providerID: "openai", id: "gpt-test", variant: "high" })
  assert.deepEqual(harness.switchedModels, [{ providerID: "openai", id: "gpt-test", variant: "high" }])
  assert.match(harness.prompts[0]!.text, /Inspect, implement, and run the focused checks/)

  await harness.manager.consumeQueuedPrompt("ses_plan", harness.prompts[0]!.text)
  await harness.observeExecution("ses_plan", "started", "build-execution")
  await assert.rejects(harness.manager.report("ses_plan", {
    status: "complete",
    evidence: "The feature works.",
    acceptanceEvidence: [],
  }), /evidence for every acceptance criterion/)
  const complete = await harness.manager.report("ses_plan", {
    status: "complete",
    evidence: "Focused verification passed.",
    acceptanceEvidence: ["The feature passed the focused check."],
  })
  assert.equal(complete.status, "complete")
})

test("native local Build selection stays client-side until the explicit server /goal build command", async () => {
  const harness = fixture("plan")
  await harness.observeExecution("ses_plan", "started", "plan-execution")
  await harness.manager.planReady("ses_plan", {
    objective: "Keep this Plan objective",
    acceptanceCriteria: ["Work is checked"],
    plan: "Make the change then test it.",
  })
  await harness.observeExecution("ses_plan", "succeeded", "plan-execution")
  harness.setLocalAgent("build")
  assert.equal(harness.localAgent(), "build")
  assert.equal(harness.session().agent, "plan")
  assert.equal((await harness.manager.get("ses_plan")).status, "awaiting-build")
  assert.equal(harness.prompts.length, 0)

  const result = await harness.manager.command("ses_plan", "build")
  assert.match(result.text, /Build handoff queued/)
  assert.equal((await harness.manager.get("ses_plan")).status, "active")
  assert.equal((await harness.manager.get("ses_plan")).originalObjective, "Keep this Plan objective")
  assert.equal(harness.session().agent, "build")
  assert.deepEqual(harness.session().model, { providerID: "openai", id: "gpt-test", variant: "high" })
  assert.equal(harness.prompts.length, 1)
  assert.match(harness.prompts[0]!.text, /Make the change then test it/)
  assert.equal(harness.state.waitCalls, 1)
})

test("Manual ready Plan ignores a server Build-selection event until explicit /goal build", async () => {
  const harness = fixture("plan")
  await harness.observeExecution("ses_plan", "started", "plan-execution")
  await harness.manager.planReady("ses_plan", {
    objective: "Run Build only on explicit handoff",
    acceptanceCriteria: ["One Goal prompt is admitted"],
    plan: "Start Build only when requested.",
  })
  await harness.observeExecution("ses_plan", "succeeded", "plan-execution")
  await harness.observeStatus("ses_plan", "idle", "plan-idle")
  harness.setServerAgent("build")

  assert.equal(await harness.manager.agentSelected("ses_plan", "build"), "")
  assert.equal(harness.prompts.length, 0)
  assert.equal((await harness.manager.get("ses_plan")).status, "awaiting-build")

  const handoff = await harness.manager.command("ses_plan", "build")
  assert.match(handoff.text, /Build handoff queued/)
  assert.equal(harness.prompts.length, 1)
})

test("a synchronously consumed prompt still completes the explicit /goal build command", async () => {
  const harness = fixture("plan")
  await harness.observeExecution("ses_plan", "started", "plan-execution")
  await harness.manager.planReady("ses_plan", {
    objective: "Start Build after prompt admission",
    acceptanceCriteria: ["The admitted Build handoff is reported"],
    plan: "Implement and verify the plan.",
  })
  await harness.observeExecution("ses_plan", "succeeded", "plan-execution")
  harness.consumePromptDuringAdmission()

  const result = await harness.manager.command("ses_plan", "build")
  assert.match(result.text, /Build handoff queued/)
  assert.equal(harness.prompts.length, 1)
  assert.deepEqual(harness.admittedPrompts, [{ sessionID: "ses_plan", stale: false }])
  assert.equal((await harness.manager.get("ses_plan")).queuedPrompt, undefined)
})

test("a synchronously consumed Auto continuation is reported as queued exactly once", async () => {
  const harness = fixture()
  await harness.manager.toggleHandoff("ses_goal")
  harness.consumePromptDuringAdmission()
  await harness.manager.command("ses_goal", "Continue after evidence-backed progress")
  assert.equal(harness.prompts.length, 1)

  await harness.observeExecution("ses_goal", "started", "build-execution")
  await harness.manager.report("ses_goal", { status: "progress", evidence: "The first change is implemented." })
  await harness.observeExecution("ses_goal", "succeeded", "build-execution")
  assert.equal(await harness.observeStatus("ses_goal", "idle", "build-idle"), "Goal continuation queued.")
  assert.equal(harness.prompts.length, 2)
  assert.match(harness.prompts[1]!.text, /Continue the active Goal/)
  assert.deepEqual(harness.admittedPrompts, [
    { sessionID: "ses_goal", stale: false },
    { sessionID: "ses_goal", stale: false },
  ])
  assert.equal((await harness.manager.get("ses_goal")).queuedPrompt, undefined)
})

test("synchronously consumed prompts still report cancellation and admission failures", async () => {
  const cancelled = fixture("plan")
  await cancelled.observeExecution("ses_plan", "started", "plan-execution")
  await cancelled.manager.planReady("ses_plan", {
    objective: "Do not report a cancelled handoff",
    acceptanceCriteria: ["Cancellation blocks the Goal"],
    plan: "Implement and verify the plan.",
  })
  await cancelled.observeExecution("ses_plan", "succeeded", "plan-execution")
  cancelled.consumePromptDuringAdmission()
  cancelled.cancelPromptDuringAdmission()
  await assert.rejects(cancelled.manager.command("ses_plan", "build"), /could not be queued/)
  assert.equal(cancelled.prompts.length, 1)
  assert.equal((await cancelled.manager.get("ses_plan")).status, "blocked")
  assert.match((await cancelled.manager.get("ses_plan")).blockedReason!, /cancelled/)

  const failed = fixture("plan")
  await failed.observeExecution("ses_plan", "started", "plan-execution")
  await failed.manager.planReady("ses_plan", {
    objective: "Do not report a failed handoff",
    acceptanceCriteria: ["Failure blocks the Goal"],
    plan: "Implement and verify the plan.",
  })
  await failed.observeExecution("ses_plan", "succeeded", "plan-execution")
  failed.consumePromptDuringAdmission()
  failed.rejectPromptDuringAdmission()
  await assert.rejects(failed.manager.command("ses_plan", "build"), /could not be queued/)
  assert.equal(failed.prompts.length, 1)
  assert.equal((await failed.manager.get("ses_plan")).status, "blocked")
  assert.equal((await failed.manager.get("ses_plan")).pendingAction, undefined)
})

test("Auto uses session.wait after Plan success when no idle event arrives", async () => {
  const harness = fixture("plan")
  await harness.manager.toggleHandoff("ses_plan")
  await harness.observeExecution("ses_plan", "started", "plan-execution")
  await harness.manager.planReady("ses_plan", {
    objective: "Automatically start Build",
    acceptanceCriteria: ["Build begins after Plan succeeds"],
    plan: "Implement the requested change.",
  })

  const executionID = await harness.observeExecution("ses_plan", "succeeded", "plan-finished")
  assert.equal(executionID, "plan-execution")
  assert.ok(executionID)
  assert.equal(harness.session().agent, "plan")
  assert.equal(harness.prompts.length, 0)
  assert.equal(await harness.completeWait("ses_plan", executionID), "Build handoff queued.")
  assert.equal(harness.session().agent, "build")
  assert.deepEqual(harness.session().model, { providerID: "openai", id: "gpt-test", variant: "high" })
  assert.equal(harness.prompts.length, 1)
})

test("switching to Auto after a successful Plan waits and starts Build without an idle event", async () => {
  const harness = fixture("plan")
  await harness.observeExecution("ses_plan", "started", "plan-execution")
  await harness.manager.planReady("ses_plan", {
    objective: "Start Build when Auto is enabled",
    acceptanceCriteria: ["Build starts after explicit Auto selection"],
    plan: "Implement and verify the plan.",
  })
  await harness.observeExecution("ses_plan", "succeeded", "plan-finished")

  assert.equal(await harness.manager.toggleHandoff("ses_plan"), "auto")
  assert.equal(harness.state.waitCalls, 1)
  assert.equal(await harness.manager.driveIdle("ses_plan"), "Build handoff queued.")
  assert.equal(harness.session().agent, "build")
  assert.equal(harness.prompts.length, 1)
})

test("Manual Build refuses to bypass known queued user input", async () => {
  const harness = fixture("plan")
  await harness.observeExecution("ses_plan", "started", "plan-execution")
  await harness.manager.planReady("ses_plan", {
    objective: "Preserve queued user work",
    acceptanceCriteria: ["Queued input runs first"],
    plan: "Wait for the user turn before Build.",
  })
  await harness.observeExecution("ses_plan", "succeeded", "plan-finished")
  await harness.manager.observeInbox("ses_plan", "msg_user", { type: "user", delivery: "queue" })

  await assert.rejects(harness.manager.command("ses_plan", "build"), /queued user input/)
  assert.equal(harness.session().agent, "plan")
  assert.equal(harness.prompts.length, 0)
  assert.equal(harness.state.waitCalls, 0)
})

test("a failed Plan turn cannot start Build or arm Auto handoff", async () => {
  const harness = fixture("plan")
  await harness.manager.toggleHandoff("ses_plan")
  await harness.observeExecution("ses_plan", "started", "plan-execution")
  await harness.manager.planReady("ses_plan", {
    objective: "Do not build an unsuccessful Plan",
    acceptanceCriteria: ["Plan turn must succeed"],
    plan: "This Plan will fail.",
  })

  assert.equal(await harness.observeExecution("ses_plan", "failed", "plan-failed"), undefined)
  assert.equal((await harness.manager.get("ses_plan")).planSucceeded, false)
  await assert.rejects(harness.manager.command("ses_plan", "build"), /successful ready Plan/)
  assert.equal(harness.session().agent, "plan")
  assert.equal(harness.state.waitCalls, 0)
  assert.equal(harness.prompts.length, 0)
})

test("an Auto wait failure blocks handoff but explicit /goal build can retry safely", async () => {
  const harness = fixture("plan")
  await harness.manager.toggleHandoff("ses_plan")
  await harness.observeExecution("ses_plan", "started", "plan-execution")
  await harness.manager.planReady("ses_plan", {
    objective: "Retry a failed idle check",
    acceptanceCriteria: ["Build starts only after confirmed idle"],
    plan: "Complete the requested implementation.",
  })
  const executionID = await harness.observeExecution("ses_plan", "succeeded", "plan-finished")
  assert.ok(executionID)
  harness.state.waitFails = true
  await assert.rejects(harness.waitForIdle("ses_plan"), /wait failed/)
  await harness.manager.observeWaitFailure("ses_plan", executionID)
  assert.equal((await harness.manager.get("ses_plan")).status, "blocked")
  assert.match((await harness.manager.get("ses_plan")).blockedReason!, /\/goal build/)
  assert.equal(harness.prompts.length, 0)

  harness.state.waitFails = false
  assert.match((await harness.manager.command("ses_plan", "build")).text, /Build handoff queued/)
  assert.equal(harness.session().agent, "build")
  assert.equal(harness.prompts.length, 1)
})

test("Goal rejects undispatched progress and rechecks dispatch before automatic continuation", async () => {
  const harness = fixture()
  await harness.manager.command("ses_goal", "Dispatch all work")
  await harness.manager.consumeQueuedPrompt("ses_goal", harness.prompts[0]!.text)
  await harness.observeExecution("ses_goal", "started", "build-dispatch")
  harness.state.dispatchError = "Todo dispatch required: 2 unbound actionable Todos, 10 free slots"
  await assert.rejects(harness.manager.report("ses_goal", { status: "progress", evidence: "plan done" }), /Todo dispatch required/)
  assert.equal((await harness.manager.get("ses_goal")).pendingAction, undefined)
  harness.state.dispatchError = undefined
  await harness.manager.report("ses_goal", { status: "progress", evidence: "all dispatched" })
  harness.state.dispatchError = "Todo dispatch required: new unbound Todo after progress"
  await harness.observeExecution("ses_goal", "succeeded", "build-dispatch")
  assert.equal(await harness.observeStatus("ses_goal", "idle", "dispatch-idle"), "")
  assert.equal(harness.prompts.length, 1)
  assert.equal((await harness.manager.get("ses_goal")).status, "blocked")
  assert.match((await harness.manager.get("ses_goal")).blockedReason!, /new unbound Todo/)
})

test("Auto recovers a transient dispatch blocker on the next observed idle", async () => {
  const harness = fixture()
  await harness.manager.command("ses_goal", "Recover from a transient dispatch blocker")
  await harness.manager.consumeQueuedPrompt("ses_goal", harness.prompts[0]!.text)
  await harness.manager.toggleHandoff("ses_goal")
  await harness.observeExecution("ses_goal", "started", "transient-build")
  await harness.manager.report("ses_goal", { status: "progress", evidence: "The implementation advanced." })
  harness.state.dispatchError = "Todo dispatch required: 1 unbound actionable Todo, 10 free slots"
  await harness.observeExecution("ses_goal", "succeeded", "transient-build")

  assert.equal(await harness.observeStatus("ses_goal", "idle", "transient-idle-1"), "")
  assert.equal((await harness.manager.get("ses_goal")).status, "blocked")
  assert.match((await harness.manager.get("ses_goal")).blockedReason!, /Todo dispatch required/)
  assert.equal(harness.prompts.length, 1)

  harness.state.dispatchError = undefined
  assert.equal(await harness.observeStatus("ses_goal", "idle", "transient-idle-2"), "Goal continuation queued.")
  assert.equal(harness.prompts.length, 2)
  assert.equal((await harness.manager.get("ses_goal")).status, "active")
})

test("Auto recovery exhausts its bounded budget and then stays blocked", async () => {
  const harness = fixture()
  await harness.manager.command("ses_goal", "Bound the automatic retry budget")
  await harness.manager.consumeQueuedPrompt("ses_goal", harness.prompts[0]!.text)
  await harness.manager.toggleHandoff("ses_goal")
  await harness.observeExecution("ses_goal", "started", "budget-build")
  await harness.manager.report("ses_goal", { status: "progress", evidence: "Progress before a persistent dispatch failure." })
  harness.state.dispatchError = "Todo dispatch required: 3 unbound actionable Todos"
  await harness.observeExecution("ses_goal", "succeeded", "budget-build")

  for (let index = 0; index < 5; index++) {
    assert.equal(await harness.observeStatus("ses_goal", "idle", `budget-idle-${index}`), "")
  }
  const goal = await harness.manager.get("ses_goal")
  assert.equal(harness.prompts.length, 1, "a permanently failing preflight must never queue a continuation")
  assert.equal(goal.status, "blocked")
  assert.match(goal.blockedReason!, /\/goal resume/)
  assert.doesNotMatch(goal.blockedReason!, /Todo dispatch required/)
})

test("Auto never recovers a permanent operator-action blocker", async () => {
  const harness = fixture()
  await harness.manager.command("ses_goal", "Stay blocked on operator action")
  await harness.manager.consumeQueuedPrompt("ses_goal", harness.prompts[0]!.text)
  await harness.manager.toggleHandoff("ses_goal")
  await harness.observeExecution("ses_goal", "started", "permanent-build")
  await harness.manager.report("ses_goal", { status: "blocked", evidence: "Missing operator approval for the production credential." })

  assert.equal(await harness.observeStatus("ses_goal", "idle", "permanent-idle"), "")
  assert.equal(harness.prompts.length, 1)
  assert.equal((await harness.manager.get("ses_goal")).status, "blocked")
  assert.match((await harness.manager.get("ses_goal")).blockedReason!, /Missing operator approval/)
})

test("Manual handoff never auto-recovers a transiently blocked Goal", async () => {
  const harness = fixture()
  await harness.manager.command("ses_goal", "Manual handoff stays manual")
  await harness.manager.consumeQueuedPrompt("ses_goal", harness.prompts[0]!.text)
  await harness.observeExecution("ses_goal", "started", "manual-build")
  await harness.manager.report("ses_goal", { status: "progress", evidence: "Manual progress." })
  harness.state.dispatchError = "Todo dispatch required: 1 unbound actionable Todo"
  await harness.observeExecution("ses_goal", "succeeded", "manual-build")

  await harness.observeStatus("ses_goal", "idle", "manual-idle-1")
  assert.equal((await harness.manager.get("ses_goal")).status, "blocked")
  assert.equal(await harness.observeStatus("ses_goal", "idle", "manual-idle-2"), "")
  assert.equal(harness.prompts.length, 1)
  assert.equal((await harness.manager.get("ses_goal")).status, "blocked")
})

test("only successful evidence-backed progress continues, and blocked Goals can resume", async () => {
  const harness = fixture()
  await harness.manager.command("ses_goal", "Make measurable progress")
  await harness.manager.consumeQueuedPrompt("ses_goal", harness.prompts[0]!.text)

  await harness.observeExecution("ses_goal", "started", "failed-build")
  await assert.rejects(harness.manager.report("ses_goal", { status: "done", evidence: "Not a supported status." } as never), /status must be/)
  await harness.manager.report("ses_goal", { status: "progress", evidence: "Updated the implementation." })
  await harness.observeExecution("ses_goal", "failed", "failed-build")
  assert.equal(await harness.observeStatus("ses_goal", "idle", "failed-idle"), "")
  assert.equal(harness.prompts.length, 1)

  await harness.observeExecution("ses_goal", "started", "blocked-build")
  await harness.manager.report("ses_goal", { status: "blocked", evidence: "A required dependency is unavailable." })
  assert.equal((await harness.manager.get("ses_goal")).status, "blocked")
  await harness.observeStatus("ses_goal", "idle", "blocked-idle")
  await harness.manager.command("ses_goal", "resume")
  assert.equal(harness.prompts.length, 2)
  assert.match(harness.prompts[1]!.text, /Resume the active Goal/)

  await harness.manager.consumeQueuedPrompt("ses_goal", harness.prompts[1]!.text)
  harness.state.taskIncomplete = true
  await harness.observeExecution("ses_goal", "started", "completion-build")
  await assert.rejects(harness.manager.report("ses_goal", {
    status: "complete",
    evidence: "All work is done.",
  }), /task_complete/)
  assert.equal((await harness.manager.get("ses_goal")).status, "active")
  harness.state.taskIncomplete = false
  await harness.manager.report("ses_goal", { status: "progress", evidence: "Verified one more change." })
  await harness.observeExecution("ses_goal", "succeeded", "completion-build")
  await harness.manager.observeInbox("ses_goal", "msg_user", { type: "user", delivery: "queue" })
  assert.equal(await harness.observeStatus("ses_goal", "idle", "completion-idle"), "")
  assert.equal(harness.prompts.length, 2)
  await harness.manager.finishInbox("ses_goal", "msg_user")
  assert.equal(await harness.observeStatus("ses_goal", "idle", "completion-idle-after-input"), "Goal continuation queued.")
  assert.equal(harness.prompts.length, 3)
})

test("plan readiness rejects nested or non-Plan sessions", () => {
  assert.throws(() => assertPlanParent({ agent: "build" }), /top-level Plan/)
  assert.throws(() => assertPlanParent({ agent: "plan", parentID: "ses_parent" }), /top-level Plan/)
  assert.doesNotThrow(() => assertPlanParent({ agent: "plan" }))
})

test("corrupt persisted Goal state fails closed on inconsistent flags and prompt markers", async () => {
  const base = {
    version: 1,
    sessionID: "ses_goal",
    revision: 1,
    handoff: "manual",
    status: "active",
    originalObjective: "Keep the saved objective",
    acceptanceCriteria: [],
    planReady: false,
    planSucceeded: false,
    firstBuildPromptSent: false,
  }
  for (const corrupt of [
    { ...base, planSucceeded: true },
    { ...base, pendingAction: { kind: "progress", executionID: "execution" } },
    { ...base, queuedPrompt: { token: "123e4567-e89b-12d3-a456-426614174000", kind: "invalid" } },
    { ...base, queuedPrompt: { token: "123e4567-e89b-12d3-a456-426614174000", kind: "start", consumed: "true" } },
    { ...base, status: "blocked", blockedReason: "A transient blocker.", blockedRetry: { kind: "continue", attempts: 99 } },
    { ...base, blockedRetry: { kind: "bogus", attempts: 1 } },
  ]) {
    const harness = fixture("build", new Map([["goal/session/ses_goal", corrupt]]))
    assert.equal((await harness.manager.get("ses_goal")).status, "corrupt")
  }
})

test("the real Goal RPC wiring steers a ready Plan handoff without dropping its marker", async () => {
  const sessionID = "ses_plan"
  const state = new Map<string, unknown>([[`goal/session/${sessionID}`, {
    version: 1,
    sessionID,
    revision: 1,
    handoff: "manual",
    status: "awaiting-build",
    originalObjective: "Run one Build turn after Plan",
    acceptanceCriteria: ["The Goal handoff is admitted once"],
    plan: "Implement and verify the ready Plan.",
    source: "plan",
    planReady: true,
    planExecutionID: "plan-execution",
    planSucceeded: true,
    firstBuildPromptSent: false,
  }]])
  const admitted: { sessionID: string; text: string; delivery?: string }[] = []
  let agent = "plan"
  let model = { providerID: "openai", id: "gpt-test", variant: "high" }
  let methods: {
    command(input: { sessionID: string; command: string }, context: { signal: AbortSignal }): Promise<{ text: string }>
    state(input: { sessionID: string }, context: unknown): Promise<{ status: string; handoff: "manual" | "auto"; objective?: string }>
  } | undefined

  const context = {
    options: {},
    location: { project: { id: "project", canonical: REPOSITORY_ROOT } },
    storage: {
      get: async (key: string) => structuredClone(state.get(key)),
      set: async (key: string, value: unknown) => { state.set(key, structuredClone(value)) },
    },
    agent: { get: async () => ({ data: { model: { providerID: "build-provider", id: "build-default" } } }) },
    session: {
      get: async ({ sessionID: id }: { sessionID: string }) => ({ id, projectID: "project", agent, model }),
      wait: async () => {},
      switchAgent: async ({ agent: next }: { agent: string }) => { agent = next },
      switchModel: async ({ model: next }: { model: typeof model }) => { model = next },
      prompt: async (input: { sessionID: string; text: string; delivery?: string }) => {
        admitted.push(input)
        return { id: "msg_goal" }
      },
      hook: async () => {},
    },
    tool: {
      hook: async () => {},
      transform: async (register: (editor: { add(): void }) => void) => { register({ add: () => {} }) },
    },
    permission: { hook: async () => {} },
    rpc: Object.assign(() => ({ checkTaskCompletion: async () => ({ enabled: true, ready: true, required: 0, receipted: 0, missingObligationIDs: [], conflictObligationIDs: [], unresolvedConflictIDs: [] }) }), {
      register: async (_definition: unknown, handlers: unknown) => {
        methods = handlers as typeof methods
        return { dispose: async () => {} }
      },
    }),
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
  } as unknown as Parameters<typeof orchestrationPolicy.setup>[0]

  const cleanup = await orchestrationPolicy.setup(context)
  assert.ok(methods)
  try {
    assert.deepEqual(await methods.state({ sessionID }, {}), {
      status: "awaiting-build",
      handoff: "manual",
      objective: "Run one Build turn after Plan",
    })
    const result = await methods.command({ sessionID, command: "build" }, { signal: new AbortController().signal })
    assert.match(result.text, /Build handoff queued/)
    assert.equal(agent, "build")
    assert.equal(admitted.length, 1)
    assert.equal(admitted[0]!.delivery, "steer")
    assert.match(admitted[0]!.text, /^<open-rig-goal-prompt token=[0-9a-f-]{36}>\n/)
    assert.match(admitted[0]!.text, /Run one Build turn after Plan/)
  } finally {
    await cleanup?.()
  }
})

test("Auto Build hides and rejects question live without affecting Manual, Plan, stale, or other-project sessions", async () => {
  const memoryDirectory = await mkdtemp(join(tmpdir(), "orchestration-question-memory-"))
  await writeFile(join(memoryDirectory, "decision.md"), [
    "---",
    "title: Bound decision",
    "type: decision",
    "permalink: computer-assistant/decisions/question-test",
    "tags:",
    "  - open-rig",
    "---",
    "A durable repository decision.",
    "",
  ].join("\n"))
  const sessionID = "ses_questionguard"
  const otherID = "ses_manualother"
  const crossProjectID = "ses_crossproject"
  const staleID = "ses_stalequestion"
  const invalidID = "ses_invalidquestion"
  const unreadableID = "ses_unreadablequestion"
  const autoGoal = (id: string) => ({
    version: 1,
    sessionID: id,
    revision: 1,
    handoff: "auto",
    status: "active",
    originalObjective: "Keep the active Goal",
    acceptanceCriteria: [],
    source: "manual",
    planReady: false,
    planSucceeded: false,
    firstBuildPromptSent: true,
  })
  const state = new Map<string, unknown>([
    [`goal/session/${sessionID}`, autoGoal(sessionID)],
    [`goal/session/${crossProjectID}`, autoGoal(crossProjectID)],
    [`goal/session/${staleID}`, autoGoal(staleID)],
    [`goal/session/${invalidID}`, { version: 1, sessionID: invalidID, handoff: "auto" }],
  ])
  const unreadableGoalIDs = new Set([unreadableID])
  const sessions = new Map<string, { id: string; projectID: string; agent: string; parentID?: string }>([
    [sessionID, { id: sessionID, projectID: "project", agent: "build" }],
    [otherID, { id: otherID, projectID: "project", agent: "build" }],
    [crossProjectID, { id: crossProjectID, projectID: "another-project", agent: "build" }],
    [invalidID, { id: invalidID, projectID: "project", agent: "build" }],
    [unreadableID, { id: unreadableID, projectID: "project", agent: "build" }],
  ])
  const sessionHooks = new Map<string, (event: any) => Promise<void> | void>()
  const toolHooks = new Map<string, (event: any) => Promise<void> | void>()
  const permissionHooks = new Map<string, (event: any) => Promise<void> | void>()
  const registeredTools = new Map<string, { execute: (input: unknown, context: { sessionID: string }) => Promise<unknown> }>()
  const rpcHandlers: Record<string, (...args: any[]) => Promise<any>> = {}
  const context = {
    options: { memoryProject: "computer-assistant", memoryDirectory, memoryBindings: ["open-rig"] },
    location: { project: { id: "project", canonical: REPOSITORY_ROOT } },
    storage: {
      get: async (key: string) => {
        const goalSessionID = key.startsWith("goal/session/") ? key.slice("goal/session/".length) : undefined
        if (goalSessionID && unreadableGoalIDs.has(goalSessionID)) throw new Error("Goal state unavailable")
        return structuredClone(state.get(key))
      },
      set: async (key: string, value: unknown) => { state.set(key, structuredClone(value)) },
    },
    agent: { get: async () => ({ data: { model: { providerID: "build-provider", id: "build-default" } } }) },
    session: {
      get: async ({ sessionID: id }: { sessionID: string }) => {
        const current = sessions.get(id)
        if (!current) throw new Error("session is stale")
        return current
      },
      wait: async () => {},
      switchAgent: async ({ sessionID: id, agent }: { sessionID: string; agent: string }) => {
        const current = sessions.get(id)
        if (current) current.agent = agent
      },
      switchModel: async () => {},
      prompt: async () => ({ id: "msg_goal" }),
      hook: async (name: string, callback: (event: any) => Promise<void> | void) => {
        sessionHooks.set(name, callback)
        return { dispose: async () => {} }
      },
    },
    permission: {
      hook: async (name: string, callback: (event: any) => Promise<void> | void) => {
        permissionHooks.set(name, callback)
        return { dispose: async () => {} }
      },
    },
    tool: {
      hook: async (name: string, callback: (event: any) => Promise<void> | void) => {
        toolHooks.set(name, callback)
        return { dispose: async () => {} }
      },
      transform: async (register: (editor: { add(definition: { name: string; execute?: unknown }): void }) => void) => {
        register({
          add: (definition) => {
            if (typeof definition.execute === "function") {
              registeredTools.set(definition.name, definition as { execute: (input: unknown, context: { sessionID: string }) => Promise<unknown> })
            }
          },
        })
      },
    },
    rpc: Object.assign(() => ({ checkTaskCompletion: async () => ({ enabled: true, ready: true, required: 0, receipted: 0, missingObligationIDs: [], conflictObligationIDs: [], unresolvedConflictIDs: [] }) }), {
      register: async (_definition: unknown, handlers: unknown) => {
        Object.assign(rpcHandlers, handlers)
        return { dispose: async () => {} }
      },
    }),
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
  } as unknown as Parameters<typeof orchestrationPolicy.setup>[0]

  const cleanup = await orchestrationPolicy.setup(context)
  const runContext = sessionHooks.get("context")!
  const runBefore = toolHooks.get("execute.before")!
  const runAfter = toolHooks.get("execute.after")!
  const runPermission = permissionHooks.get("evaluate")!
  const request = (id: string, agent: string) => ({
    sessionID: id,
    agent,
    model: { providerID: "test", id: "test-model" },
    messages: [],
    system: [],
    options: {},
    tools: { question: { description: "Ask the operator", input: {} }, read: { description: "Read", input: {} } },
  })
  const call = (tool: string, id: string, code?: string) => ({
    tool,
    id,
    sessionID: id === "" ? "" : sessionID,
    agent: "build",
    messageID: "msg_question",
    input: code === undefined ? {} : { code },
  })
  const invoke = async (tool: string, id: string, code?: string) => {
    const input = call(tool, id, code)
    await runBefore(input)
    await runAfter({ ...input, status: "completed", result: { content: "Operator response" } })
  }
  const evaluateQuestion = async (id: string, agent = "build", sourceID = "question") => {
    const event = {
      sessionID: id,
      agent,
      action: "question",
      resources: ["*"],
      effect: "ask",
      source: { type: "tool", messageID: "msg_question", id: sourceID },
    }
    await runPermission(event)
    return event
  }

  try {
    const automatic = request(sessionID, "build")
    await runContext(automatic)
    assert.equal("question" in automatic.tools, false)
    assert.match(automatic.system.map((part: { text?: string }) => part.text ?? "").join("\n"), /switch handoff to Manual/)

    const direct = call("question", "blocked-direct")
    await assert.rejects(async () => runBefore(direct), /question tool is unavailable/)
    await runAfter({ ...direct, status: "error", error: { message: "policy blocked question" } })
    assert.equal(state.has("tool-error/state"), false)
    assert.equal((await evaluateQuestion(sessionID)).effect, "deny")
    assert.equal((await evaluateQuestion(sessionID, "plan")).effect, "deny")

    // V2 checks each nested Code Mode tool by action, independent of source syntax.
    for (const [sourceID, code] of [
      ["literal-code-mode", "return tools.question({})"],
      ["aliased-code-mode", "const ask = tools.question; return ask({})"],
      ["computed-code-mode", 'const name = "question"; return tools[name]({})'],
    ]) {
      const codeMode = call("execute", `blocked-${sourceID}`, code)
      await runBefore(codeMode)
      await runAfter({ ...codeMode, status: "completed", result: { content: "Nested call is permission-checked" } })
      assert.equal((await evaluateQuestion(sessionID, "build", sourceID)).effect, "deny", sourceID)
    }
    const reconcile = registeredTools.get("rule_reconciliation")!
    await assert.rejects(async () => reconcile.execute({
      outcome: "resolved",
      conflicts: ["The durable decision needs an operator answer."],
      resolution: "Unapproved answer.",
    }, { sessionID }), /question tool/)

    const toggle = rpcHandlers.toggleHandoff!
    assert.deepEqual(await toggle({ sessionID }, { signal: new AbortController().signal }), {
      handoff: "manual", status: "active", objective: "Keep the active Goal",
    })
    const manual = request(sessionID, "build")
    await runContext(manual)
    assert.equal("question" in manual.tools, true)
    assert.equal((await evaluateQuestion(sessionID)).effect, "ask")
    await invoke("question", "manual-direct")
    await invoke("execute", "manual-code-mode", "return tools.question({})")
    assert.equal((await evaluateQuestion(sessionID, "build", "manual-code-mode")).effect, "ask")
    await reconcile.execute({
      outcome: "resolved",
      conflicts: ["The durable decision needs an operator answer."],
      resolution: "The operator confirmed the repository decision.",
    }, { sessionID })

    assert.deepEqual(await toggle({ sessionID }, { signal: new AbortController().signal }), {
      handoff: "auto", status: "active", objective: "Keep the active Goal",
    })
    const automaticAgain = request(sessionID, "build")
    await runContext(automaticAgain)
    assert.equal("question" in automaticAgain.tools, false)
    await assert.rejects(async () => runBefore(call("question", "blocked-after-toggle")), /question tool is unavailable/)
    assert.equal((await evaluateQuestion(sessionID)).effect, "deny")

    sessions.get(sessionID)!.agent = "plan"
    const plan = request(sessionID, "plan")
    await runContext(plan)
    assert.equal("question" in plan.tools, true)
    assert.equal((await evaluateQuestion(sessionID, "build")).effect, "ask")
    await invoke("question", "plan-question")

    const sameProjectOtherSession = request(otherID, "build")
    await runContext(sameProjectOtherSession)
    assert.equal("question" in sameProjectOtherSession.tools, true)
    assert.equal((await evaluateQuestion(otherID)).effect, "ask")
    await invoke("question", "other-session-question")

    const crossProject = request(crossProjectID, "build")
    await runContext(crossProject)
    assert.equal("question" in crossProject.tools, true)
    assert.equal((await evaluateQuestion(crossProjectID)).effect, "ask")
    const crossCall = { ...call("question", "cross-project-question"), sessionID: crossProjectID }
    await runBefore(crossCall)

    const stale = request(staleID, "build")
    await runContext(stale)
    assert.equal("question" in stale.tools, true)
    assert.equal((await evaluateQuestion(staleID)).effect, "ask")
    const staleCall = { ...call("question", "stale-question"), sessionID: staleID }
    await runBefore(staleCall)

    const invalid = request(invalidID, "build")
    await runContext(invalid)
    assert.equal("question" in invalid.tools, false)
    const invalidPermission = await evaluateQuestion(invalidID)
    assert.equal(invalidPermission.effect, "deny")

    const unreadablePermission = await evaluateQuestion(unreadableID)
    assert.equal(unreadablePermission.effect, "deny")
    await assert.rejects(async () => runBefore({ ...call("question", "unreadable-direct"), sessionID: unreadableID }), /question tool is unavailable/)
  } finally {
    await cleanup?.()
    await rm(memoryDirectory, { recursive: true, force: true })
  }
})

// Drives the real orchestration plugin through its event stream so the bounded,
// eligible-only startup recovery is exercised end to end (not just the manager
// method): the scan filter, the authoritative session wait, and the handoff.
function restartRecoveryHarness(
  goals: ReadonlyArray<Record<string, unknown>>,
  sessions: ReadonlyMap<string, Record<string, unknown>>,
  // Durable inbox items already queued before this plugin runtime subscribed.
  // The plugin session domain cannot list them and `server.connected` carries no
  // snapshot, so the harness only keeps them to document the unprovable state.
  preExistingInbox: ReadonlyArray<{ inboxID: string; item: { type: string; delivery: string } }> = [],
) {
  const state = new Map<string, unknown>(goals.map((goal) => [`goal/session/${goal.sessionID}`, goal]))
  const live = new Map<string, Record<string, unknown>>(
    [...sessions].map(([id, session]) => [id, structuredClone(session)]),
  )
  const prompts: { sessionID: string; text: string; delivery?: string }[] = []
  const events: unknown[] = []
  const gates: { resolve: () => void; reject: (error: unknown) => void }[] = []
  const counts = { scans: 0, scanned: 0, waits: 0 }
  let wake: (() => void) | undefined
  const push = (event: unknown) => { events.push(event); wake?.(); wake = undefined }

  const context = {
    options: {},
    location: { project: { id: "project", canonical: REPOSITORY_ROOT } },
    storage: {
      get: async (key: string) => structuredClone(state.get(key)),
      set: async (key: string, value: unknown) => { state.set(key, structuredClone(value)) },
      remove: async (key: string) => { state.delete(key) },
      scan: async ({ prefix, after, limit }: { prefix: string; after?: string; limit?: number }) => {
        counts.scans++
        const sorted = [...state.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .sort(([a], [b]) => a.localeCompare(b))
        const start = after ? sorted.findIndex(([key]) => key > after) : 0
        const bounded = Math.max(0, Math.min(limit ?? 64, sorted.length - Math.max(0, start)))
        const entries = sorted.slice(Math.max(0, start), Math.max(0, start) + bounded)
          .map(([key, value]) => ({ key, value: structuredClone(value) }))
        counts.scanned += entries.length
        const next = entries.length && (Math.max(0, start) + entries.length) < sorted.length ? entries[entries.length - 1]!.key : undefined
        return { entries, ...(next ? { next } : {}) }
      },
    },
    agent: { get: async () => ({ data: { model: { providerID: "build-provider", id: "build-default" } } }) },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        const current = live.get(sessionID)
        if (!current) throw new Error("session is stale")
        return current
      },
      wait: async () => {
        counts.waits++
        return new Promise<void>((resolve, reject) => { gates.push({ resolve, reject }) })
      },
      switchAgent: async ({ sessionID, agent }: { sessionID: string; agent: string }) => {
        const current = live.get(sessionID)
        if (current) current.agent = agent
      },
      switchModel: async () => {},
      prompt: async (input: { sessionID: string; text: string; delivery?: string }) => {
        prompts.push(input)
        return { id: `msg_recovery_${prompts.length}` }
      },
      hook: async () => ({ dispose: async () => {} }),
    },
    permission: { hook: async () => ({ dispose: async () => {} }) },
    tool: {
      hook: async () => ({ dispose: async () => {} }),
      transform: async (register: (editor: { add(): void }) => void) => { register({ add: () => {} }) },
    },
    rpc: Object.assign(
      () => ({ checkTaskCompletion: async () => ({ enabled: true, ready: true, required: 0, receipted: 0, missingObligationIDs: [], conflictObligationIDs: [], unresolvedConflictIDs: [] }) }),
      { register: async () => ({ dispose: async () => {} }) },
    ),
    event: {
      subscribe: ({ signal }: { signal?: AbortSignal } = {}) => ({
        [Symbol.asyncIterator]: () => ({
          async next() {
            while (!events.length) {
              if (signal?.aborted) return { done: true, value: undefined }
              await new Promise<void>((resolve) => {
                wake = resolve
                signal?.addEventListener("abort", () => resolve(), { once: true })
              })
              wake = undefined
            }
            return { done: false, value: events.shift() }
          },
          async return() { return { done: true, value: undefined } },
        }),
      }),
    },
  } as unknown as Parameters<typeof orchestrationPolicy.setup>[0]

  return {
    context,
    push,
    prompts,
    counts,
    preExistingInbox,
    seed: (goal: Record<string, unknown>) => { state.set(`goal/session/${goal.sessionID}`, structuredClone(goal)) },
    session: (sessionID: string) => live.get(sessionID)!,
    goalState: (sessionID: string) => state.get(`goal/session/${sessionID}`) as {
      status?: string
      blockedReason?: string
      firstBuildPromptSent?: boolean
    },
    resolveWait: () => gates.shift()?.resolve(),
    rejectWait: (error: unknown) => gates.shift()?.reject(error),
    pendingWaits: () => gates.length,
  }
}

async function until(condition: () => boolean, message: string, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`)
    await new Promise<void>((resolve) => { setTimeout(resolve, 5) })
  }
}

function readyAutoPlan(sessionID: string, overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    sessionID,
    revision: 3,
    handoff: "auto",
    status: "awaiting-build",
    originalObjective: "Hand off after a restart",
    acceptanceCriteria: ["Build runs once"],
    plan: "Implement and verify the plan.",
    source: "plan",
    planReady: true,
    planExecutionID: "plan-execution",
    planSucceeded: true,
    firstBuildPromptSent: false,
    ...overrides,
  }
}

function planSession(sessionID: string, overrides: Record<string, unknown> = {}) {
  return {
    id: sessionID,
    projectID: "project",
    agent: "plan",
    model: { providerID: "plan-provider", id: "plan-default" },
    ...overrides,
  }
}

test("startup recovery eligibility is the strict Auto ready Plan set", () => {
  assert.equal(recoverableStoredGoal(readyAutoPlan("ses_eligibility"), "ses_eligibility"), true)
  for (const [label, override] of [
    ["Manual handoff", { handoff: "manual" }],
    ["blocked status", { status: "blocked", blockedReason: "Operator paused." }],
    ["blocked with auto-retry budget", { status: "blocked", blockedReason: "Transient dispatch failure.", blockedRetry: { kind: "continue", attempts: 1 } }],
    ["active status", { status: "active" }],
    ["complete status", { status: "complete", completionEvidence: ["done"] }],
    ["already handed off", { firstBuildPromptSent: true }],
    ["unsuccessful Plan", { planSucceeded: false }],
    ["missing plan execution", { planExecutionID: undefined }],
  ] as const) {
    assert.equal(
      recoverableStoredGoal(readyAutoPlan("ses_eligibility", override as Record<string, unknown>), "ses_eligibility"),
      false,
      label,
    )
  }
  assert.equal(recoverableStoredGoal(undefined, "ses_eligibility"), false)
  assert.equal(recoverableStoredGoal({ garbage: true }, "ses_eligibility"), false)
})

test("startup recovery fails closed for one eligible Auto Plan and skips Manual, blocked, complete, and handed-off Goals", async () => {
  const eligible = "ses_recovereligible"
  const manual = "ses_recovermanual"
  const blocked = "ses_recoverblocked"
  const complete = "ses_recovercomplete"
  const handed = "ses_recoverhanded"
  const harness = restartRecoveryHarness(
    [
      readyAutoPlan(eligible),
      readyAutoPlan(manual, { handoff: "manual" }),
      readyAutoPlan(blocked, { status: "blocked", blockedReason: "Operator paused." }),
      readyAutoPlan(complete, { status: "complete", completionEvidence: ["done"] }),
      readyAutoPlan(handed, { firstBuildPromptSent: true }),
    ],
    new Map([
      [eligible, planSession(eligible)],
      [manual, planSession(manual)],
      [blocked, planSession(blocked)],
      [complete, planSession(complete)],
      [handed, planSession(handed)],
    ]),
  )
  const cleanup = await orchestrationPolicy.setup(harness.context)
  try {
    harness.push({ type: "server.connected", id: "evt-connected", data: {} })
    await until(() => harness.counts.waits >= 1, "the one eligible authoritative wait")
    // Only the genuinely-eligible Auto Plan may hold a wait; the ineligible
    // records are filtered before any wait is opened.
    assert.equal(harness.counts.waits, 1)
    assert.equal(harness.counts.scanned, 5)
    assert.equal(harness.prompts.length, 0)
    assert.equal(harness.session(eligible).agent, "plan")

    // The confirmed idle cannot prove the durable inbox is empty, so the restart
    // handoff fails closed instead of switching Build or queueing a prompt.
    harness.resolveWait()
    await until(() => harness.goalState(eligible).status === "blocked", "the fail-closed eligible Goal")
    assert.equal(harness.prompts.length, 0)
    assert.equal(harness.session(eligible).agent, "plan")
    assert.equal(harness.goalState(eligible).firstBuildPromptSent, false)
    assert.match(harness.goalState(eligible).blockedReason!, /queued user input/)
    assert.equal(harness.session(manual).agent, "plan")
    assert.equal(harness.goalState(manual).status, "awaiting-build")
    assert.equal(harness.session(blocked).agent, "plan")
    assert.equal(harness.goalState(blocked).status, "blocked")

    // A repeated connection and a later idle status must neither hand off nor
    // undo the fail-closed block.
    harness.push({ type: "server.connected", id: "evt-connected-2", data: {} })
    harness.push({ type: "session.status", id: "evt-idle", data: { sessionID: eligible, status: { type: "idle" } } })
    await new Promise<void>((resolve) => { setTimeout(resolve, 50) })
    assert.equal(harness.prompts.length, 0)
    assert.equal(harness.goalState(eligible).status, "blocked")
  } finally {
    await cleanup?.()
  }
})

test("startup recovery bounds the number of concurrent eligible waits", async () => {
  const ids = Array.from({ length: 7 }, (_, index) => `ses_bound${index}`)
  const harness = restartRecoveryHarness(
    ids.map((id) => readyAutoPlan(id)),
    new Map(ids.map((id) => [id, planSession(id)])),
  )
  const cleanup = await orchestrationPolicy.setup(harness.context)
  try {
    harness.push({ type: "server.connected", id: "evt-connected", data: {} })
    await until(() => harness.pendingWaits() >= 4, "the bounded wait set")
    await new Promise<void>((resolve) => { setTimeout(resolve, 50) })
    assert.equal(harness.counts.waits, 4)
    assert.equal(harness.prompts.length, 0)
  } finally {
    await cleanup?.()
  }
})

test("startup recovery stays fail-closed while the authoritative idle wait is pending or fails, even with stale succeeded idle fields", async () => {
  const sessionID = "ses_recoverrunning"
  const harness = restartRecoveryHarness(
    [readyAutoPlan(sessionID)],
    // SessionInfo can still record the previous turn's terminal transition while
    // the session is actively running; those fields are not a current-idle proof.
    new Map([[sessionID, planSession(sessionID, { outcome: "succeeded", time: { idle: 999 } })]]),
  )
  const cleanup = await orchestrationPolicy.setup(harness.context)
  try {
    harness.push({ type: "server.connected", id: "evt-connected", data: {} })
    await until(() => harness.counts.waits >= 1, "the authoritative wait")
    await new Promise<void>((resolve) => { setTimeout(resolve, 30) })
    assert.equal(harness.prompts.length, 0, "a running session must not receive a Build handoff")
    assert.equal(harness.session(sessionID).agent, "plan")
    assert.equal(harness.goalState(sessionID).status, "awaiting-build")

    harness.rejectWait(new Error("wait failed"))
    await new Promise<void>((resolve) => { setTimeout(resolve, 50) })
    assert.equal(harness.prompts.length, 0)
    assert.equal(harness.session(sessionID).agent, "plan")
    assert.equal(harness.goalState(sessionID).status, "awaiting-build")
    assert.equal(harness.goalState(sessionID).firstBuildPromptSent, false)
  } finally {
    await cleanup?.()
  }
})

test("startup recovery fails closed after the authoritative wait resolves idle", async () => {
  const sessionID = "ses_recoverconfirm"
  const harness = restartRecoveryHarness(
    [readyAutoPlan(sessionID)],
    new Map([[sessionID, planSession(sessionID, { outcome: "succeeded", time: { idle: 42 } })]]),
  )
  const cleanup = await orchestrationPolicy.setup(harness.context)
  try {
    harness.push({ type: "server.connected", id: "evt-connected", data: {} })
    await until(() => harness.counts.waits >= 1, "the authoritative wait")
    assert.equal(harness.prompts.length, 0)
    harness.resolveWait()
    await until(() => harness.goalState(sessionID).status === "blocked", "the fail-closed Goal after confirmed idle")
    assert.equal(harness.session(sessionID).agent, "plan")
    assert.equal(harness.goalState(sessionID).firstBuildPromptSent, false)
    assert.equal(harness.prompts.length, 0)
  } finally {
    await cleanup?.()
  }
})

test("restart inbox race fails closed while the scan and wait are still pending and leaves same-runtime Auto intact", async () => {
  const restarted = "ses_racepersisted"
  const live = "ses_racelive"
  const harness = restartRecoveryHarness(
    [readyAutoPlan(restarted)],
    new Map([
      [restarted, planSession(restarted)],
      [live, planSession(live)],
    ]),
    // A user item already queued before this runtime subscribed: the plugin
    // session domain cannot list it and `server.connected` carries no snapshot,
    // so `isQueuedUser` can never see it.
    [{ inboxID: "msg_preexisting", item: { type: "user", delivery: "queue" } }],
  )
  const cleanup = await orchestrationPolicy.setup(harness.context)
  try {
    assert.equal(harness.preExistingInbox.length, 1)
    // The restart race: `server.connected` starts the bounded scan and its
    // authoritative wait, but a status idle event for the persisted Goal is
    // processed before either settles.
    harness.push({ type: "server.connected", id: "evt-connected", data: {} })
    harness.push({
      type: "session.status",
      id: "evt-restart-idle",
      data: { sessionID: restarted, status: { type: "idle" } },
    })
    await until(() => harness.counts.waits >= 1, "the persisted authoritative wait")
    await new Promise<void>((resolve) => { setTimeout(resolve, 50) })
    // No live handler may switch the persisted Goal to Build or queue its
    // prompt ahead of the unverifiable user item.
    assert.equal(harness.prompts.length, 0, "the restart idle event must not queue a Goal prompt")
    assert.equal(harness.session(restarted).agent, "plan", "the queued user item keeps its Plan agent")
    assert.equal(harness.goalState(restarted).firstBuildPromptSent, false)

    // Once the authoritative wait settles, the fail-closed block is persisted.
    harness.resolveWait()
    await until(() => harness.goalState(restarted).status === "blocked", "the fail-closed restart Goal")
    assert.equal(harness.prompts.length, 0)
    assert.equal(harness.session(restarted).agent, "plan")
    assert.match(harness.goalState(restarted).blockedReason!, /queued user input/)

    // A Plan that arises in this runtime is not suppressed: it still earns its
    // one automatic Plan→Build handoff because the runtime observed its
    // execution. The one-shot startup scan has already completed, so this Plan
    // is created after it, exactly like an in-runtime plan_ready.
    harness.seed(readyAutoPlan(live, { planExecutionID: "live-plan-exec" }))
    harness.push({ type: "session.execution.started", id: "live-plan-exec", data: { sessionID: live } })
    harness.push({ type: "session.execution.succeeded", id: "live-plan-exec", data: { sessionID: live } })
    harness.push({ type: "session.status", id: "evt-live-idle", data: { sessionID: live, status: { type: "idle" } } })
    await until(() => harness.prompts.some((prompt) => prompt.sessionID === live), "the same-runtime Auto handoff")
    assert.equal(harness.session(live).agent, "build")
    assert.equal(harness.goalState(live).firstBuildPromptSent, true)
  } finally {
    await cleanup?.()
  }
})

test("the loaded lifecycle scans on server.connected, bounds eligible-only waits, fails a persisted Auto Plan closed, and hands off a current-runtime Plan exactly once", async () => {
  // Ineligible records sort before the eligible Auto Plans so the one scan must
  // visit and reject them before it can open any wait.
  const manual = "ses_awaremanual"
  const blocked = "ses_awareblocked"
  const complete = "ses_awarecomplete"
  const handed = "ses_awarehanded"
  const eligible = ["ses_zwork0", "ses_zwork1", "ses_zwork2", "ses_zwork3"]
  const live = "ses_zworklive"
  const harness = restartRecoveryHarness(
    [
      readyAutoPlan(manual, { handoff: "manual" }),
      readyAutoPlan(blocked, { status: "blocked", blockedReason: "Operator paused." }),
      readyAutoPlan(complete, { status: "complete", completionEvidence: ["done"] }),
      readyAutoPlan(handed, { firstBuildPromptSent: true }),
      ...eligible.map((id) => readyAutoPlan(id)),
    ],
    new Map<string, Record<string, unknown>>([
      [manual, planSession(manual)],
      [blocked, planSession(blocked)],
      [complete, planSession(complete)],
      [handed, planSession(handed)],
      ...eligible.map((id): [string, Record<string, unknown>] => [id, planSession(id)]),
      [live, planSession(live)],
    ]),
  )
  const cleanup = await orchestrationPolicy.setup(harness.context)
  try {
    harness.push({ type: "server.connected", id: "evt-wire-connected", data: {} })
    await until(() => harness.pendingWaits() >= 4, "the bounded eligible wait set")
    await new Promise<void>((resolve) => { setTimeout(resolve, 50) })

    // Bounded and eligible-only: the eight persisted records are all visited,
    // the four ineligible ones open no wait, and exactly four eligible waits
    // are held — the fifth eligible Goal is left for a later idle event.
    assert.equal(harness.counts.scanned, 8)
    assert.equal(harness.counts.waits, 4)
    assert.equal(harness.pendingWaits(), 4)
    assert.equal(harness.prompts.length, 0)
    for (const id of [manual, blocked, complete, handed, ...eligible]) assert.equal(harness.session(id).agent, "plan")

    // A single authoritative idle fails the first persisted Auto Plan closed:
    // it must not switch to Build or queue a prompt and must point at /goal build.
    harness.resolveWait()
    await until(() => eligible.some((id) => harness.goalState(id).status === "blocked"), "the fail-closed persisted Auto Plan")
    const failedID = eligible.find((id) => harness.goalState(id).status === "blocked")!
    assert.equal(harness.prompts.length, 0)
    assert.equal(harness.session(failedID).agent, "plan")
    assert.equal(harness.goalState(failedID).firstBuildPromptSent, false)
    assert.match(harness.goalState(failedID).blockedReason!, /queued user input/)
    for (const id of eligible) if (id !== failedID) assert.equal(harness.goalState(id).status, "awaiting-build")

    // The one-shot scan is spent: a repeated connection and a late idle status
    // neither open another wait nor undo the fail-closed block.
    harness.push({ type: "server.connected", id: "evt-wire-connected-2", data: {} })
    harness.push({ type: "session.status", id: "evt-wire-late-idle", data: { sessionID: failedID, status: { type: "idle" } } })
    await new Promise<void>((resolve) => { setTimeout(resolve, 50) })
    assert.equal(harness.counts.waits, 4)
    assert.equal(harness.prompts.length, 0)
    assert.equal(harness.goalState(failedID).status, "blocked")

    // A Plan whose execution this runtime observed still earns its one handoff,
    // including a persisted Plan seeded after the one-shot startup scan.
    harness.seed(readyAutoPlan(live, { planExecutionID: "wire-live-exec" }))
    harness.push({ type: "session.execution.started", id: "wire-live-exec", data: { sessionID: live } })
    harness.push({ type: "session.execution.succeeded", id: "wire-live-exec", data: { sessionID: live } })
    harness.push({ type: "session.status", id: "evt-wire-live-idle", data: { sessionID: live, status: { type: "idle" } } })
    await until(() => harness.prompts.some((prompt) => prompt.sessionID === live), "the current-runtime Plan handoff")
    assert.equal(harness.session(live).agent, "build")
    assert.equal(harness.goalState(live).firstBuildPromptSent, true)

    // Exactly once: a repeated idle or agent selection cannot queue a second.
    harness.push({ type: "session.status", id: "evt-wire-live-idle-2", data: { sessionID: live, status: { type: "idle" } } })
    await new Promise<void>((resolve) => { setTimeout(resolve, 50) })
    assert.equal(harness.prompts.filter((prompt) => prompt.sessionID === live).length, 1)
  } finally {
    await cleanup?.()
  }
})
