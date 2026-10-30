import type {
  AcceptanceCommandRunner,
  AcceptanceContract,
  AcceptanceResult,
  AcceptanceSelfTest,
  GitCommandResult,
} from "./types.js";

const MAX_CAPTURE_BYTES = 50_000;

/**
 * Bounds for the deterministic acceptance command budget.
 *
 * The historic plugin default was a hard-coded two minutes. That is long enough for a warm unit
 * suite and far too short for real gates (`go test -race`, browser suites, container smoke tests),
 * so legitimately slow gates were killed and reported as anonymous failures. The budget is now a
 * documented, contract-overridable value with a default sized for real gates.
 */
export const DEFAULT_ACCEPTANCE_TIMEOUT_MS = 10 * 60 * 1000;
export const MIN_ACCEPTANCE_TIMEOUT_MS = 5 * 1000;
export const MAX_ACCEPTANCE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export function isValidAcceptanceTimeoutMs(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) &&
    value >= MIN_ACCEPTANCE_TIMEOUT_MS && value <= MAX_ACCEPTANCE_TIMEOUT_MS;
}

/** Clamp an unvalidated budget (environment variable, CLI option) into the supported range. */
export function clampAcceptanceTimeoutMs(value: unknown, fallback = DEFAULT_ACCEPTANCE_TIMEOUT_MS): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  const rounded = Math.round(parsed);
  if (rounded < MIN_ACCEPTANCE_TIMEOUT_MS) return MIN_ACCEPTANCE_TIMEOUT_MS;
  if (rounded > MAX_ACCEPTANCE_TIMEOUT_MS) return MAX_ACCEPTANCE_TIMEOUT_MS;
  return rounded;
}

/** Effective budget for one self-test: contract override first, plugin-wide budget second. */
export function acceptanceTestTimeoutMs(
  test: Pick<AcceptanceSelfTest, "timeout_ms">,
  fallback: number | undefined,
): number {
  return isValidAcceptanceTimeoutMs(test.timeout_ms) ? test.timeout_ms : clampAcceptanceTimeoutMs(fallback);
}

function truncate(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= MAX_CAPTURE_BYTES) return value;
  const bytes = Buffer.from(value, "utf8");
  return `${bytes.subarray(0, MAX_CAPTURE_BYTES).toString("utf8")}\n[output truncated]`;
}

function resultFromCommand(test: AcceptanceSelfTest, result: GitCommandResult, timeoutMs: number): AcceptanceResult {
  const timedOut = result.timed_out === true;
  return {
    id: test.id,
    command: test.command,
    required: test.required,
    exit_code: result.killed ? null : result.code,
    passed: !result.killed && result.code === 0,
    stdout: truncate(result.stdout),
    stderr: truncate(result.stderr),
    ...(timedOut ? { timed_out: true } : {}),
    timeout_ms: timeoutMs,
  };
}

export async function runAcceptance(
  contract: AcceptanceContract,
  runner: AcceptanceCommandRunner,
  options?: { signal?: AbortSignal; timeout?: number },
): Promise<AcceptanceResult[]> {
  const results: AcceptanceResult[] = [];
  for (const test of contract.self_tests) {
    if (options?.signal?.aborted) throw options.signal.reason ?? new Error("Acceptance cancelled.");
    const timeoutMs = acceptanceTestTimeoutMs(test, options?.timeout);
    if (!test.required) {
      results.push({
        id: test.id,
        command: test.command,
        required: false,
        exit_code: 0,
        passed: true,
        stdout: "",
        stderr: "",
        timeout_ms: timeoutMs,
      });
      continue;
    }
    const commandResult = await runner.run(test.command, {
      ...(options?.signal ? { signal: options.signal } : {}),
      timeout: timeoutMs,
    });
    results.push(resultFromCommand(test, commandResult, timeoutMs));
  }
  return results;
}

export function requiredAcceptancePassed(results: readonly AcceptanceResult[]): boolean {
  return results.every((result) => !result.required || result.passed);
}

export function formatAcceptanceResults(results: readonly AcceptanceResult[]): string {
  if (results.length === 0) return "No acceptance commands declared.";
  return results
    .map((result) => `${result.passed ? "PASS" : "FAIL"} ${result.id}: ${result.command}`)
    .join("\n");
}

/**
 * Stable structural descriptor of *why* acceptance failed: which required gate failed, whether it
 * was killed by the budget, and its exit code. Command output is deliberately excluded because
 * real gates print timestamps, temp paths, and durations, so an output hash would almost never
 * repeat and the guard would never fire.
 *
 * The plugin uses this to notice that a rework round produced exactly the same failure again —
 * which in practice means the executor cannot fix it (environment, missing tool, expired budget)
 * and the remaining review rounds would be burned for nothing.
 */
export function acceptanceFailureFingerprint(results: readonly AcceptanceResult[]): string | undefined {
  const failed = results
    .filter((result) => result.required && !result.passed)
    .map((result) => [
      result.id,
      result.timed_out === true ? "timeout" : "failure",
      result.exit_code === null ? "null" : String(result.exit_code),
    ].join(":"))
    .sort();
  if (failed.length === 0) return undefined;
  return failed.join("|");
}

/** Human-readable per-failure diagnosis, including budget advice for timeouts. */
export function formatAcceptanceDiagnosis(results: readonly AcceptanceResult[]): string {
  const failed = results.filter((result) => result.required && !result.passed);
  if (failed.length === 0) return "All required deterministic acceptance commands passed.";
  return failed
    .map((result) => {
      if (result.timed_out === true) {
        const budget = result.timeout_ms !== undefined ? `${Math.round(result.timeout_ms / 1000)}s` : "its budget";
        return `${result.id}: timed out after ${budget} (exit_code=null). The command was killed by the plugin, not by the project: declare a larger self_tests[].timeout_ms, or raise PI_PLAN_EXECUTE_ACCEPTANCE_TIMEOUT_MS, then rerun.`;
      }
      if (result.exit_code === null) {
        return `${result.id}: terminated without an exit code (signal or abort), not a project assertion failure.`;
      }
      return `${result.id}: exited ${result.exit_code}.`;
    })
    .join("\n");
}
