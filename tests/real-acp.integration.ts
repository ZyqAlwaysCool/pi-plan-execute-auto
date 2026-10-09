// Explicit, potentially billable live-provider tests. Not part of npm test.
import { execFile as callback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentPrismSessionPair } from "../src/agent-prism.js";
import { createLocalGitOperations, GitWorkspace } from "../src/git.js";
import { validatePackageDirectory, writeValidatedPackage, writeWorkflowState } from "../src/package-validator.js";
import { runSandboxedCommand, findBubblewrap } from "../src/sandbox.js";
import { StageBController } from "../src/stage-b.js";
import { createDraftState, loadValidatedRun } from "../src/workflow-state.js";
import type { FinalizeInput } from "../src/types.js";

const git = promisify(callback);
const executorModel = process.env.PI_PLAN_EXECUTE_ACP_TEST_EXECUTOR_MODEL;
const reviewerModel = process.env.PI_PLAN_EXECUTE_ACP_TEST_REVIEWER_MODEL;
if (!executorModel?.startsWith("opencode/") || !reviewerModel?.startsWith("codex/")) {
  throw new Error("Live integration requires PI_PLAN_EXECUTE_ACP_TEST_EXECUTOR_MODEL=opencode/<model> and PI_PLAN_EXECUTE_ACP_TEST_REVIEWER_MODEL=codex/<model>.");
}
if (process.env.PI_PLAN_EXECUTE_ACCEPT_ACP_NETWORK_RISK !== "1") {
  throw new Error("Live ACP test requires explicit PI_PLAN_EXECUTE_ACCEPT_ACP_NETWORK_RISK=1 on a non-sensitive fixture.");
}
findBubblewrap(); // Fail, not skip, when the security prerequisite is absent.

async function withFixture(
  run: (fixture: { source: string; worktree: string; goldenRoot: string; base: string }) => Promise<void>,
  options?: { createGolden?: boolean },
): Promise<void> {
  const root = await mkdtemp(join(dirname(process.cwd()), ".peac-real-acp-"));
  const source = join(root, "source");
  const worktree = join(root, ".pi-plan-execute-auto-worktrees", "live-test");
  const goldenRoot = join(source, ".pi-plan-execute-auto", "live-test");
  try {
    await mkdir(source, { recursive: true });
    if (options?.createGolden !== false) await mkdir(goldenRoot, { recursive: true });
    await git("git", ["init", "-q", source]);
    await git("git", ["-C", source, "config", "user.name", "Integration Test"]);
    await git("git", ["-C", source, "config", "user.email", "test@example.invalid"]);
    await writeFile(join(source, ".gitignore"), ".pi-plan-execute-auto/\n");
    await writeFile(join(source, "sample.txt"), "initial\n");
    await git("git", ["-C", source, "add", "."]);
    await git("git", ["-C", source, "commit", "-qm", "baseline"]);
    await mkdir(dirname(worktree), { recursive: true });
    await git("git", ["-C", source, "worktree", "add", "-q", "-b", "pi-plan-execute-auto/live-test", worktree]);
    const base = (await git("git", ["-C", worktree, "rev-parse", "HEAD"])).stdout.trim();
    await run({ source, worktree, goldenRoot, base });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function boundedSession(run: (signal: AbortSignal) => Promise<void>): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Live ACP integration timeout")), 150_000);
  try {
    await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

test("real sandboxed Codex Reviewer checks Git diff, uses high reasoning and leaves worktree unchanged", { timeout: 180_000 }, async () => {
  await withFixture(async ({ source, worktree, goldenRoot, base }) => {
    await writeFile(join(worktree, "sample.txt"), "implemented\n");
    const pair = new AgentPrismSessionPair({
      cwd: worktree, sourceRoot: source, goldenRoot,
      reviewerModel, reasoningEffort: "high",
    });
    try {
      await boundedSession(async (signal) => {
        const review = await pair.review([
          `phase_base_commit: ${base}`, "phase_id: phase-01", "round: 1",
          "Independently run git status and git diff from the given phase base commit; inspect sample.txt.",
          "This phase requires initial -> implemented with a newline. Do not modify files or stage/commit.",
          "Return a structured review report with phase_id, round, base_commit, verdict, summary, findings, evidence, acceptance_assessment, out_of_scope_changes.",
        ].join("\n"), 1, { signal });
        assert.equal(review.phase_id, "phase-01");
        assert.equal(review.base_commit, base);
        assert.equal(review.verdict, "PASS");
        assert.equal(await readFile(join(worktree, "sample.txt"), "utf8"), "implemented\n");
        assert.equal((await git("git", ["-C", worktree, "rev-parse", "HEAD"])).stdout.trim(), base);
      });
    } finally {
      await pair.close();
    }
  });
});

test("real sandboxed OpenCode Executor edits worktree and returns structured report at high reasoning", { timeout: 180_000 }, async () => {
  await withFixture(async ({ source, worktree, goldenRoot, base }) => {
    const pair = new AgentPrismSessionPair({
      cwd: worktree, sourceRoot: source, goldenRoot,
      executorModel, reasoningEffort: "high",
    });
    try {
      await boundedSession(async (signal) => {
        const execution = await pair.execute([
          `phase_base_commit: ${base}`, "phase_id: phase-01", "round: 1",
          "Change sample.txt from 'initial' to 'implemented' (with a newline). Do not stage or commit.",
          "Run a read-only check and return a structured execution report with phase_id, round, base_commit, status, summary, changed_files, self_tests, resolved_findings, known_issues.",
          "Use self_tests: [{id:'unit', command:'test -f sample.txt', status:'passed'}] after running it.",
        ].join("\n"), 1, { phaseBaseCommit: base, signal });
        assert.equal(execution.phase_id, "phase-01");
        assert.equal(execution.status, "complete");
        assert.equal(await readFile(join(worktree, "sample.txt"), "utf8"), "implemented\n");
        assert.equal((await git("git", ["-C", worktree, "rev-parse", "HEAD"])).stdout.trim(), base);
      });
    } finally {
      await pair.close();
    }
  });
});

test("real single-phase workflow completes sandboxed acceptance and plugin-owned commit", { timeout: 240_000 }, async () => {
  await withFixture(async ({ source, worktree, goldenRoot, base }) => {
    const input: FinalizeInput = {
      run_id: "live-test",
      manifest: {
        version: 1,
        documents: [],
        phases: [{
          id: "phase-01", order: 1, spec: "phases/phase-01.md",
          acceptance: "acceptance/phase-01.yaml",
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
    const written = await writeValidatedPackage(source, input, "live-test");
    const validated = await validatePackageDirectory(written.package.root);
    assert.ok(validated.package);
    const state = createDraftState(validated.package, "live-test");
    state.status = "frozen";
    state.branch_name = "pi-plan-execute-auto/live-test";
    state.worktree_path = worktree;
    await writeWorkflowState(validated.package.root, state);
    const pair = new AgentPrismSessionPair({
      cwd: worktree, sourceRoot: source, goldenRoot,
      executorModel, reviewerModel, reasoningEffort: "high",
    });
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("Full Stage B integration timeout")), 210_000);
      try {
        const result = await new StageBController({
          package: validated.package,
          state,
          git: new GitWorkspace(createLocalGitOperations(worktree), {
            cwd: worktree,
            dedicatedBranch: "pi-plan-execute-auto/live-test",
            dedicatedWorktreePath: worktree,
          }),
          acceptanceRunner: {
            run: (command, options) => runSandboxedCommand({
              cwd: worktree, sourceRoot: source, goldenRoot, command,
              ...(options?.signal ? { signal: options.signal } : {}),
              ...(options?.timeout ? { timeout: options.timeout } : {}),
            }),
          },
          harness: pair,
          maxReviewRounds: 1,
          signal: controller.signal,
          saveState: (next) => writeWorkflowState(validated.package!.root, next),
        }).run();
        if (result.status !== "completed") {
          const phase = result.state.phases[0];
          const relative = phase?.review_report_path;
          const review = relative ? JSON.parse(await readFile(join(goldenRoot, relative), "utf8")) as { verdict?: string; summary?: string; findings?: unknown[] } : undefined;
          console.error("Stage B live fixture diagnostics", JSON.stringify({
            reason: result.status === "paused" ? result.reason : undefined,
            executionReport: phase?.execution_report_path,
            review: review ? { verdict: review.verdict, summary: review.summary, findings: review.findings } : undefined,
            acceptance: phase?.acceptance_results,
            worktreeSample: await readFile(join(worktree, "sample.txt"), "utf8"),
          }));
        }
        assert.equal(result.status, "completed", result.status === "paused" ? result.reason : undefined);
        const loaded = await loadValidatedRun(source, "live-test");
        assert.equal(loaded.state.status, "completed");
        const phaseState = loaded.state.phases[0];
        assert.equal(phaseState?.phase_commit_sha, (await git("git", ["-C", worktree, "rev-parse", "HEAD"])).stdout.trim());
        assert.notEqual(phaseState?.phase_commit_sha, base);
        assert.ok(phaseState?.executor_session_id);
        assert.ok(phaseState?.reviewer_session_id);
        assert.notEqual(phaseState?.executor_session_id, phaseState?.reviewer_session_id);
        assert.equal(await readFile(join(worktree, "sample.txt"), "utf8"), "implemented\n");
        assert.equal(await readFile(join(source, "sample.txt"), "utf8"), "initial\n");
      } finally {
        clearTimeout(timer);
      }
    } finally {
      await pair.close();
    }
  }, { createGolden: false });
});
