import type {
  AcceptanceCommandRunner,
  AcceptanceContract,
  AcceptanceResult,
  GitCommandResult,
} from "./types.js";

const MAX_CAPTURE_BYTES = 50_000;

function truncate(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= MAX_CAPTURE_BYTES) return value;
  const bytes = Buffer.from(value, "utf8");
  return `${bytes.subarray(0, MAX_CAPTURE_BYTES).toString("utf8")}\n[output truncated]`;
}

function resultFromCommand(
  test: { id: string; command: string; required: boolean },
  result: GitCommandResult,
): AcceptanceResult {
  return {
    id: test.id,
    command: test.command,
    required: test.required,
    exit_code: result.killed ? null : result.code,
    passed: !result.killed && result.code === 0,
    stdout: truncate(result.stdout),
    stderr: truncate(result.stderr),
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
    if (!test.required) {
      results.push({
        id: test.id,
        command: test.command,
        required: false,
        exit_code: 0,
        passed: true,
        stdout: "",
        stderr: "",
      });
      continue;
    }
    const commandResult = await runner.run(test.command, options);
    results.push(resultFromCommand(test, commandResult));
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
