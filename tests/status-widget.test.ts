import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import {
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  STALL_AFTER_MS,
  StageBActivityModel,
  StageBActivityWidget,
  formatActivityLines,
} from "../src/status-widget.js";

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

test("Stage B spinner matches Pi's working-loader defaults", () => {
  assert.deepEqual([...SPINNER_FRAMES], ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);
  assert.equal(SPINNER_INTERVAL_MS, 80);
});

test("live ACP events render the spinner, muted text, and the real event rate", () => {
  const { model, now } = testClock();
  model.startLive("run-pelican-runner", "executor", "agent_thought_chunk");
  const lines = formatActivityLines(model.snapshot(now()), theme, 200, now());
  assert.equal(lines[0], " Execution & Review · run-pelican-runner");
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

test("workflow status shows phase/round, role states, and the message", () => {
  const { model, now } = testClock();
  model.applyStatus({
    phase_id: "phase-1-core-sim",
    round: 2,
    executor_status: "running",
    reviewer_status: "pending",
    message: "Executor resuming same session after feedback.",
  });
  const lines = formatActivityLines(model.snapshot(now()), theme, 200, now());
  assert.equal(lines[0], " Execution & Review · phase-1-core-sim · round 2");
  assert.equal(lines[1], " <accent>⠋</accent> <muted>Executor running · Reviewer pending</muted>");
  assert.equal(lines[2], " <muted>Executor resuming same session after feedback.</muted>");
});

test("a stopping status renders statically without a spinner", () => {
  const { model, now } = testClock();
  model.applyStatus({
    phase_id: "phase-1",
    round: 2,
    executor_status: "failed",
    reviewer_status: "failed",
    message: "paused",
  });
  const line = formatActivityLines(model.snapshot(now()), theme, 200, now())[1]!;
  assert.equal(line, "   <muted>Executor failed · Reviewer failed</muted>");
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

  model.startLive("run-1", "executor", "tool_call");
  assert.equal(widget.spinning, true);
  widget.dispose();
  assert.equal(widget.spinning, false);

  model.startLive("run-1", "executor", "tool_call");
  assert.equal(widget.spinning, false);
});

test("rendered lines never exceed the available width", () => {
  const { model, now } = testClock();
  const plain = { fg: (_token: string, text: string) => text };
  model.startLive("run-with-a-very-long-identifier", "executor", "agent_thought_chunk".repeat(3));
  for (const width of [10, 20, 40]) {
    for (const line of formatActivityLines(model.snapshot(now()), plain, width, now())) {
      assert.ok(visibleWidth(line) <= width, `"${line}" exceeds width ${width}`);
    }
  }
  model.applyStatus({
    phase_id: "phase-1",
    round: 2,
    executor_status: "running",
    reviewer_status: "pending",
    message: "m".repeat(100),
  });
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
    " Execution & Review · run-1 <dim>· 30m left</dim>",
  );
  advance(26 * 60 * 1000);
  assert.equal(
    formatActivityLines(model.snapshot(now()), theme, 200, now())[0],
    " Execution & Review · run-1 <warning>· 4m left</warning>",
  );
  model.stop();
  assert.equal(
    formatActivityLines(model.snapshot(now()), theme, 200, now())[0],
    " Execution & Review · run-1",
  );
});

test("no-timeout runs never render a budget readout", () => {
  const { model, now } = testClock();
  model.startLive("run-1", "executor", "agent_thought_chunk");
  model.setBudget(now(), 0);
  assert.equal(formatActivityLines(model.snapshot(now()), theme, 200, now())[0], " Execution & Review · run-1");
  model.setBudget(now(), 30 * 60 * 1000);
  assert.match(formatActivityLines(model.snapshot(now()), theme, 200, now())[0]!, /30m left/);
  model.setBudget(now(), 0);
  assert.equal(formatActivityLines(model.snapshot(now()), theme, 200, now())[0], " Execution & Review · run-1");
});
