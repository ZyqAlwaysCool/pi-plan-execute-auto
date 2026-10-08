import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import planExecuteAuto, {
  STOP_SHORTCUT,
  activeRunIds,
  humanStopReason,
  requestRunStop,
  startStageBInBackground,
  stopAllActiveRuns,
  trackActiveRun,
  untrackActiveRun,
} from "../extensions/index.js";
import type { StageBAbortReason, StageBRunResult, WorkflowState } from "../src/types.js";

const STATE = {
  version: 1,
  run_id: "run-1",
  package_hash: "a".repeat(64),
  package_dir: "/tmp/run-1",
  status: "running",
  created_at: new Date(0).toISOString(),
  phases: [],
} as WorkflowState;

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("background Stage B returns immediately and reports terminal results", async () => {
  const notices: Array<{ message: string; type: string }> = [];
  let resolve!: (result: StageBRunResult) => void;
  const pending = new Promise<StageBRunResult>((resolvePromise) => {
    resolve = resolvePromise;
  });
  startStageBInBackground({
    start: () => pending,
    notify: (message, type) => notices.push({ message, type }),
    completed: (status) => `done:${status}`,
  });
  // The launcher must not await; the caller (a typed command handler) has already returned.
  assert.deepEqual(notices, []);
  resolve({ status: "completed", state: STATE });
  await flush();
  assert.deepEqual(notices, [{ message: "done:completed", type: "info" }]);
});

test("background Stage B reports not_started, pauses silently, and surfaces errors", async () => {
  const notices: Array<{ message: string; type: string }> = [];
  const notify = (message: string, type: string): void => {
    notices.push({ message, type });
  };

  startStageBInBackground({
    start: async () => ({ status: "not_started", state: STATE, reason: "dirty worktree" }),
    notify,
    notStarted: (reason) => `custom:${reason ?? "none"}`,
  });
  startStageBInBackground({ start: async () => ({ status: "paused", state: STATE }), notify });
  startStageBInBackground({ start: async () => { throw new Error("boom"); }, notify });
  await flush();

  assert.deepEqual(notices, [
    { message: "custom:dirty worktree", type: "warning" },
    // `paused` is intentionally silent: persistAndEscalatePause already notified with the cause.
    { message: "boom", type: "error" },
  ]);
});

test("the active-run registry tracks, stops, and untracks runs", () => {
  assert.deepEqual(activeRunIds(), []);
  const first = new AbortController();
  const second = new AbortController();
  trackActiveRun("run-1", { controller: first, startedAt: new Date().toISOString() });
  trackActiveRun("run-2", { controller: second, startedAt: new Date().toISOString() });
  assert.deepEqual(activeRunIds().sort(), ["run-1", "run-2"]);
  assert.equal(requestRunStop("missing", humanStopReason()), false);
  assert.equal(requestRunStop("run-1", humanStopReason()), true);
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, false);

  const stopped = stopAllActiveRuns({ kind: "session_abort", message: "Pi session is shutting down." });
  assert.deepEqual(stopped, ["run-1", "run-2"]);
  assert.equal((second.signal.reason as StageBAbortReason).kind, "session_abort");
  untrackActiveRun("run-1");
  untrackActiveRun("run-2");
  assert.deepEqual(activeRunIds(), []);
});

test("the factory registers a stop shortcut and aborts active runs on session shutdown", async () => {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const shortcuts: Array<{ key: string; handler: (ctx: unknown) => unknown }> = [];
  const pi = {
    registerTool() {},
    registerCommand() {},
    registerEntryRenderer() {},
    registerShortcut(key: string, options: { handler: (ctx: unknown) => unknown }) {
      shortcuts.push({ key, handler: options.handler });
    },
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  planExecuteAuto(pi);

  assert.equal(shortcuts.length, 1);
  assert.equal(shortcuts[0]!.key, STOP_SHORTCUT);
  const notices: string[] = [];
  const ctx = {
    hasUI: true,
    cwd: "/tmp",
    ui: {
      notify(message: string) { notices.push(message); },
      setWidget() {},
    },
  } as unknown as ExtensionContext;

  // No active run: warn, do not abort anything.
  shortcuts[0]!.handler(ctx);
  assert.match(notices.join("\n"), /No active plan-execute Execution & Review run to stop/);

  const controller = new AbortController();
  trackActiveRun("run-1", { controller, startedAt: new Date().toISOString() });
  shortcuts[0]!.handler(ctx);
  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(controller.signal.reason, { kind: "human_stop", message: "Execution & Review stopped by human." });
  assert.match(notices.join("\n"), /Stop requested for run-1/);
  untrackActiveRun("run-1");

  const shutdown = new AbortController();
  trackActiveRun("run-2", { controller: shutdown, startedAt: new Date().toISOString() });
  const shutdownHandlers = handlers.get("session_shutdown") ?? [];
  const pending = shutdownHandlers.map((handler) => handler({ type: "session_shutdown", reason: "quit" }, ctx));
  assert.equal(shutdown.signal.aborted, true);
  assert.deepEqual(shutdown.signal.reason, { kind: "session_abort", message: "Pi session is shutting down." });
  // The real run untracks itself from Stage B's finally block; the bounded drain
  // then returns without waiting for the full grace period.
  untrackActiveRun("run-2");
  await Promise.all(pending);
});
