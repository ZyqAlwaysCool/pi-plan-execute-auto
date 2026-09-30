import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RESUMABLE_PAUSE_CODES,
  abortPauseInput,
  createPauseRecord,
  formatDuration,
  formatDurationShort,
  formatPauseHeadline,
  formatPauseReason,
  formatStageTimeout,
  isStageBAbortReason,
  parseStageTimeoutValue,
  pauseResumable,
} from "../src/pause.js";

test("resumability is explicit and only covers execution interruptions", () => {
  for (const code of ["ABORTED", "TIMEOUT", "HUMAN_STOP", "SESSION_ABORT", "HARNESS_ERROR", "PROCESS_RESTART", "PROCESS_RESTART_RECONCILED"]) {
    assert.equal(pauseResumable(code), true, code);
    assert.ok(RESUMABLE_PAUSE_CODES.has(code), code);
  }
  for (const code of ["MAX_REVIEW_ROUNDS", "STARTUP_EVIDENCE", "REVIEWER_CHANGED_WORKSPACE", "UNKNOWN_CODE", undefined]) {
    assert.equal(pauseResumable(code), false, String(code));
  }
});

test("createPauseRecord fills defaults and keeps explicit overrides", () => {
  const record = createPauseRecord(
    { code: "TIMEOUT", summary: "Timed out.", stage: "executor", timeout_ms: 1_000, elapsed_ms: 1_000 },
    "2026-01-01T00:00:00.000Z",
  );
  assert.deepEqual(record, {
    code: "TIMEOUT",
    summary: "Timed out.",
    stage: "executor",
    resumable: true,
    timeout_ms: 1_000,
    elapsed_ms: 1_000,
    at: "2026-01-01T00:00:00.000Z",
  });
  const needsRepair = createPauseRecord({ code: "REVIEWER_CHANGED_WORKSPACE", summary: "changed", resumable: false });
  assert.equal(needsRepair.stage, "unknown");
  assert.equal(needsRepair.resumable, false);
  assert.equal(Object.hasOwn(needsRepair, "detail"), false);
});

test("typed abort reasons classify into precise pause codes", () => {
  assert.deepEqual(
    abortPauseInput(
      { kind: "timeout", message: "raw timeout text", timeoutMs: 1_800_000, elapsedMs: 1_800_000 },
      { stage: "executor", summary: "fallback" },
    ),
    {
      code: "TIMEOUT",
      stage: "executor",
      summary: "Stage B timed out after 30 minutes.",
      detail: "raw timeout text",
      timeout_ms: 1_800_000,
      elapsed_ms: 1_800_000,
    },
  );
  assert.equal(abortPauseInput({ kind: "human_stop", message: "stop" }, { stage: "reviewer", summary: "cancelled" }).code, "HUMAN_STOP");
  assert.equal(abortPauseInput({ kind: "session_abort", message: "sigint" }, { stage: "phase", summary: "cancelled" }).code, "SESSION_ABORT");
  const legacy = abortPauseInput(new Error("legacy cancel"), { stage: "executor", summary: "cancelled" });
  assert.equal(legacy.code, "ABORTED");
  assert.equal(legacy.detail, "legacy cancel");
  assert.equal(abortPauseInput(undefined, { stage: "unknown", summary: "cancelled" }).detail, undefined);

  assert.equal(isStageBAbortReason({ kind: "timeout", message: "x" }), true);
  assert.equal(isStageBAbortReason({ kind: "other", message: "x" }), false);
  assert.equal(isStageBAbortReason(new Error("x")), false);
  assert.equal(isStageBAbortReason(null), false);
});

test("pause formatting is stable and resumability-aware", () => {
  const record = createPauseRecord({
    code: "TIMEOUT",
    summary: "Stage B timed out after 30 minutes.",
    stage: "executor",
    round: 2,
    timeout_ms: 1_800_000,
  });
  assert.equal(formatPauseReason(record), "[TIMEOUT] Stage B timed out after 30 minutes.");
  assert.equal(
    formatPauseHeadline(record),
    "TIMEOUT · Stage B timed out after 30 minutes. (executor, round 2) · resumable",
  );
  const fatal = createPauseRecord({ code: "STARTUP_EVIDENCE", summary: "bad evidence", stage: "setup" });
  assert.equal(formatPauseHeadline(fatal), "STARTUP_EVIDENCE · bad evidence (setup) · needs repair");
});

test("duration and stage-timeout formatting cover minutes, hours, and unlimited", () => {
  assert.equal(formatDuration(45_000), "45 seconds");
  assert.equal(formatDuration(60_000), "1 minute");
  assert.equal(formatDuration(90 * 60_000), "1 hour 30 minutes");
  assert.equal(formatDuration(2 * 60 * 60_000), "2 hours");
  assert.equal(formatDurationShort(90 * 60_000), "1h30m");
  assert.equal(formatDurationShort(29 * 60_000), "29m");
  assert.equal(formatDurationShort(45_000), "45s");
  assert.equal(formatStageTimeout(0), "No timeout");
  assert.equal(formatStageTimeout(undefined), "30 minutes");
  assert.equal(formatStageTimeout(15 * 60_000), "15 minutes");

  assert.equal(parseStageTimeoutValue("none"), 0);
  assert.equal(parseStageTimeoutValue("UNLIMITED"), 0);
  assert.equal(parseStageTimeoutValue("off"), 0);
  assert.equal(parseStageTimeoutValue("45"), 30 * 60_000);
  assert.equal(parseStageTimeoutValue("99999999999"), 30 * 60_000);
  assert.equal(parseStageTimeoutValue("nonsense"), 30 * 60_000);
  assert.equal(parseStageTimeoutValue(""), 30 * 60_000);
  assert.equal(parseStageTimeoutValue(5 * 60_000), 5 * 60_000);
  assert.equal(parseStageTimeoutValue(0), 0);
  assert.equal(parseStageTimeoutValue(undefined), 30 * 60_000);
});
