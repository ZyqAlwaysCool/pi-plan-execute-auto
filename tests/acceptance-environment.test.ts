import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACCEPTANCE_SANDBOX_MOUNTS,
  describeAcceptanceSandbox,
  leadingExecutable,
  planAcceptanceProbes,
} from "../src/acceptance-environment.js";
import {
  DEFAULT_ACCEPTANCE_TIMEOUT_MS,
  MAX_ACCEPTANCE_TIMEOUT_MS,
  MIN_ACCEPTANCE_TIMEOUT_MS,
  acceptanceFailureFingerprint,
  acceptanceTestTimeoutMs,
  clampAcceptanceTimeoutMs,
  formatAcceptanceDiagnosis,
  runAcceptance,
} from "../src/acceptance.js";
import type { AcceptanceContract, AcceptanceSelfTest, GitCommandResult } from "../src/types.js";

function selfTest(id: string, command: string, extra: Partial<AcceptanceSelfTest> = {}): AcceptanceSelfTest {
  return { id, command, required: true, ...extra };
}

test("sandbox contract description names every mount and the PATH consequence", () => {
  const lines = describeAcceptanceSandbox();
  for (const mount of ACCEPTANCE_SANDBOX_MOUNTS) {
    assert.ok(lines.some((line) => line.includes(mount.split(" (")[0] ?? mount)), mount);
  }
  assert.ok(lines.some((line) => line.includes("PATH order")));
  assert.ok(lines.some((line) => line.includes("repository-relative path")));
});

test("leading executable skips assignments, wrappers, and shell builtins", () => {
  assert.equal(leadingExecutable("go test ./..."), "go");
  assert.equal(leadingExecutable("  npm run check"), "npm");
  assert.equal(leadingExecutable("FOO=bar BAZ=1 go test ./..."), "go");
  assert.equal(leadingExecutable("timeout 7200 bash scripts/test.sh full"), "bash");
  assert.equal(leadingExecutable("env A=1 python -m pytest"), "python");
  assert.equal(leadingExecutable("cd sub && go test"), "go");
  assert.equal(leadingExecutable("[[ -f x ]] && echo ok"), undefined);
  assert.equal(leadingExecutable("echo hello"), undefined);
  // Compound shell syntax still yields the real command so an unrunnable gate is caught.
  assert.equal(leadingExecutable("if true; then go test; fi"), "go");
  assert.equal(leadingExecutable("$RUNNER test"), undefined);
  assert.equal(leadingExecutable(""), undefined);
});

test("probe plan covers declared requirements and implicit leading executables", () => {
  const probes = planAcceptanceProbes([
    selfTest("unit", "go test ./...", { requires: ["go", "./.cache/toolchain/bin/go"] }),
    selfTest("race", "bash scripts/test-agent.sh race", { requires: ["bash"] }),
    { id: "optional", command: "missing-tool --flag", required: false },
  ]);
  const targets = probes.map((probe) => `${probe.kind}:${probe.target}`);
  assert.deepEqual(targets, [
    "command:go",
    "executable-path:./.cache/toolchain/bin/go",
    "command:bash",
  ]);
  const pathProbe = probes.find((probe) => probe.kind === "executable-path");
  assert.equal(pathProbe?.command, "test -x './.cache/toolchain/bin/go'");
  const commandProbe = probes.find((probe) => probe.target === "bash");
  assert.equal(commandProbe?.command, "command -v -- 'bash' >/dev/null 2>&1");
});

test("probe plan is deduplicated and bounded", () => {
  const selfTests = Array.from({ length: 40 }, (_, index) => selfTest(`t${index}`, "node --test"));
  const probes = planAcceptanceProbes(selfTests, { maxProbes: 5 });
  assert.equal(probes.length, 1);
  const many = Array.from({ length: 40 }, (_, index) => selfTest(`t${index}`, `tool${index} --run`));
  assert.equal(planAcceptanceProbes(many, { maxProbes: 5 }).length, 5);
});

test("per-test timeout overrides the plugin budget and is validated", () => {
  assert.equal(acceptanceTestTimeoutMs({ timeout_ms: 900_000 }, 600_000), 900_000);
  assert.equal(acceptanceTestTimeoutMs({}, 600_000), 600_000);
  assert.equal(acceptanceTestTimeoutMs({ timeout_ms: 1 }, 600_000), 600_000);
  assert.equal(acceptanceTestTimeoutMs({}, undefined), DEFAULT_ACCEPTANCE_TIMEOUT_MS);
  assert.equal(clampAcceptanceTimeoutMs("900000"), 900_000);
  assert.equal(clampAcceptanceTimeoutMs("1"), MIN_ACCEPTANCE_TIMEOUT_MS);
  assert.equal(clampAcceptanceTimeoutMs("999999999"), MAX_ACCEPTANCE_TIMEOUT_MS);
  assert.equal(clampAcceptanceTimeoutMs("nonsense"), DEFAULT_ACCEPTANCE_TIMEOUT_MS);
  assert.equal(clampAcceptanceTimeoutMs(undefined), DEFAULT_ACCEPTANCE_TIMEOUT_MS);
});

test("acceptance passes the per-test budget to the runner and marks timeouts", async () => {
  const contract: AcceptanceContract = {
    version: 1,
    phase_id: "phase-01",
    scope: { allowed_paths: ["src/**"] },
    self_tests: [
      selfTest("fast", "true"),
      selfTest("slow", "run-slow", { timeout_ms: 900_000 }),
      { id: "optional", command: "skipped", required: false },
    ],
    review: { require_no_blocking_findings: true },
    commit: { required: true, allow_empty: false },
  };
  const seen: Array<{ command: string; timeout: number | undefined }> = [];
  const results = await runAcceptance(contract, {
    async run(command, options): Promise<GitCommandResult> {
      seen.push({ command, timeout: options?.timeout });
      if (command === "run-slow") return { stdout: "", stderr: "killed", code: -1, killed: true, timed_out: true };
      return { stdout: "ok", stderr: "", code: 0 };
    },
  }, { timeout: 600_000 });

  assert.deepEqual(seen, [
    { command: "true", timeout: 600_000 },
    { command: "run-slow", timeout: 900_000 },
  ]);
  assert.equal(results[0]?.timeout_ms, 600_000);
  assert.equal(results[1]?.timed_out, true);
  assert.equal(results[1]?.exit_code, null);
  assert.equal(results[1]?.timeout_ms, 900_000);
  assert.equal(results[2]?.passed, true);
  assert.equal(results[2]?.timeout_ms, 600_000);
  const diagnosis = formatAcceptanceDiagnosis(results);
  assert.match(diagnosis, /slow: timed out after 900s/u);
  assert.match(diagnosis, /timeout_ms/u);
});

test("failure fingerprint ignores volatile output but changes with the failing id", () => {
  const base = { command: "x", required: true, passed: false, exit_code: 1, stdout: "", timeout_ms: 1000 };
  const first = acceptanceFailureFingerprint([{ ...base, id: "unit", stderr: "boom at line 1" }]);
  const second = acceptanceFailureFingerprint([{ ...base, id: "unit", stderr: "boom at line 2" }]);
  const other = acceptanceFailureFingerprint([{ ...base, id: "race", stderr: "boom at line 1" }]);
  const timeout = acceptanceFailureFingerprint([{ ...base, id: "unit", stderr: "", exit_code: null, timed_out: true }]);
  const alsoTimeout = acceptanceFailureFingerprint([{ ...base, id: "unit", stderr: "different text", exit_code: null, timed_out: true }]);
  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.notEqual(first, timeout);
  assert.equal(timeout, alsoTimeout);
  assert.equal(acceptanceFailureFingerprint([{ ...base, id: "unit", stderr: "", passed: true }]), undefined);
  assert.equal(acceptanceFailureFingerprint([{ ...base, id: "unit", stderr: "", required: false }]), undefined);
});
