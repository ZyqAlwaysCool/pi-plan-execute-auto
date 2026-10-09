// Explicit, billable end-to-end ACP checks for the additional built-in backends.
import { execFile as callback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentPrismSessionPair } from "../src/agent-prism.js";
import { createLocalGitOperations, GitWorkspace } from "../src/git.js";
import { validatePackageDirectory, writeValidatedPackage, writeWorkflowState } from "../src/package-validator.js";
import { findBubblewrap, runSandboxedCommand, supportedBackendForModel } from "../src/sandbox.js";
import { StageBController } from "../src/stage-b.js";
import { createDraftState, loadValidatedRun } from "../src/workflow-state.js";
import type { FinalizeInput } from "../src/types.js";

const git = promisify(callback);
if (process.env.PI_PLAN_EXECUTE_ACCEPT_ACP_NETWORK_RISK !== "1") {
  throw new Error("Live ACP fixtures require explicit ACP network-risk acknowledgement for a non-sensitive test repo.");
}
findBubblewrap();

async function fixture(run: (ctx: { source: string; cwd: string; golden: string; base: string }) => Promise<void>, branch = false): Promise<void> {
  const root = await mkdtemp(join(dirname(process.cwd()), ".peac-builtin-acp-"));
  const source = join(root, "source");
  const cwd = branch ? join(root, ".pi-plan-execute-auto-worktrees", "live") : join(root, "worktree");
  const golden = join(source, ".pi-plan-execute-auto", "live");
  try {
    if (!branch) await mkdir(golden, { recursive: true });
    await git("git", ["init", "-q", source]);
    await git("git", ["-C", source, "config", "user.name", "Fixture"]);
    await git("git", ["-C", source, "config", "user.email", "test@example.invalid"]);
    await writeFile(join(source, ".gitignore"), ".pi-plan-execute-auto/\n");
    await writeFile(join(source, "sample.txt"), "initial\n");
    await git("git", ["-C", source, "add", "."]);
    await git("git", ["-C", source, "commit", "-qm", "base"]);
    await mkdir(dirname(cwd), { recursive: true });
    await git("git", ["-C", source, "worktree", "add", "-q", ...(branch ? ["-b", "pi-plan-execute-auto/live"] : ["--detach"]), cwd]);
    const base = (await git("git", ["-C", cwd, "rev-parse", "HEAD"])).stdout.trim();
    await run({ source, cwd, golden, base });
  } finally { await rm(root, { recursive: true, force: true }); }
}

const requestedBuiltins = (process.env.PI_PLAN_EXECUTE_ACP_TEST_BUILTINS ?? "claude,pi")
  .split(",")
  .map((value) => value.trim())
  .filter((value): value is "claude" | "pi" => value === "claude" || value === "pi");
if (requestedBuiltins.length === 0) throw new Error("PI_PLAN_EXECUTE_ACP_TEST_BUILTINS must include claude and/or pi.");

for (const backend of requestedBuiltins) {
  const model = process.env[`PI_PLAN_EXECUTE_ACP_TEST_${backend.toUpperCase()}_MODEL`];
  if (!model || supportedBackendForModel(model) !== backend) {
    throw new Error(`Explicit PI_PLAN_EXECUTE_ACP_TEST_${backend.toUpperCase()}_MODEL=${backend}/<model> is required.`);
  }
  test(`${backend} real sandboxed Executor edits only worktree and returns structured output at high`, { timeout: 210_000 }, async () => {
    await fixture(async ({ source, cwd, golden, base }) => {
      const pair = new AgentPrismSessionPair({ cwd, sourceRoot: source, goldenRoot: golden, executorModel: model, reasoningEffort: "high" });
      const abort = AbortSignal.timeout(175_000);
      try {
        const result = await pair.execute([
          `phase_base_commit: ${base}`, "phase_id: phase-01", "round: 1",
          "Change sample.txt from initial to implemented (with a newline). Do not stage or commit.",
          "Actually run test -f sample.txt. Return a structured execution report with phase_id, round, base_commit, status: complete, summary, changed_files, self_tests: [{id: 'unit', command: 'test -f sample.txt', status: 'passed'}], resolved_findings, known_issues.",
        ].join("\n"), 1, { phaseBaseCommit: base, signal: abort });
        assert.equal(result.phase_id, "phase-01");
        assert.equal(result.status, "complete");
        assert.equal(await readFile(join(cwd, "sample.txt"), "utf8"), "implemented\n");
        assert.equal(await readFile(join(source, "sample.txt"), "utf8"), "initial\n");
        assert.equal((await git("git", ["-C", cwd, "rev-parse", "HEAD"])).stdout.trim(), base);
      } catch (error) {
        const failure = error as { code?: string; details?: { data?: { errorKind?: string; code?: string; status?: number; reason?: string } } };
        console.error("ACP diagnostic", JSON.stringify({ backend, code: failure.code, errorKind: failure.details?.data?.errorKind, providerCode: failure.details?.data?.code, status: failure.details?.data?.status, reason: failure.details?.data?.reason }));
        throw error;
      } finally { await pair.close(); }
    });
  });
  test(`${backend} real sandboxed Reviewer inspects Git diff without writing at high`, { timeout: 210_000 }, async () => {
    await fixture(async ({ source, cwd, golden, base }) => {
      await writeFile(join(cwd, "sample.txt"), "implemented\n");
      const pair = new AgentPrismSessionPair({ cwd, sourceRoot: source, goldenRoot: golden, reviewerModel: model, reasoningEffort: "high" });
      const abort = AbortSignal.timeout(175_000);
      try {
        const result = await pair.review([
          `phase_base_commit: ${base}`, "phase_id: phase-01", "round: 1",
          "Independently run git status and git diff from the base commit. Inspect sample.txt. Expected change: initial -> implemented with trailing newline. Do not write files, stage, or commit.",
          "Return a structured report with phase_id, round, base_commit, verdict: PASS, summary, findings, evidence, acceptance_assessment, out_of_scope_changes.",
        ].join("\n"), 1, { signal: abort });
        assert.equal(result.phase_id, "phase-01");
        assert.equal(result.base_commit, base);
        assert.equal(result.verdict, "PASS");
        assert.equal(await readFile(join(cwd, "sample.txt"), "utf8"), "implemented\n");
        assert.equal((await git("git", ["-C", cwd, "rev-parse", "HEAD"])).stdout.trim(), base);
      } catch (error) {
        const failure = error as { code?: string; details?: { data?: { errorKind?: string; code?: string; status?: number; reason?: string } } };
        console.error("ACP diagnostic", JSON.stringify({ backend, code: failure.code, errorKind: failure.details?.data?.errorKind, providerCode: failure.details?.data?.code, status: failure.details?.data?.status, reason: failure.details?.data?.reason }));
        throw error;
      } finally { await pair.close(); }
    });
  });
  test(`${backend} real single-phase workflow runs sandboxed acceptance and plugin-owned commit at high`, { timeout: 260_000 }, async () => {
    await fixture(async ({ source, cwd, golden, base }) => {
      const input: FinalizeInput = {
        run_id: "live",
        manifest: {
          version: 1, documents: [], phases: [{
            id: "phase-01", order: 1, spec: "phases/phase-01.md", acceptance: "acceptance/phase-01.yaml",
            commit: { required: true, message: "complete phase-01" },
          }],
        },
        files: [
          { path: "phases/phase-01.md", content: "Change sample.txt from initial to implemented, preserving one trailing newline. Do not edit other files.\n" },
          { path: "acceptance/phase-01.yaml", content: [
            "version: 1", "phase_id: phase-01", "scope:", "  allowed_paths:", "    - sample.txt",
            "self_tests:", "  - id: unit", "    command: 'test \"$(cat sample.txt)\" = implemented'",
            "    required: true", "review:", "  require_no_blocking_findings: true", "commit:",
            "  required: true", "  allow_empty: false", "",
          ].join("\n") },
        ],
      };
      const written = await writeValidatedPackage(source, input, "live");
      const validated = await validatePackageDirectory(written.package.root);
      assert.ok(validated.package);
      const state = createDraftState(validated.package, "live");
      state.status = "frozen";
      state.branch_name = "pi-plan-execute-auto/live";
      state.worktree_path = cwd;
      await writeWorkflowState(validated.package.root, state);
      const pair = new AgentPrismSessionPair({
        cwd, sourceRoot: source, goldenRoot: golden,
        executorModel: model, reviewerModel: model, reasoningEffort: "high",
      });
      try {
        const result = await new StageBController({
          package: validated.package, state,
          git: new GitWorkspace(createLocalGitOperations(cwd), {
            cwd, dedicatedBranch: "pi-plan-execute-auto/live", dedicatedWorktreePath: cwd,
          }),
          acceptanceRunner: { run: (command, options) => runSandboxedCommand({
            cwd, sourceRoot: source, goldenRoot: golden, command,
            ...(options?.signal ? { signal: options.signal } : {}),
            ...(options?.timeout ? { timeout: options.timeout } : {}),
          }) },
          harness: pair, maxReviewRounds: 1, signal: AbortSignal.timeout(220_000),
          saveState: (next) => writeWorkflowState(validated.package!.root, next),
        }).run();
        assert.equal(result.status, "completed", result.status === "paused" ? result.reason : undefined);
        const loaded = await loadValidatedRun(source, "live");
        assert.equal(loaded.state.status, "completed");
        const phaseState = loaded.state.phases[0];
        assert.equal(phaseState?.phase_commit_sha, (await git("git", ["-C", cwd, "rev-parse", "HEAD"])).stdout.trim());
        assert.notEqual(phaseState?.phase_commit_sha, base);
        assert.ok(phaseState?.executor_session_id);
        assert.ok(phaseState?.reviewer_session_id);
        assert.notEqual(phaseState?.executor_session_id, phaseState?.reviewer_session_id);
        assert.equal(await readFile(join(cwd, "sample.txt"), "utf8"), "implemented\n");
        assert.equal(await readFile(join(source, "sample.txt"), "utf8"), "initial\n");
      } finally { await pair.close(); }
    }, true);
  });
}
