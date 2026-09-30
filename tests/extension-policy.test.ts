import { test } from "node:test";
import assert from "node:assert/strict";
import type { WorkflowState } from "../src/types.js";
import planExecuteAuto, {
  approvalStartsStageB,
  budgetWarningEvent,
  buildFinalizePrompt,
  evaluateResumeEligibility,
  linkedAbortSignal,
  parsePlanExecuteCommand,
  selectStageBReasoningEffort,
  stageBStartDisposition,
  workflowPausedEvent,
} from "../extensions/index.js";
import { createPauseRecord } from "../src/pause.js";

test("Stage B accepts only explicit supported ACP reasoning levels", () => {
  assert.equal(selectStageBReasoningEffort(undefined), undefined);
  assert.equal(selectStageBReasoningEffort(""), undefined);
  for (const effort of ["low", "medium", "high", "max"]) assert.equal(selectStageBReasoningEffort(effort), effort);
  assert.throws(() => selectStageBReasoningEffort("ultra"), /accepts only low, medium, high, or max/);
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
});

test("queued human review waits for full agent settlement and never blocks turn_end", () => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const fakePi = {
    registerTool() {},
    registerCommand() {},
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

  for (const code of ["MAX_REVIEW_ROUNDS", "HEAD_CHANGED", "GOLDEN_PACKAGE_CHANGED", "REVIEWER_CHANGED_WORKSPACE", "COMPLETION_EVIDENCE_INVALID"]) {
    const state = { ...base, pause_reason: `[${code}] unsafe checkpoint`, phases: base.phases.map((phase) => ({ ...phase })) };
    const result = evaluateResumeEligibility(state);
    assert.equal(result.ok, false, code);
  }

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
