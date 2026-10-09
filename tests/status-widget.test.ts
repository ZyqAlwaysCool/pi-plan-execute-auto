import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { createPauseRecord } from "../src/pause.js";
import {
  CHECKLIST_SEPARATOR,
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  STALL_AFTER_MS,
  StageBActivityModel,
  StageBActivityWidget,
  formatActivityLines,
  formatPlanChecklist,
  layoutPlanChecklist,
} from "../src/status-widget.js";
import type { PhaseRuntimeStatus, StageBPlanSnapshot } from "../src/types.js";

const theme = {
  fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
};

function testClock(start = 1_000_000) {
  let now = start;
  return {
    model: new StageBActivityModel(() => now),
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

function plan(
  ids: string[],
  statuses: PhaseRuntimeStatus[],
  current = statuses.findIndex((status) => status !== "completed"),
  reviewRoundLimit = 5,
): StageBPlanSnapshot {
  return { phase_ids: ids, phase_statuses: statuses, current_index: current, review_round_limit: reviewRoundLimit };
}

test("Stage B spinner matches Pi's working-loader defaults", () => {
  assert.deepEqual([...SPINNER_FRAMES], ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);
  assert.equal(SPINNER_INTERVAL_MS, 80);
});

test("live ACP events render only on the live line, never on the header", () => {
  const { model, now } = testClock();
  model.startLive("run-pelican-runner", "executor", "agent_thought_chunk");
  const lines = formatActivityLines(model.snapshot(now()), theme, 200, now());
  assert.equal(lines[0], " <muted>Execution & Review · run-pelican-runner</muted>");
  assert.equal(lines[1], " <accent>⠋</accent> <muted>executor · agent_thought_chunk</muted><dim> · 1 evt/s</dim>");
});

test("the evt/s readout only counts events from the last second", () => {
  const { model, advance, now } = testClock();
  model.startLive("run-1", "executor", "tool_call");
  advance(1_500);
  model.startLive("run-1", "executor", "agent_message_chunk");
  const line = formatActivityLines(model.snapshot(now()), theme, 200, now())[1]!;
  assert.match(line, /<dim> · 1 evt\/s<\/dim>/);
});

test("true ACP silence stops the spinner and renders a warning", () => {
  const { model, advance, now } = testClock();
  model.startLive("run-1", "executor", "agent_thought_chunk");
  advance(STALL_AFTER_MS + 5_000);
  const line = formatActivityLines(model.snapshot(now()), theme, 200, now())[1]!;
  assert.equal(
    line,
    " <warning>⚠</warning> <warning>executor · agent_thought_chunk</warning> <warning>· no ACP events for 25s</warning>",
  );
});

test("plan progress renders full phase names with markers, current round, and message", () => {
  const { model, now } = testClock();
  const snapshot = plan(
    ["phase-1-core-sim", "phase-2-render", "phase-3-shell", "phase-4-polish"],
    ["completed", "running", "pending", "pending"],
  );
  model.setPlan(snapshot);
  model.applyStatus({
    phase_id: "phase-2-render",
    round: 2,
    executor_status: "running",
    reviewer_status: "pending",
    message: "Executor resuming same session after feedback.",
    plan: snapshot,
  });
  const lines = formatActivityLines(model.snapshot(now()), theme, 200, now());
  assert.equal(lines[0], " <muted>Execution & Review</muted><dim> · </dim><dim>1/4 phases</dim>");
  assert.equal(
    lines[1],
    " <success>✓ phase-1-core-sim</success> · <accent>▶ phase-2-render (r2/5)</accent> · <dim>○ phase-3-shell</dim> · <dim>○ phase-4-polish</dim>",
  );
  assert.equal(lines[2], " <muted>Executor resuming same session after feedback.</muted>");
});

test("the header shows the run id, N/M phases, and the completed state", () => {
  const { model, now } = testClock();
  model.setRunId("run-1");
  model.setPlan(plan(["phase-1", "phase-2"], ["completed", "completed"], -1));
  const lines = formatActivityLines(model.snapshot(now()), theme, 200, now());
  assert.equal(
    lines[0],
    " <muted>Execution & Review · run-1</muted><dim> · </dim><dim>2/2 phases</dim><dim> · </dim><success>complete</success>",
  );
  assert.equal(lines[1], " <success>✓ phase-1</success> · <success>✓ phase-2</success>");
  assert.equal(lines.length, 2);
});

test("a paused checkpoint renders cause and resume instead of the live line", () => {
  const { model, now } = testClock();
  const snapshot = plan(["phase-1-core-sim", "phase-2-render"], ["completed", "paused"]);
  const pause = createPauseRecord({
    code: "TIMEOUT",
    summary: "Stage B timed out after 2 hours.",
    stage: "executor",
    round: 1,
    timeout_ms: 7_200_000,
    elapsed_ms: 7_200_000,
  });
  model.setPlan(snapshot);
  model.applyStatus({
    phase_id: "phase-2-render",
    round: 1,
    executor_status: "interrupted",
    reviewer_status: "interrupted",
    message: "[TIMEOUT] Stage B timed out after 2 hours.",
    pause,
    plan: snapshot,
  });
  model.startLive("run-1", "executor", "agent_thought_chunk");
  const lines = formatActivityLines(model.snapshot(now()), theme, 200, now());
  assert.equal(
    lines[0],
    " <muted>Execution & Review · run-1</muted><dim> · </dim><dim>1/2 phases</dim><dim> · </dim><warning>paused</warning>",
  );
  assert.equal(lines[1], " <success>✓ phase-1-core-sim</success> · <accent>⏸ phase-2-render (r1/5)</accent>");
  assert.equal(lines[2], " <warning>TIMEOUT · Stage B timed out after 2 hours. (executor, round 1) · resumable</warning>");
  assert.equal(lines[3], " <muted>Resume: /plan-execute resume run-1</muted>");
  assert.equal(lines.length, 4);
});

test("a non-resumable pause says resume is refused", () => {
  const { model, now } = testClock();
  const snapshot = plan(["phase-1"], ["paused"]);
  model.setPlan(snapshot);
  model.applyStatus({
    phase_id: "phase-1",
    round: 1,
    executor_status: "interrupted",
    reviewer_status: "interrupted",
    message: "[REVIEWER_CHANGED_WORKSPACE] changed",
    pause: createPauseRecord({ code: "REVIEWER_CHANGED_WORKSPACE", summary: "changed", stage: "reviewer" }),
    plan: snapshot,
  });
  const lines = formatActivityLines(model.snapshot(now()), theme, 200, now());
  assert.match(lines[3]!, /<error>Resume refused/);
});

test("full checklist names truncate proportionally when the width is tight", () => {
  const snapshot = plan(
    ["phase-1-core-sim", "phase-2-render", "phase-3-shell"],
    ["completed", "running", "pending"],
  );
  const line = formatPlanChecklist(snapshot, 48, { round: 3 });
  assert.ok(visibleWidth(line) <= 47, `"${line}" exceeds width`);
  assert.match(line, /✓ phase-1-…/);
  assert.match(line, /▶ phase-2-r… \(r3\/5\)/);
  assert.match(line, /○ phase-3-…/);
});

test("CJK phase names stay on character boundaries and respect cell width", () => {
  const snapshot = plan(
    ["阶段一-核心模拟器", "阶段二-渲染层", "阶段三-外壳应用", "阶段四-打磨"],
    ["completed", "running", "pending", "pending"],
  );
  const { model, now } = testClock();
  model.setPlan(snapshot);
  model.applyStatus({
    phase_id: "阶段二-渲染层",
    round: 1,
    executor_status: "running",
    reviewer_status: "pending",
    message: "执行中",
    plan: snapshot,
  });
  for (const line of formatActivityLines(model.snapshot(now()), theme, 40, now())) {
    assert.ok(visibleWidth(line) <= 40, `"${line}" exceeds 40 cells`);
  }
  const full = formatPlanChecklist(snapshot, 200, { round: 1 });
  assert.equal(
    full,
    "✓ 阶段一-核心模拟器 · ▶ 阶段二-渲染层 (r1/5) · ○ 阶段三-外壳应用 · ○ 阶段四-打磨",
  );
  assert.equal(layoutPlanChecklist(snapshot, 200, { round: 1 }).length, 4);
});

test("very narrow widths degrade to the current phase only", () => {
  const snapshot = plan(
    ["phase-1-core-sim", "phase-2-render", "phase-3-shell"],
    ["completed", "running", "pending"],
  );
  const parts = layoutPlanChecklist(snapshot, 24, { round: 2 });
  assert.equal(parts.length, 1);
  assert.match(parts[0]!.text, /^▶ 2\/3 phase-2-render/);
  assert.ok(visibleWidth(parts[0]!.text) <= 23);
});

test("many phases degrade to a window around the current phase", () => {
  const ids = Array.from({ length: 12 }, (_, index) => `phase-${index + 1}-name`);
  const statuses = ids.map((_, index) =>
    (index < 5 ? "completed" : index === 5 ? "running" : "pending") as PhaseRuntimeStatus);
  const snapshot = plan(ids, statuses, 5);
  const parts = layoutPlanChecklist(snapshot, 100, { round: 1 });
  const line = parts.map((part) => part.text).join(CHECKLIST_SEPARATOR);
  assert.ok(visibleWidth(line) <= 99, `"${line}" exceeds width`);
  assert.ok(parts.length < 12, "window must elide distant phases");
  assert.match(line, /▶ phase-6/);
  assert.match(line, /…/);
  assert.ok(!line.includes("phase-1-"), "leading hidden phases are elided");
  assert.ok(!line.includes("phase-12-"), "trailing hidden phases are elided");
});

test("windowed checklist keeps the current phase readable at narrow widths", () => {
  const ids = Array.from({ length: 10 }, (_, index) => `phase-${index + 1}-component`);
  const statuses = ids.map((_, index) =>
    (index < 6 ? "completed" : index === 6 ? "running" : "pending") as PhaseRuntimeStatus);
  const snapshot = plan(ids, statuses, 6);
  const parts = layoutPlanChecklist(snapshot, 60, { round: 3 });
  const line = parts.map((part) => part.text).join(CHECKLIST_SEPARATOR);
  assert.ok(visibleWidth(line) <= 59, `"${line}" exceeds width`);
  assert.match(line, /▶ phase-7-com… \(r3\/5\)/);
  assert.match(line, /…/);
});

test("widget spins while live and stops on stall, stop, and dispose", () => {
  const { model, advance } = testClock();
  const tui = { requestRender: () => {} } as unknown as TUI;
  const widget = new StageBActivityWidget(tui, theme, model);
  assert.equal(widget.spinning, false);

  model.startLive("run-1", "executor", "agent_thought_chunk");
  assert.equal(widget.spinning, true);

  advance(STALL_AFTER_MS + 1);
  widget.refresh();
  assert.equal(widget.spinning, false);
  assert.match(widget.render(200).join("\n"), /no ACP events for 20s/);

  model.startLive("run-1", "executor", "tool_call");
  assert.equal(widget.spinning, true);

  model.stop();
  assert.equal(widget.spinning, false);

  // stop() is terminal for one model instance; a resumed run gets a fresh model.
  model.startLive("run-1", "executor", "tool_call");
  assert.equal(widget.spinning, false);
  widget.dispose();
  assert.equal(widget.spinning, false);

  model.startLive("run-1", "executor", "tool_call");
  assert.equal(widget.spinning, false);
});

test("rendered lines never exceed the available width", () => {
  const { model, advance, now } = testClock();
  const plain = { fg: (_token: string, text: string) => text };
  model.startLive("run-with-a-very-long-identifier", "executor", "agent_thought_chunk".repeat(3));
  model.setPlan(plan(
    ["phase-1-核心模拟器", "phase-2-渲染层", "phase-3-外壳应用", "phase-4-打磨与调参"],
    ["completed", "running", "pending", "pending"],
  ));
  model.applyStatus({
    phase_id: "phase-2-渲染层",
    round: 2,
    executor_status: "running",
    reviewer_status: "pending",
    message: "m".repeat(100),
    plan: plan(
      ["phase-1-核心模拟器", "phase-2-渲染层", "phase-3-外壳应用", "phase-4-打磨与调参"],
      ["completed", "running", "pending", "pending"],
    ),
  });
  for (const width of [12, 20, 40, 80]) {
    for (const line of formatActivityLines(model.snapshot(now()), plain, width, now())) {
      assert.ok(visibleWidth(line) <= width, `"${line}" exceeds width ${width}`);
    }
  }
  advance(1_500);
  for (const line of formatActivityLines(model.snapshot(now()), plain, 24, now())) {
    assert.ok(visibleWidth(line) <= 24);
  }
});

test("the whole-run budget renders as remaining time and warns near expiry", () => {
  const { model, advance, now } = testClock();
  model.startLive("run-1", "executor", "agent_thought_chunk");
  model.setBudget(now(), 30 * 60 * 1000);
  assert.equal(
    formatActivityLines(model.snapshot(now()), theme, 200, now())[0],
    " <muted>Execution & Review · run-1</muted><dim> · </dim><dim>30m left</dim>",
  );
  advance(26 * 60 * 1000);
  assert.equal(
    formatActivityLines(model.snapshot(now()), theme, 200, now())[0],
    " <muted>Execution & Review · run-1</muted><dim> · </dim><warning>4m left</warning>",
  );
  model.stop();
  assert.equal(
    formatActivityLines(model.snapshot(now()), theme, 200, now())[0],
    " <muted>Execution & Review · run-1</muted>",
  );
});

test("no-timeout runs never render a budget readout", () => {
  const { model, now } = testClock();
  model.startLive("run-1", "executor", "agent_thought_chunk");
  model.setBudget(now(), 0);
  assert.equal(formatActivityLines(model.snapshot(now()), theme, 200, now())[0], " <muted>Execution & Review · run-1</muted>");
  model.setBudget(now(), 30 * 60 * 1000);
  assert.match(formatActivityLines(model.snapshot(now()), theme, 200, now())[0]!, /30m left/);
  model.setBudget(now(), 0);
  assert.equal(formatActivityLines(model.snapshot(now()), theme, 200, now())[0], " <muted>Execution & Review · run-1</muted>");
});

test("plan checklist helper exports a stable plain-text contract", () => {
  const snapshot = plan(["phase-1-core-sim", "phase-2-render"], ["completed", "running"]);
  assert.equal(formatPlanChecklist(snapshot, 200, { round: 1 }), `✓ phase-1-core-sim${CHECKLIST_SEPARATOR}▶ phase-2-render (r1/5)`);
  assert.equal(formatPlanChecklist(plan([], [], -1), 200), "");
});
