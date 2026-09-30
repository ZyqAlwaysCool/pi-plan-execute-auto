/**
 * Pause classification and formatting.
 *
 * Stage B used to collapse every abort (watchdog timeout, human stop, session
 * interruption, harness error) into a single `[ABORTED] ... was cancelled`
 * string, so users could not tell a resumable interruption from a safety stop.
 * This module keeps the cause structured all the way to the persisted state,
 * the run event log, and the TUI.
 */
import {
  DEFAULT_STAGE_TIMEOUT_MS,
  isValidStageTimeoutMs,
  type PauseCode,
  type PauseInput,
  type PauseRecord,
  type PauseStage,
  type StageBAbortReason,
} from "./types.js";

/** Interruptions that carry no evidence/safety failure and may be explicitly resumed. */
export const RESUMABLE_PAUSE_CODES: ReadonlySet<string> = new Set([
  "ABORTED",
  "TIMEOUT",
  "HUMAN_STOP",
  "SESSION_ABORT",
  "HARNESS_ERROR",
  "PROCESS_RESTART",
  "PROCESS_RESTART_RECONCILED",
]);

export function pauseResumable(code: PauseCode | undefined): boolean {
  return typeof code === "string" && RESUMABLE_PAUSE_CODES.has(code);
}

export function isStageBAbortReason(value: unknown): value is StageBAbortReason {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<StageBAbortReason>;
  return (candidate.kind === "timeout" || candidate.kind === "human_stop" || candidate.kind === "session_abort") &&
    typeof candidate.message === "string";
}

export function createPauseRecord(input: PauseInput, at = new Date().toISOString()): PauseRecord {
  return {
    code: input.code,
    summary: input.summary,
    ...(input.detail !== undefined && input.detail !== "" ? { detail: input.detail } : {}),
    stage: input.stage ?? "unknown",
    resumable: input.resumable ?? pauseResumable(input.code),
    ...(input.phase_id !== undefined ? { phase_id: input.phase_id } : {}),
    ...(input.round !== undefined ? { round: input.round } : {}),
    ...(input.timeout_ms !== undefined ? { timeout_ms: input.timeout_ms } : {}),
    ...(input.elapsed_ms !== undefined ? { elapsed_ms: input.elapsed_ms } : {}),
    at,
  };
}

/**
 * Translate an `AbortSignal.reason` into a pause input. Untyped aborts keep the
 * legacy `ABORTED` code so older integrations and persisted checkpoints resume
 * exactly as before; typed aborts get a precise, user-visible cause.
 */
export function abortPauseInput(
  reason: unknown,
  fallback: { stage: PauseStage; summary: string },
): PauseInput {
  if (isStageBAbortReason(reason)) {
    if (reason.kind === "timeout") {
      const budget = reason.elapsedMs ?? reason.timeoutMs;
      return {
        code: "TIMEOUT",
        stage: fallback.stage,
        summary: budget !== undefined
          ? `Stage B timed out after ${formatDuration(budget)}.`
          : "Stage B timed out.",
        ...(reason.message ? { detail: reason.message } : {}),
        ...(reason.timeoutMs !== undefined ? { timeout_ms: reason.timeoutMs } : {}),
        ...(reason.elapsedMs !== undefined ? { elapsed_ms: reason.elapsedMs } : {}),
      };
    }
    if (reason.kind === "human_stop") {
      return {
        code: "HUMAN_STOP",
        stage: fallback.stage,
        summary: fallback.summary,
        ...(reason.message ? { detail: reason.message } : {}),
      };
    }
    return {
      code: "SESSION_ABORT",
      stage: fallback.stage,
      summary: fallback.summary,
      ...(reason.message ? { detail: reason.message } : {}),
    };
  }
  const detail = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : undefined;
  return {
    code: "ABORTED",
    stage: fallback.stage,
    summary: fallback.summary,
    ...(detail !== undefined && detail !== "" ? { detail } : {}),
  };
}

/** "[TIMEOUT] Stage B timed out after 30 minutes." — the legacy one-line reason. */
export function formatPauseReason(record: PauseRecord): string {
  return `[${record.code}] ${record.summary}`;
}

/** "TIMEOUT · Stage B timed out after 30 minutes. (executor, round 2) · resumable" */
export function formatPauseHeadline(record: PauseRecord): string {
  const where = [
    record.stage !== "unknown" ? record.stage : undefined,
    record.round !== undefined ? `round ${record.round}` : undefined,
  ].filter((value): value is string => value !== undefined).join(", ");
  const headline = `${record.code} · ${record.summary}${where ? ` (${where})` : ""}`;
  return `${headline} · ${record.resumable ? "resumable" : "needs repair"}`;
}

/** Bounded diagnostic lines for notifications and escalation summaries. */
export function formatPauseDetails(record: PauseRecord): string[] {
  return [
    `Cause: ${record.code} · ${record.summary}`,
    ...(record.detail && record.detail !== record.summary ? [`Detail: ${record.detail}`] : []),
    `Stage: ${record.stage}${record.round !== undefined ? ` · round ${record.round}` : ""}`,
    record.resumable
      ? "This is a resumable interruption; completed phases are re-verified and skipped on resume."
      : "This pause requires human repair; resume is refused until the evidence is restored.",
  ];
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return plural(totalSeconds, "second");
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return plural(totalMinutes, "minute");
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${plural(hours, "hour")} ${plural(minutes, "minute")}` : plural(hours, "hour");
}

/** Compact label for live UI, for example `29m`, `1h05m`, `45s`. */
export function formatDurationShort(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h${String(minutes).padStart(2, "0")}m` : `${hours}h`;
}

/** Human label for a configured whole-run budget; `0` means no timeout. */
export function formatStageTimeout(ms: number | undefined): string {
  if (ms === undefined) return formatDuration(DEFAULT_STAGE_TIMEOUT_MS);
  return ms === 0 ? "No timeout" : formatDuration(ms);
}

/**
 * Resolve a configured budget from a profile value or the headless env
 * fallback. `0`, `none`, `unlimited`, and `off` mean no timeout; malformed
 * values fall back to the recommended default instead of silently disabling it.
 */
export function parseStageTimeoutValue(raw: unknown): number {
  if (typeof raw === "number" && isValidStageTimeoutMs(raw)) return raw;
  if (typeof raw !== "string") return DEFAULT_STAGE_TIMEOUT_MS;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "") return DEFAULT_STAGE_TIMEOUT_MS;
  if (trimmed === "none" || trimmed === "unlimited" || trimmed === "off") return 0;
  const parsed = Number(trimmed);
  return isValidStageTimeoutMs(parsed) ? parsed : DEFAULT_STAGE_TIMEOUT_MS;
}

function plural(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
}
