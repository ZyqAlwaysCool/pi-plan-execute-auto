import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StageBStatusEvent, WorkflowState } from "../src/types.js";
import planExecuteAuto, {
  acknowledgeRoundLimitResume,
  applyProfileToFrozenState,
  approvalStartsStageB,
  budgetWarningEvent,
  acceptanceRepeatLimit,
  buildFinalizePrompt,
  chooseReviewRoundLimit,
  formatReviewRoundLimitLabel,
  isValidReviewRoundLimit,
  parseReviewRoundLimit,
  evaluateResumeEligibility,
  frozenProfileMismatch,
  linkedAbortSignal,
  parsePlanExecuteCommand,
  phaseCompletedEntry,
  presentRunState,
  selectStageBReasoningEffort,
  stageBStartDisposition,
  startStageBInBackground,
  workflowPausedEvent,
} from "../extensions/index.js";
import { createPauseRecord } from "../src/pause.js";
import type { ProjectPluginProfile } from "../src/plugin-config.js";

test("Stage B accepts only explicit supported ACP reasoning levels", () => {
  assert.equal(selectStageBReasoningEffort(undefined), undefined);
  assert.equal(selectStageBReasoningEffort(""), undefined);
  for (const effort of ["low", "medium", "high", "max"]) assert.equal(selectStageBReasoningEffort(effort), effort);
  assert.throws(() => selectStageBReasoningEffort("ultra"), /accepts only low, medium, high, or max/);
});

test("settings sync keeps a frozen run identical to the approved profile", () => {
  const state = {
    version: 1,
    run_id: "run-1",
    package_hash: "a".repeat(64),
    package_dir: "/tmp/run-1",
    status: "paused",
    created_at: new Date().toISOString(),
    phases: [],
    executor_model: "opencode/old",
    reviewer_model: "codex/old-sol",
    reasoning_effort: "low",
    executor_reasoning_effort: "medium",
    permission_mode: "ask",
    review_round_limit: 3,
    stage_timeout_ms: 1_000,
  } as unknown as WorkflowState;
  const profile = {
    version: 1,
    projectRoot: "/tmp/project",
    gitEntry: "1:2",
    executorModel: "opencode/deepseek-local/deepseek-flash",
    reviewerModel: "pi/deepseek-local/deepseek-flash",
    executorReasoningEffort: "high",
    reviewerReasoningEffort: "max",
    permissionMode: "autonomous",
    reviewRoundLimit: 12,
    stageTimeoutMs: 0,
    configSha256: "b".repeat(64),
    networkRiskApprovedAt: new Date().toISOString(),
  } as ProjectPluginProfile;
  const changed = applyProfileToFrozenState(state, profile);
  assert.deepEqual(frozenProfileMismatch(state, profile), []);
  assert.ok(changed.includes("reviewer_model"));
  assert.ok(changed.includes("reasoning_effort"), "legacy shared effort must be cleared");
  assert.equal((state as unknown as Record<string, unknown>).reasoning_effort, undefined);
  assert.equal(state.executor_reasoning_effort, "high");
  assert.equal(state.reviewer_reasoning_effort, "max");
  assert.equal(state.permission_mode, "autonomous");
  assert.equal(state.review_round_limit, 12);
  assert.equal(state.stage_timeout_ms, 0);
});

function widgetState(status: WorkflowState["status"], phaseStatuses: Array<"completed" | "paused" | "pending" | "running">): WorkflowState {
  return {
    version: 1,
    run_id: "run-widget",
    package_hash: "a".repeat(64),
    package_dir: "/tmp/run-widget",
    status,
    created_at: new Date().toISOString(),
    phases: phaseStatuses.map((phaseStatus, index) => ({
      phase_id: `phase-0${index + 1}`,
      status: phaseStatus,
      review_rounds: 1,
      execution_report_paths: [],
      review_report_paths: [],
      unresolved_findings: [],
    })),
    review_round_limit: 5,
    branch_name: "pi-plan-execute-auto/run-widget",
  } as unknown as WorkflowState;
}

test("completed runs release the Main Pi widget while paused runs stay pinned", () => {
  const calls: Array<[string, unknown]> = [];
  const ctx = {
    hasUI: true,
    ui: { setWidget: (key: string, value: unknown) => { calls.push([key, value]); } },
  } as unknown as Parameters<typeof presentRunState>[0];

  presentRunState(ctx, widgetState("completed", ["completed", "completed"]));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]![1], undefined, "completed runs clear the widget");

  calls.length = 0;
  const paused = widgetState("paused", ["completed", "paused"]);
  paused.pause = createPauseRecord({ code: "HARNESS_ERROR", stage: "unknown", summary: "boom" });
  presentRunState(ctx, paused);
  assert.equal(calls.length, 1);
  assert.ok(Array.isArray(calls[0]![1]), "paused runs keep the static widget");
});

test("background completion reports run, phases, and branch after releasing the widget", async () => {
  const messages: string[] = [];
  startStageBInBackground({
    start: async () => ({ status: "completed", state: widgetState("completed", ["completed", "completed"]) }),
    notify: (message) => { messages.push(message); },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /completed/);
  assert.match(messages[0]!, /run-widget/);
  assert.match(messages[0]!, /2\/2 phases/);
  assert.match(messages[0]!, /branch pi-plan-execute-auto\/run-widget/);
});

test("only the human Approve & Start decision authorizes Stage B", () => {
  assert.equal(approvalStartsStageB("approve-start"), true);
  assert.equal(approvalStartsStageB("pending"), false);
  assert.equal(approvalStartsStageB("cancel"), false);
});


test("plan-execute accepts an inline natural-language directive without confusing it for a subcommand", () => {
  assert.deepEqual(parsePlanExecuteCommand(""), { kind: "finalize" });
  assert.deepEqual(parsePlanExecuteCommand("finalize"), { kind: "finalize" });
  assert.deepEqual(parsePlanExecuteCommand("按方案B执行"), { kind: "finalize", directive: "按方案B执行" });
  assert.deepEqual(
    parsePlanExecuteCommand("  按方案 B 执行，并保留兼容层  "),
    { kind: "finalize", directive: "按方案 B 执行，并保留兼容层" },
  );
  assert.deepEqual(
    parsePlanExecuteCommand("finalize 按方案B执行"),
    { kind: "finalize", directive: "按方案B执行" },
  );
});

test("plan-execute reserves only explicit control commands and validates their arity", () => {
  assert.deepEqual(parsePlanExecuteCommand("setup"), { kind: "setup" });
  assert.deepEqual(parsePlanExecuteCommand("settings"), { kind: "settings" });
  assert.deepEqual(parsePlanExecuteCommand("settings run-123"), { kind: "settings", runId: "run-123" });
  assert.deepEqual(parsePlanExecuteCommand("settings run-123 extra"), { kind: "usage" });
  assert.deepEqual(parsePlanExecuteCommand("start run-123"), { kind: "start", runId: "run-123" });
  assert.deepEqual(parsePlanExecuteCommand("resume run-123"), { kind: "resume", runId: "run-123" });
  assert.deepEqual(parsePlanExecuteCommand("stop run-123"), { kind: "stop", runId: "run-123" });
  assert.deepEqual(parsePlanExecuteCommand("status run-123"), { kind: "status", runId: "run-123" });
  assert.deepEqual(parsePlanExecuteCommand("setup now"), { kind: "usage" });
  assert.deepEqual(parsePlanExecuteCommand("start"), { kind: "usage" });
  assert.deepEqual(parsePlanExecuteCommand("status run-123 extra"), { kind: "usage" });
});

test("inline directive is authoritative for plan selection but never bypasses human approval", () => {
  const prompt = buildFinalizePrompt("按方案B执行");
  assert.match(prompt, /Human \/plan-execute directive \(verbatim\):\n按方案B执行/u);
  assert.match(prompt, /authoritative/u);
  assert.match(prompt, /Do not ask the human to repeat or reconfirm/u);
  assert.match(prompt, /do NOT authorize bypassing.*Plan Review & Approval/u);
  assert.match(prompt, /Do not implement code or approve\/freeze/u);
  assert.match(prompt, /end this Main Pi turn with only a brief handoff/u);
  assert.match(prompt, /Do not restate or summarize the draft plan/u);
  assert.match(prompt, /Acceptance self-tests run inside a minimal sandbox/u);
  assert.match(prompt, /self_tests\[\]\.requires/u);
  assert.match(prompt, /self_tests\[\]\.timeout_ms/u);
});

test("acceptance budget and repeat-limit env knobs are clamped, not trusted", () => {
  assert.equal(acceptanceRepeatLimit({}), 3);
  assert.equal(acceptanceRepeatLimit({ PI_PLAN_EXECUTE_ACCEPTANCE_REPEAT_LIMIT: "1" }), 1);
  assert.equal(acceptanceRepeatLimit({ PI_PLAN_EXECUTE_ACCEPTANCE_REPEAT_LIMIT: "0" }), 3);
  assert.equal(acceptanceRepeatLimit({ PI_PLAN_EXECUTE_ACCEPTANCE_REPEAT_LIMIT: "999" }), 20);
  assert.equal(acceptanceRepeatLimit({ PI_PLAN_EXECUTE_ACCEPTANCE_REPEAT_LIMIT: "nope" }), 3);
});

test("queued human review waits for full agent settlement and never blocks turn_end", () => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const fakePi = {
    registerTool() {},
    registerCommand() {},
    registerShortcut() {},
    registerEntryRenderer() {},
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, handler);
      return () => {};
    },
  };
  planExecuteAuto(fakePi as unknown as Parameters<typeof planExecuteAuto>[0]);

  assert.equal(handlers.has("turn_end"), false, "review must not run in the awaited turn_end boundary");
  const settled = handlers.get("agent_settled");
  assert.ok(settled, "review lifecycle must attach to agent_settled");

  const result = settled({ type: "agent_settled" }, { hasUI: false });
  assert.equal(result, undefined, "agent_settled handler must schedule review without awaiting it");
});


test("safe resume accepts only execution-interruption checkpoints with remaining review budget", () => {
  const base = {
    version: 1,
    run_id: "resume-test",
    package_hash: "a".repeat(64),
    package_dir: "/tmp/resume-test",
    status: "paused",
    created_at: new Date(0).toISOString(),
    review_round_limit: 5,
    branch_name: "pi-plan-execute-auto/resume-test",
    worktree_path: "/tmp/resume-worktree",
    phases: [{
      phase_id: "phase-01",
      status: "paused",
      review_rounds: 2,
      execution_report_paths: [],
      review_report_paths: [],
      unresolved_findings: [],
    }],
  } as WorkflowState;

  for (const code of ["ABORTED", "TIMEOUT", "HUMAN_STOP", "SESSION_ABORT", "HARNESS_ERROR", "PROCESS_RESTART", "PROCESS_RESTART_RECONCILED"]) {
    const state = { ...base, pause_reason: `[${code}] transient interruption`, phases: base.phases.map((phase) => ({ ...phase })) };
    const result = evaluateResumeEligibility(state);
    assert.equal(result.ok, true, code);
  }

  for (const code of ["HEAD_CHANGED", "GOLDEN_PACKAGE_CHANGED", "REVIEWER_CHANGED_WORKSPACE", "COMPLETION_EVIDENCE_INVALID"]) {
    const state = { ...base, pause_reason: `[${code}] unsafe checkpoint`, phases: base.phases.map((phase) => ({ ...phase })) };
    const result = evaluateResumeEligibility(state);
    assert.equal(result.ok, false, code);
  }

  // A round-limit pause resumes only while the effective (possibly raised) limit still
  // leaves rounds available; a structured, stale `resumable: false` record does not block it.
  const elevatedRoundLimit = {
    ...base,
    review_round_limit: 20,
    pause: createPauseRecord({
      code: "MAX_REVIEW_ROUNDS",
      summary: "Phase did not pass deterministic validation after 12 review rounds.",
      stage: "acceptance",
      resumable: false,
      phase_id: "phase-01",
      round: 12,
    }),
    pause_reason: "[MAX_REVIEW_ROUNDS] Phase did not pass deterministic validation after 12 review rounds.",
    phases: [{ ...base.phases[0]!, review_rounds: 12 }],
  } as WorkflowState;
  assert.equal(evaluateResumeEligibility(elevatedRoundLimit).ok, true);
  assert.equal(evaluateResumeEligibility({ ...elevatedRoundLimit, review_round_limit: 12 } as WorkflowState).ok, false);
  assert.equal(evaluateResumeEligibility({ ...elevatedRoundLimit, review_round_limit: 5 } as WorkflowState).ok, false);

  const exhausted = {
    ...base,
    pause_reason: "[HARNESS_ERROR] provider interruption",
    phases: [{ ...base.phases[0]!, review_rounds: 5 }],
  } as WorkflowState;
  assert.equal(evaluateResumeEligibility(exhausted).ok, false);

  const orphaned = { ...base, status: "running", pause_reason: undefined } as WorkflowState;
  assert.equal(evaluateResumeEligibility(orphaned).ok, false);
  assert.equal(evaluateResumeEligibility(orphaned, { allowOrphanedRunning: true }).ok, true);

  // Structured pause records own resumability directly; the legacy string stays a fallback.
  const structured = {
    ...base,
    pause: {
      code: "TIMEOUT",
      summary: "Stage B timed out after 30 minutes.",
      stage: "executor",
      resumable: true,
      at: new Date(0).toISOString(),
    },
    phases: base.phases.map((phase) => ({ ...phase })),
  } as WorkflowState;
  assert.equal(evaluateResumeEligibility(structured).ok, true);
  assert.equal(evaluateResumeEligibility({ ...structured, pause: { ...structured.pause!, code: "STARTUP_EVIDENCE", resumable: false } } as WorkflowState).ok, false);
});

test("a raised review limit turns the persisted round-limit pause into a resumable checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "peac-round-limit-"));
  try {
    await mkdir(root, { recursive: true });
    const state = {
      version: 1,
      run_id: "run-round-limit",
      package_hash: "a".repeat(64),
      package_dir: root,
      status: "paused",
      created_at: new Date(0).toISOString(),
      review_round_limit: 20,
      branch_name: "pi-plan-execute-auto/run-round-limit",
      worktree_path: "/tmp/round-limit-worktree",
      pause: createPauseRecord({
        code: "MAX_REVIEW_ROUNDS",
        summary: "Phase did not pass deterministic validation after 12 review rounds.",
        stage: "acceptance",
        resumable: false,
        phase_id: "phase-01",
        round: 12,
      }),
      pause_reason: "[MAX_REVIEW_ROUNDS] Phase did not pass deterministic validation after 12 review rounds.",
      phases: [{
        phase_id: "phase-01",
        status: "paused",
        review_rounds: 12,
        execution_report_paths: [],
        review_report_paths: [],
        unresolved_findings: [],
      }],
    } as WorkflowState;

    assert.equal(evaluateResumeEligibility(state).ok, true);
    assert.equal(await acknowledgeRoundLimitResume(root, state), true);
    const persisted = JSON.parse(await readFile(join(root, ".state.json"), "utf8")) as WorkflowState;
    assert.equal(persisted.pause?.resumable, true);
    assert.match(persisted.pause?.detail ?? "", /limit raised to 20/);
    assert.match(persisted.pause_reason ?? "", /^\[MAX_REVIEW_ROUNDS\]/);
    // Idempotent: a second resume attempt must not rewrite or duplicate the checkpoint.
    assert.equal(await acknowledgeRoundLimitResume(root, persisted), false);

    const unchanged = { ...state, review_round_limit: 12, pause: { ...state.pause! }, pause_reason: state.pause_reason } as WorkflowState;
    assert.equal(evaluateResumeEligibility(unchanged).ok, false);
    assert.equal(await acknowledgeRoundLimitResume(root, unchanged), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repairable workspace evidence pauses resume through repair verification", () => {
  const base = {
    version: 1,
    run_id: "repair-test",
    package_hash: "a".repeat(64),
    package_dir: "/tmp/repair-test",
    status: "paused",
    created_at: new Date(0).toISOString(),
    review_round_limit: 5,
    branch_name: "pi-plan-execute-auto/repair-test",
    worktree_path: "/tmp/repair-worktree",
    phases: [{
      phase_id: "phase-01",
      status: "paused",
      review_rounds: 2,
      execution_report_paths: [],
      review_report_paths: [],
      unresolved_findings: [],
    }],
  } as WorkflowState;
  const repairable = {
    ...base,
    pause: { code: "WORKSPACE_SYMLINK_ESCAPE", summary: "link escapes", stage: "unknown", resumable: false, at: new Date(0).toISOString() },
    pause_reason: "[WORKSPACE_SYMLINK_ESCAPE] link escapes",
    phases: base.phases.map((phase) => ({ ...phase })),
  } as WorkflowState;
  const result = evaluateResumeEligibility(repairable);
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.repairRequired === true);

  // Non-repairable safety pauses stay refused even with the same exhausted-checkpoint shape.
  const refused = evaluateResumeEligibility({
    ...repairable,
    pause: { ...repairable.pause!, code: "STARTUP_EVIDENCE" },
  } as WorkflowState);
  assert.equal(refused.ok, false);

  // A repaired checkpoint is an ordinary resumable interruption with no repair flag.
  const repaired = evaluateResumeEligibility({
    ...repairable,
    pause: { ...repairable.pause!, code: "EVIDENCE_REPAIRED", resumable: true },
  } as WorkflowState);
  assert.equal(repaired.ok, true);
  assert.ok(repaired.ok && repaired.repairRequired === undefined);
});

test("the budget warning event fires once the run consumes 80% of its budget", () => {
  assert.deepEqual(budgetWarningEvent("run-1", 30 * 60 * 1000), {
    run_id: "run-1",
    timeout_ms: 1_800_000,
    warning_after_ms: 1_440_000,
    message: "Execution & Review consumed 80% of its 30 minutes budget.",
  });
});

test("explicit resume may start a paused run while the approval guard still blocks unapproved states", () => {
  const basePhase = {
    phase_id: "phase-01",
    status: "pending" as const,
    review_rounds: 0,
    execution_report_paths: [],
    review_report_paths: [],
    unresolved_findings: [],
  };
  const state = (status: WorkflowState["status"], overrides: Partial<WorkflowState> = {}): WorkflowState => ({
    version: 1,
    run_id: "disposition-test",
    package_hash: "a".repeat(64),
    package_dir: "/tmp/disposition-test",
    status,
    created_at: new Date(0).toISOString(),
    phases: [basePhase],
    ...overrides,
  } as WorkflowState);

  // Regression: a paused run with an approved, resumable checkpoint must reach Stage B.
  assert.equal(stageBStartDisposition(state("paused"), true), "start");
  assert.equal(stageBStartDisposition(state("paused"), false), "plan_not_approved");
  assert.equal(stageBStartDisposition(state("running"), true), "start");
  assert.equal(stageBStartDisposition(state("frozen"), false), "start");
  const frozenWithEvidence = state("frozen", {
    phases: [{ ...basePhase, status: "paused", review_rounds: 1 }],
  });
  assert.equal(stageBStartDisposition(frozenWithEvidence, false), "restart_required");
  assert.equal(stageBStartDisposition(state("draft"), true), "plan_not_approved");
});

test("phase completion entries are emitted only for PASS and carry the commit", () => {
  const state = {
    version: 1,
    run_id: "run-1",
    package_hash: "a".repeat(64),
    package_dir: "/tmp/run-1",
    status: "running",
    created_at: new Date(0).toISOString(),
    phases: [{
      phase_id: "phase-01",
      status: "completed",
      review_rounds: 2,
      phase_commit_sha: "b".repeat(40),
      committed_at: "2026-01-01T00:00:00.000Z",
      execution_report_paths: [],
      review_report_paths: [],
      unresolved_findings: [],
    }],
  } as WorkflowState;
  const event: StageBStatusEvent = {
    phase_id: "phase-01",
    round: 2,
    executor_status: "complete",
    reviewer_status: "pass",
    message: "Phase committed at bbb.",
    plan: { phase_ids: ["phase-01", "phase-02"], phase_statuses: ["completed", "pending"], current_index: 1, review_round_limit: 5 },
  };
  assert.deepEqual(phaseCompletedEntry(event, state), {
    run_id: "run-1",
    phase_id: "phase-01",
    phase_index: 1,
    phase_total: 2,
    review_rounds: 2,
    commit: "b".repeat(40),
    committed_at: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(phaseCompletedEntry({ ...event, reviewer_status: "rework" }, state), undefined);
  const { plan: _plan, ...withoutPlan } = event;
  assert.equal(phaseCompletedEntry(withoutPlan, state), undefined);
});

test("the workflow_paused event carries the structured cause for the timeline", () => {
  const state = {
    version: 1,
    run_id: "run-1",
    package_hash: "a".repeat(64),
    package_dir: "/tmp/run-1",
    status: "paused",
    created_at: new Date(0).toISOString(),
    pause_reason: "[TIMEOUT] Stage B timed out after 30 minutes.",
    phases: [{
      phase_id: "phase-01",
      status: "paused",
      review_rounds: 2,
      execution_report_paths: [],
      review_report_paths: [],
      unresolved_findings: [],
      executor_session_id: "ses-1",
      reviewer_session_id: "rev-1",
    }],
  } as WorkflowState;
  const record = createPauseRecord({
    code: "TIMEOUT",
    summary: "Stage B timed out after 30 minutes.",
    stage: "executor",
    timeout_ms: 1_800_000,
    elapsed_ms: 1_799_998,
  });
  assert.deepEqual(workflowPausedEvent(state, record), {
    run_id: "run-1",
    code: "TIMEOUT",
    summary: "Stage B timed out after 30 minutes.",
    detail: null,
    stage: "executor",
    resumable: true,
    timeout_ms: 1_800_000,
    elapsed_ms: 1_799_998,
    reason: "[TIMEOUT] Stage B timed out after 30 minutes.",
    phase_id: "phase-01",
    review_rounds: 2,
    executor_session_id: "ses-1",
    reviewer_session_id: "rev-1",
    execution_report_path: null,
    review_report_path: null,
    acceptance_report_path: null,
  });
});

test("Stage B abort plumbing keeps timeout, human stop, and session interruption distinct", async () => {
  const timeout = linkedAbortSignal(undefined, 30);
  await new Promise<void>((resolve) => timeout.signal.addEventListener("abort", () => resolve(), { once: true }));
  const timeoutReason = timeout.signal.reason as { kind: string; timeoutMs?: number; elapsedMs?: number };
  assert.equal(timeoutReason.kind, "timeout");
  assert.equal(timeoutReason.timeoutMs, 30);
  assert.equal(typeof timeoutReason.elapsedMs, "number");
  timeout.dispose();

  const human = new AbortController();
  const humanLinked = linkedAbortSignal(human.signal, 0);
  human.abort({ kind: "human_stop", message: "Execution & Review stopped by human." });
  assert.deepEqual(humanLinked.signal.reason, { kind: "human_stop", message: "Execution & Review stopped by human." });
  humanLinked.dispose();

  const external = new AbortController();
  const sessionLinked = linkedAbortSignal(external.signal, 0);
  external.abort(new Error("ctrl-c"));
  assert.deepEqual(sessionLinked.signal.reason, { kind: "session_abort", message: "ctrl-c" });
  sessionLinked.dispose();

  const preAborted = new AbortController();
  preAborted.abort(new Error("already gone"));
  const preLinked = linkedAbortSignal(preAborted.signal, 60_000);
  assert.equal(preLinked.signal.aborted, true);
  assert.equal((preLinked.signal.reason as { kind: string }).kind, "session_abort");
  preLinked.dispose();

  const unlimited = linkedAbortSignal(undefined, 0);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(unlimited.signal.aborted, false);
  unlimited.dispose();
});


test("plan_execute_finalize cannot accept a model-supplied run_id", () => {
  let finalizeTool: { name?: string; parameters?: unknown; promptGuidelines?: string[] } | undefined;
  const fakePi = {
    registerTool(tool: { name?: string; parameters?: unknown; promptGuidelines?: string[] }) {
      if (tool.name === "plan_execute_finalize") finalizeTool = tool;
    },
    registerCommand() {},
    registerShortcut() {},
    registerEntryRenderer() {},
    on() { return () => {}; },
  };
  planExecuteAuto(fakePi as unknown as Parameters<typeof planExecuteAuto>[0]);
  assert.ok(finalizeTool);
  const schema = finalizeTool.parameters as {
    properties?: Record<string, unknown>;
    additionalProperties?: boolean;
  };
  assert.equal(Object.prototype.hasOwnProperty.call(schema.properties ?? {}, "run_id"), false);
  assert.equal(schema.additionalProperties, false);
  assert.match((finalizeTool.promptGuidelines ?? []).join("\n"), /plugin exclusively allocates the execution identity/u);
});

function fakeUiContext(answers: { select?: Array<string | undefined>; input?: Array<string | undefined> }) {
  const selectQueue = [...(answers.select ?? [])];
  const inputQueue = [...(answers.input ?? [])];
  const notices: Array<{ message: string; level?: string | undefined }> = [];
  const prompts: string[] = [];
  const ctx = {
    hasUI: true,
    ui: {
      select: async (title: string) => {
        prompts.push(title);
        return selectQueue.shift();
      },
      input: async (title: string) => {
        prompts.push(title);
        return inputQueue.shift();
      },
      notify: (message: string, level?: string) => {
        notices.push({ message, level });
      },
    },
  };
  return { ctx: ctx as unknown as Parameters<typeof chooseReviewRoundLimit>[0], notices, prompts };
}

test("review round limits accept any whole number in 1..100", () => {
  for (const good of [1, 2, 37, 99, 100, "1", "37", " 100 "]) {
    assert.equal(parseReviewRoundLimit(good), typeof good === "string" ? Number(good.trim()) : good, String(good));
  }
  for (const bad of [0, -1, 101, 1000, 1.5, "0", "101", "1.5", "abc", "", "  ", undefined, null, {}]) {
    assert.equal(parseReviewRoundLimit(bad), undefined, String(bad));
  }
  assert.equal(isValidReviewRoundLimit(1), true);
  assert.equal(isValidReviewRoundLimit(100), true);
  assert.equal(isValidReviewRoundLimit(0), false);
  assert.equal(isValidReviewRoundLimit(101), false);
});

test("review round labels mark the recommendation and the current value", () => {
  assert.equal(formatReviewRoundLimitLabel(5), "5 rounds (recommended default)");
  assert.equal(formatReviewRoundLimitLabel(8), "8 rounds");
  assert.equal(formatReviewRoundLimitLabel(8, 8), "8 rounds (current)");
  assert.equal(formatReviewRoundLimitLabel(5, 5), "5 rounds (recommended default) (current)");
});

test("setup offers presets plus a custom review round limit", async () => {
  const preset = fakeUiContext({ select: ["12 rounds"] });
  assert.equal(await chooseReviewRoundLimit(preset.ctx), 12);
  assert.ok(preset.prompts[0]?.includes("Maximum review rounds per phase"));

  const custom = fakeUiContext({ select: ["Custom…"], input: ["37"] });
  assert.equal(await chooseReviewRoundLimit(custom.ctx, 5), 37);
  assert.equal(custom.notices.length, 0);

  const retry = fakeUiContext({ select: ["Custom…"], input: ["0", "abc", "101", "42"] });
  assert.equal(await chooseReviewRoundLimit(retry.ctx), 42);
  assert.equal(retry.notices.length, 3);
  assert.ok(retry.notices.every((entry) => entry.level === "warning"));
  assert.match(retry.notices[0]?.message ?? "", /between 1 and 100/u);

  const cancelled = fakeUiContext({ select: ["Cancel"] });
  assert.equal(await chooseReviewRoundLimit(cancelled.ctx), undefined);

  const abortedInput = fakeUiContext({ select: ["Custom…"], input: [undefined] });
  assert.equal(await chooseReviewRoundLimit(abortedInput.ctx), undefined);
});

test("an existing custom limit stays visible and selectable in the editor", async () => {
  const { ctx, prompts } = fakeUiContext({ select: ["Custom… (current: 37)"], input: ["37"] });
  let offered: string[] = [];
  const capturing = {
    hasUI: true,
    ui: {
      select: async (title: string, options: string[]) => {
        offered = options;
        prompts.push(title);
        return options.find((option) => option === "Custom… (current: 37)");
      },
      input: async (title: string) => {
        prompts.push(title);
        return "37";
      },
      notify: () => {},
    },
  } as unknown as Parameters<typeof chooseReviewRoundLimit>[0];
  assert.equal(await chooseReviewRoundLimit(capturing, 37), 37);
  assert.equal(await chooseReviewRoundLimit(ctx, 37), 37);
});
