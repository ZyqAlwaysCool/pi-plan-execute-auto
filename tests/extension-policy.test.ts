import { test } from "node:test";
import assert from "node:assert/strict";
import type { WorkflowState } from "../src/types.js";
import planExecuteAuto, {
  approvalStartsStageB,
  buildFinalizePrompt,
  evaluateResumeEligibility,
  parsePlanExecuteCommand,
  selectStageBReasoningEffort,
} from "../extensions/index.js";

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

  for (const code of ["ABORTED", "HARNESS_ERROR", "PROCESS_RESTART", "PROCESS_RESTART_RECONCILED"]) {
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
