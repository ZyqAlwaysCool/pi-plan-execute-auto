import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdtemp, mkdir, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDraftState, loadValidatedRun } from "../src/workflow-state.js";
import { reconcilePersistedCompletions } from "../extensions/index.js";
import { createLocalGitOperations, ensureDedicatedWorktree, GitWorkspace, provisionDedicatedEnvironment } from "../src/git.js";
import { validatePhaseCompletionRecord } from "../src/completion.js";
import { StageBController } from "../src/stage-b.js";
import { readWorkflowState, validatePackageDirectory, writeValidatedPackage, writeWorkflowState } from "../src/package-validator.js";
import type { AcceptanceCommandRunner, FinalizeInput, GitCommandResult, HarnessPair, ReviewReport, ExecutionReport, PhasePackage, StageBAbortReason, StageBStatusEvent } from "../src/types.js";

const execFile = promisify(execFileCallback);

async function git(cwd: string, args: string[]): Promise<GitCommandResult> {
  try {
    const result = await execFile("git", args, { cwd, maxBuffer: 1024 * 1024 });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const value = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: value.stdout ?? "", stderr: value.stderr ?? "", code: value.code ?? 1 };
  }
}

async function setupRepo(): Promise<{ cwd: string; packageRoot: string; pkg: NonNullable<Awaited<ReturnType<typeof validatePackageDirectory>>["package"]> }> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-plan-execute-auto-stage-b-"));
  await git(cwd, ["init", "-q"]);
  await git(cwd, ["config", "user.email", "test@example.invalid"]);
  await git(cwd, ["config", "user.name", "Stage B Test"]);
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, ".gitignore"), ".pi-plan-execute-auto/\n", "utf8");
  await writeFile(join(cwd, "src", "existing.txt"), "base\n", "utf8");
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-qm", "initial"]);

  const input: FinalizeInput = {
    run_id: "stage-b-test",
    manifest: {
      version: 1,
      documents: [],
      phases: [
        {
          id: "phase-01",
          order: 1,
          spec: "phases/phase-01.md",
          acceptance: "acceptance/phase-01.yaml",
          commit: { required: true, message: "pi-plan-execute-auto: complete phase-01" },
        },
      ],
    },
    files: [
      { path: "phases/phase-01.md", content: "Create src/change.txt.\n" },
      {
        path: "acceptance/phase-01.yaml",
        content: [
          "version: 1",
          "phase_id: phase-01",
          "scope:",
          "  allowed_paths:",
          "    - src/**",
          "self_tests:",
          "  - id: unit",
          "    command: \"true\"",
          "    required: true",
          "review:",
          "  require_no_blocking_findings: true",
          "commit:",
          "  required: true",
          "  allow_empty: false",
          "",
        ].join("\n"),
      },
    ],
  };
  const written = await writeValidatedPackage(cwd, input, "stage-b-test");
  const validation = await validatePackageDirectory(written.package.root);
  if (!validation.package) throw new Error("test package did not validate");
  return { cwd, packageRoot: written.package.root, pkg: validation.package };
}

function execution(baseCommit: string, status: ExecutionReport["status"] = "complete"): ExecutionReport {
  return {
    phase_id: "phase-01",
    round: 1,
    base_commit: baseCommit,
    status,
    summary: "implemented current phase",
    changed_files: ["src/change.txt"],
    self_tests: [{ id: "unit", command: "true", status: "passed" }],
    resolved_findings: [],
    known_issues: [],
  };
}

function review(baseCommit: string, verdict: ReviewReport["verdict"] = "PASS"): ReviewReport {
  return {
    phase_id: "phase-01",
    round: 1,
    base_commit: baseCommit,
    verdict,
    summary: verdict === "PASS" ? "green" : "needs work",
    findings: verdict === "PASS" ? [] : [{ id: "R001", severity: "blocking", summary: "fix it", evidence: "test", blocking: true }],
    evidence: ["independent inspection"],
    acceptance_assessment: "true passed",
    out_of_scope_changes: [],
  };
}

class FakeHarness implements HarnessPair {
  executeCalls = 0;
  reworkCalls = 0;
  reviewCalls = 0;
  lastReviewPrompt = "";
  lastReworkPrompt = "";
  private readonly cwd: string;
  private readonly baseCommit: string;
  private readonly reworkRequired: boolean;

  constructor(cwd: string, baseCommit: string, reworkRequired = false) {
    this.cwd = cwd;
    this.baseCommit = baseCommit;
    this.reworkRequired = reworkRequired;
  }

  async execute(): Promise<ExecutionReport> {
    this.executeCalls += 1;
    if (!this.reworkRequired) await writeFile(join(this.cwd, "src", "change.txt"), "done\n", "utf8");
    return execution(this.baseCommit, this.reworkRequired ? "blocked" : "complete");
  }

  async rework(prompt: string): Promise<ExecutionReport> {
    this.reworkCalls += 1;
    this.lastReworkPrompt = prompt;
    await writeFile(join(this.cwd, "src", "change.txt"), "fixed\n", "utf8");
    const result = execution(this.baseCommit);
    return { ...result, round: 2 };
  }

  async review(prompt: string, round: number): Promise<ReviewReport> {
    this.reviewCalls += 1;
    this.lastReviewPrompt = prompt;
    return { ...review(this.baseCommit), round };
  }

  async close(): Promise<void> {}
}

async function runController(
  setup: Awaited<ReturnType<typeof setupRepo>>,
  harness: HarnessPair,
  maxReviewRounds = 3,
  config?: { package?: Awaited<ReturnType<typeof validatePackageDirectory>>["package"]; runId?: string; packageRoot?: string; acceptanceRunner?: AcceptanceCommandRunner },
) {
  const pkg = config?.package ?? setup.pkg;
  if (!pkg) throw new Error("test package is missing");
  const runId = config?.runId ?? "stage-b-test";
  const packageRoot = config?.packageRoot ?? setup.packageRoot;
  const state = createDraftState(pkg, runId);
  state.status = "frozen";
  const workspace = new GitWorkspace({ run: (args, options) => git(setup.cwd, args) }, {
    cwd: setup.cwd,
    runtimeRoot: `.pi-plan-execute-auto/${runId}`,
  });
  const result = await new StageBController({
    package: pkg,
    state,
    git: workspace,
    acceptanceRunner: config?.acceptanceRunner ?? { run: async () => ({ stdout: "", stderr: "", code: 0 }) },
    harness,
    maxReviewRounds,
    requireDedicatedWorktree: false,
    saveState: (next) => writeWorkflowState(packageRoot, next),
  }).run();
  return result;
}

test("draft planning state cannot start Executor or Reviewer work", async () => {
  const setup = await setupRepo();
  try {
    const base = (await git(setup.cwd, ["rev-parse", "HEAD"])).stdout.trim();
    const harness = new FakeHarness(setup.cwd, base);
    const state = createDraftState(setup.pkg, "stage-b-test");
    const result = await new StageBController({
      package: setup.pkg,
      state,
      git: new GitWorkspace({ run: (args, options) => git(setup.cwd, args) }, {
        cwd: setup.cwd,
        runtimeRoot: ".pi-plan-execute-auto/stage-b-test",
      }),
      acceptanceRunner: { run: async () => ({ stdout: "", stderr: "", code: 0 }) },
      harness,
      requireDedicatedWorktree: false,
      saveState: (next) => writeWorkflowState(setup.packageRoot, next),
    }).run();
    assert.equal(result.status, "not_started");
    assert.match(result.reason ?? "", /Human approval is required/);
    assert.equal(state.status, "draft");
    assert.equal(harness.executeCalls, 0);
    assert.equal(harness.reworkCalls, 0);
    assert.equal(harness.reviewCalls, 0);
    assert.equal((await git(setup.cwd, ["status", "--porcelain"])).stdout.trim(), "");
  } finally {
    await rm(setup.cwd, { recursive: true, force: true });
  }
});

test("prompt section limits retain rework feedback, previous findings, and output contracts", async () => {
  const setup = await setupRepo();
  try {
    const base = (await git(setup.cwd, ["rev-parse", "HEAD"])).stdout.trim();
    const state = createDraftState(setup.pkg, "stage-b-test");
    state.status = "frozen";
    const workspace = new GitWorkspace({ run: (args, options) => git(setup.cwd, args) }, {
      cwd: setup.cwd,
      runtimeRoot: ".pi-plan-execute-auto/stage-b-test",
    });
    const controller = new StageBController({
      package: setup.pkg,
      state,
      git: workspace,
      acceptanceRunner: { run: async () => ({ stdout: "", stderr: "", code: 0 }) },
      harness: new FakeHarness(setup.cwd, base),
      requireDedicatedWorktree: false,
      saveState: async () => {},
    });
    const phase = setup.pkg.phases[0];
    assert.ok(phase);
    const privateController = controller as unknown as {
      executorPrompt: (phase: PhasePackage, base: string, round: number, diff: string, feedback: string) => string;
      reviewerPrompt: (phase: PhasePackage, base: string, round: number, diff: string, diffPath: string, diffSha256: string, execution: ExecutionReport, acceptance: [], history: ReviewReport[]) => string;
    };
    const feedback = "FEEDBACK-MUST-SURVIVE";
    const executorPrompt = privateController.executorPrompt(phase, base, 2, "D".repeat(160_000), feedback);
    assert.match(executorPrompt, new RegExp(feedback));
    assert.match(executorPrompt, /review_round_limit: 5/);
    assert.match(executorPrompt, /review_rounds_remaining_including_this_round: 4/);
    assert.match(executorPrompt, /review_rounds_remaining_after_this_round: 3/);
    assert.match(executorPrompt, /structured execution report/);
    const reviewerPrompt = privateController.reviewerPrompt(
      phase,
      base,
      2,
      "D".repeat(160_000),
      "/tmp/complete-review.patch",
      "a".repeat(64),
      execution(base),
      [],
      [{ ...review(base, "REWORK"), findings: [{ id: "HISTORY-001", severity: "blocking", summary: "history finding", evidence: "evidence", blocking: true }] }],
    );
    assert.match(reviewerPrompt, /HISTORY-001/);
    assert.match(reviewerPrompt, /review_round_limit: 5/);
    assert.match(reviewerPrompt, /review_rounds_remaining_including_this_round: 4/);
    assert.match(reviewerPrompt, /review_rounds_remaining_after_this_round: 3/);
    assert.match(reviewerPrompt, /avoid drip-feeding findings/);
    assert.match(reviewerPrompt, /structured review report/);
    const manyFindings = Array.from({ length: 200 }, (_, index) => ({
      id: `HISTORY-${String(index).padStart(3, "0")}`,
      severity: "blocking",
      summary: "S".repeat(300),
      evidence: "E".repeat(2_000),
      blocking: true,
    }));
    const largeHistoryPrompt = privateController.reviewerPrompt(
      phase,
      base,
      3,
      "D".repeat(160_000),
      "/tmp/complete-review.patch",
      "b".repeat(64),
      execution(base),
      [],
      [{ ...review(base, "REWORK"), findings: manyFindings }],
    );
    assert.match(largeHistoryPrompt, /HISTORY-000/);
    assert.match(largeHistoryPrompt, /HISTORY-100/);
    assert.match(largeHistoryPrompt, /HISTORY-199/);
  } finally {
    await rm(setup.cwd, { recursive: true, force: true });
  }
});

test("dedicated environment provisioning copies dependencies without sharing writable bytes", async () => {
  const source = await mkdtemp(join(tmpdir(), "pi-plan-execute-auto-source-"));
  const target = await mkdtemp(join(tmpdir(), "pi-plan-execute-auto-target-"));
  try {
    await mkdir(join(source, "node_modules", ".bin"), { recursive: true });
    await writeFile(join(source, "node_modules", "marker.txt"), "source\n", "utf8");
    const copied = await provisionDedicatedEnvironment(source, target, ["node_modules"]);
    assert.deepEqual(copied, ["node_modules"]);
    assert.equal(await readFile(join(target, "node_modules", "marker.txt"), "utf8"), "source\n");
    await writeFile(join(target, "node_modules", "marker.txt"), "target\n", "utf8");
    assert.equal(await readFile(join(source, "node_modules", "marker.txt"), "utf8"), "source\n");
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test("dependency provisioning is bounded and cancellable", async () => {
  const source = await mkdtemp(join(tmpdir(), "pi-plan-execute-auto-source-"));
  const target = await mkdtemp(join(tmpdir(), "pi-plan-execute-auto-target-"));
  try {
    await mkdir(join(source, "node_modules"), { recursive: true });
    await writeFile(join(source, "node_modules", "large.txt"), "0123456789", "utf8");
    await assert.rejects(
      provisionDedicatedEnvironment(source, target, ["node_modules"], { maxBytes: 4 }),
      /exceeded .* bytes/i,
    );
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await assert.rejects(
      provisionDedicatedEnvironment(source, target, ["node_modules"], { signal: controller.signal }),
      /stop|cancel/i,
    );

    const handle = await open(join(source, "node_modules", "huge.sparse"), "w");
    await handle.truncate(1024 * 1024 * 1024);
    await handle.close();
    const activeTarget = await mkdtemp(join(tmpdir(), "pi-plan-execute-auto-active-target-"));
    const hasPartialFile = async (): Promise<boolean> => {
      for (const name of await readdir(activeTarget)) {
        if (!name.startsWith("node_modules.pi-provision-")) continue;
        const size = await stat(join(activeTarget, name, "huge.sparse")).then((value) => value.size, () => 0);
        if (size > 0) return true;
      }
      return false;
    };
    const waitForPartialFile = async (): Promise<boolean> => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (await hasPartialFile()) return true;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      return false;
    };
    try {
      let timeoutFinished = false;
      let timeoutObservedPartial = false;
      const timeoutCopy = provisionDedicatedEnvironment(source, activeTarget, ["node_modules"], { timeout: 200 })
        .finally(() => { timeoutFinished = true; });
      const timeoutObserver = (async () => {
        while (!timeoutFinished) {
          if (await hasPartialFile()) {
            timeoutObservedPartial = true;
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
      })();
      await assert.rejects(timeoutCopy, /timeout|abort/i);
      await timeoutObserver;
      assert.equal(timeoutObservedPartial, true, "timeout should interrupt an active single-file copy");
      await assert.rejects(readFile(join(activeTarget, "node_modules", "huge.sparse")));

      const stopController = new AbortController();
      const stopCopy = provisionDedicatedEnvironment(source, activeTarget, ["node_modules"], { signal: stopController.signal });
      const stopObservedPartial = await waitForPartialFile();
      stopController.abort(new Error("active stop"));
      await assert.rejects(stopCopy, /stop|abort/i);
      assert.equal(stopObservedPartial, true, "stop should interrupt an active single-file copy");
      await assert.rejects(readFile(join(activeTarget, "node_modules", "huge.sparse")));
    } finally {
      await rm(activeTarget, { recursive: true, force: true });
    }
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test("an existing dedicated worktree is not blocked by later changes in the main worktree", async () => {
  const setup = await setupRepo();
  const worktree = join(tmpdir(), `pi-plan-execute-auto-existing-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const branchName = "pi-plan-execute-auto/existing-test";
  try {
    await ensureDedicatedWorktree(createLocalGitOperations(setup.cwd), {
      sourceCwd: setup.cwd,
      runId: "existing-test",
      runtimeRoot: ".pi-plan-execute-auto/existing-test",
      targetPath: worktree,
      branchName,
      targetGit: createLocalGitOperations(worktree),
    });
    await writeFile(join(setup.cwd, "main-only-uncommitted.txt"), "main workspace may move on\n", "utf8");
    const reopened = await ensureDedicatedWorktree(createLocalGitOperations(setup.cwd), {
      sourceCwd: setup.cwd,
      runId: "existing-test",
      runtimeRoot: ".pi-plan-execute-auto/existing-test",
      targetPath: worktree,
      branchName,
      targetGit: createLocalGitOperations(worktree),
      existing: { path: worktree, branchName },
    });
    assert.equal(reopened.path, worktree);
    assert.equal(reopened.branchName, branchName);
  } finally {
    await git(setup.cwd, ["worktree", "remove", "--force", worktree]);
    await rm(worktree, { recursive: true, force: true });
    await rm(setup.cwd, { recursive: true, force: true });
  }
});

test("Stage B uses and verifies a run-scoped dedicated branch/worktree", async () => {
  const setup = await setupRepo();
  const worktree = join(tmpdir(), `pi-plan-execute-auto-worktree-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    const branchName = "pi-plan-execute-auto/dedicated-test";
    const dedicated = await ensureDedicatedWorktree(
      { run: (args, options) => git(setup.cwd, args) },
      {
        sourceCwd: setup.cwd,
        runId: "dedicated-test",
        runtimeRoot: ".pi-plan-execute-auto/dedicated-test",
        targetPath: worktree,
        branchName,
        targetGit: { run: (args, options) => git(worktree, args) },
      },
    );
    assert.equal(dedicated.branchName, branchName);
    const target = new GitWorkspace({ run: (args, options) => git(worktree, args) }, {
      cwd: worktree,
      dedicatedBranch: branchName,
      dedicatedWorktreePath: worktree,
    });
    await target.assertDedicatedIdentity();
    await writeFile(join(worktree, "src", "dedicated.txt"), "worktree\n", "utf8");
    assert.notEqual((await git(setup.cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim(), branchName);
    assert.equal((await git(worktree, ["status", "--porcelain"])).stdout.trim(), "?? src/dedicated.txt");
  } finally {
    await git(setup.cwd, ["worktree", "remove", "--force", worktree]);
    await rm(worktree, { recursive: true, force: true });
    await rm(setup.cwd, { recursive: true, force: true });
  }
});

test("Stage B performs deterministic acceptance and one plugin-owned phase commit", async () => {
  const setup = await setupRepo();
  try {
    const base = (await git(setup.cwd, ["rev-parse", "HEAD"])).stdout.trim();
    const harness = new FakeHarness(setup.cwd, base);
    const result = await runController(setup, harness);
    assert.equal(result.status, "completed");
    assert.equal(harness.reviewCalls, 1);
    assert.equal(result.state.phases[0]?.status, "completed");
    assert.match(result.state.phases[0]?.phase_commit_sha ?? "", /^[0-9a-f]{40}$/);
    assert.equal(result.state.phases[0]?.committed_at !== undefined, true);
    const reviewDiffPath = join(setup.packageRoot, ".runtime", "review-diffs", "phase-01-round-01.patch");
    const reviewedDiff = await readFile(reviewDiffPath, "utf8");
    assert.match(reviewedDiff, /src\/change\.txt/);
    assert.ok(harness.lastReviewPrompt.includes(reviewDiffPath));
    assert.match(harness.lastReviewPrompt, /complete_canonical_diff_sha256: [0-9a-f]{64}/);
    const completion = JSON.parse(await readFile(join(setup.packageRoot, ".runtime", "completions", "phase-01.json"), "utf8")) as Record<string, unknown>;
    assert.equal(completion.phase_id, "phase-01");
    assert.equal(completion.phase_commit_sha, result.state.phases[0]?.phase_commit_sha);
    assert.match(String(completion.final_diff_sha256), /^[0-9a-f]{64}$/);
    const loaded = await loadValidatedRun(setup.cwd, "stage-b-test");
    assert.equal(loaded.state.phases[0]?.completion_record_sha256 !== undefined, true);
    await validatePhaseCompletionRecord(setup.packageRoot, "phase-01", setup.pkg.package_hash, undefined, setup.pkg.phases[0]?.acceptance);
    const log = await git(setup.cwd, ["log", "-1", "--pretty=%s"]);
    assert.equal(log.stdout.trim(), "pi-plan-execute-auto: complete phase-01");
    assert.equal((await readFile(join(setup.cwd, "src", "change.txt"), "utf8")).trim(), "done");
  } finally {
    await rm(setup.cwd, { recursive: true, force: true });
  }
});

test("multiple file diffs are canonical and can be committed with the reviewed hash", async () => {
  const setup = await setupRepo();
  try {
    await writeFile(join(setup.cwd, "src", "delete.txt"), "delete me\n", "utf8");
    await git(setup.cwd, ["add", "."]);
    await git(setup.cwd, ["commit", "-qm", "second base"]);
    const base = (await git(setup.cwd, ["rev-parse", "HEAD"])).stdout.trim();
    await writeFile(join(setup.cwd, "src", "existing.txt"), "modified\n", "utf8");
    await writeFile(join(setup.cwd, "src", "new file.txt"), "new\n", "utf8");
    await writeFile(join(setup.cwd, "src", "非ascii.bin"), Buffer.from([0, 1, 2, 255]));
    await rm(join(setup.cwd, "src", "delete.txt"));
    const workspace = new GitWorkspace({ run: (args, options) => git(setup.cwd, args) }, { cwd: setup.cwd });
    const reviewed = await workspace.diffFrom(base);
    const commit = await workspace.commitPhase(
      base,
      ["src/delete.txt", "src/existing.txt", "src/new file.txt", "src/非ascii.bin"],
      "multi-file phase",
      false,
      { expectedDiffSha256: createHash("sha256").update(reviewed).digest("hex") },
    );
    await workspace.verifyPhaseCommit(
      commit,
      base,
      "multi-file phase",
      createHash("sha256").update(reviewed).digest("hex"),
    );
    assert.equal((await git(setup.cwd, ["rev-parse", "HEAD"])).stdout.trim(), commit);
  } finally {
    await rm(setup.cwd, { recursive: true, force: true });
  }
});

test("untracked binary files produce real binary diff evidence", async () => {
  const setup = await setupRepo();
  try {
    const base = (await git(setup.cwd, ["rev-parse", "HEAD"])).stdout.trim();
    const harness: HarnessPair = {
      async execute() {
        await writeFile(join(setup.cwd, "src", "change.bin"), Buffer.from([0, 255, 1, 2, 0, 3]));
        return {
          ...execution(base),
          changed_files: ["src/change.bin"],
        };
      },
      async rework() { return execution(base); },
      async review() { return review(base); },
      async close() {},
    };
    const result = await runController(setup, harness);
    assert.equal(result.status, "completed");
    const diff = await readFile(join(setup.packageRoot, ".runtime", "completions", "phase-01.diff"), "utf8");
    assert.match(diff, /GIT binary patch/);
  } finally {
    await rm(setup.cwd, { recursive: true, force: true });
  }
});

test("tampered completion evidence is rejected when a completed run is loaded", async () => {
  const setup = await setupRepo();
  try {
    const base = (await git(setup.cwd, ["rev-parse", "HEAD"])).stdout.trim();
    const result = await runController(setup, new FakeHarness(setup.cwd, base));
    assert.equal(result.status, "completed");
    const recordPath = join(setup.packageRoot, ".runtime", "completions", "phase-01.json");
    const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
    record.acceptance_results = [];
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await assert.rejects(loadValidatedRun(setup.cwd, "stage-b-test"), /immutable completion record|Completion record hash|Completion evidence/);
  } finally {
    await rm(setup.cwd, { recursive: true, force: true });
  }
});

test("a forged identity-only completion record is rejected even when its state hash is updated", async () => {
  const setup = await setupRepo();
  try {
    const base = (await git(setup.cwd, ["rev-parse", "HEAD"])).stdout.trim();
    const result = await runController(setup, new FakeHarness(setup.cwd, base));
    assert.equal(result.status, "completed");
    const recordPath = join(setup.packageRoot, ".runtime", "completions", "phase-01.json");
    const forged = {
      phase_id: "phase-01",
      package_hash: setup.pkg.package_hash,
      phase_commit_sha: result.state.phases[0]?.phase_commit_sha,
    };
    const serialized = `${JSON.stringify(forged, null, 2)}\n`;
    await writeFile(recordPath, serialized, "utf8");
    const state = result.state;
    const phase = state.phases[0];
    assert.ok(phase);
    phase.completion_record_sha256 = createHash("sha256").update(serialized).digest("hex");
    await writeWorkflowState(setup.packageRoot, state);
    await assert.rejects(loadValidatedRun(setup.cwd, "stage-b-test"), /immutable completion record|incomplete|invalid/i);
  } finally {
    await rm(setup.cwd, { recursive: true, force: true });
  }
});

test("completion evidence cannot be synchronized to a fake diff when Git commit bytes disagree", async () => {
  const setup = await setupRepo();
  try {
    const base = (await git(setup.cwd, ["rev-parse", "HEAD"])).stdout.trim();
    const result = await runController(setup, new FakeHarness(setup.cwd, base));
    assert.equal(result.status, "completed");
    const recordPath = join(setup.packageRoot, ".runtime", "completions", "phase-01.json");
    const diffPath = join(setup.packageRoot, ".runtime", "completions", "phase-01.diff");
    const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
    const fakeDiff = "fake diff evidence\n";
    await writeFile(diffPath, fakeDiff, "utf8");
    const fakeHash = createHash("sha256").update(fakeDiff).digest("hex");
    record.final_diff_sha256 = fakeHash;
    record.reviewed_diff_sha256 = fakeHash;
    const serialized = `${JSON.stringify(record, null, 2)}\n`;
    await writeFile(recordPath, serialized, "utf8");
    const state = result.state;
    const phase = state.phases[0];
    assert.ok(phase);
    phase.final_diff_sha256 = fakeHash;
    phase.reviewed_diff_sha256 = fakeHash;
    phase.completion_record_sha256 = createHash("sha256").update(serialized).digest("hex");
    await writeWorkflowState(setup.packageRoot, state);
    await assert.rejects(loadValidatedRun(setup.cwd, "stage-b-test"), /COMMIT_DIFF_MISMATCH|commit diff/i);
  } finally {
    await rm(setup.cwd, { recursive: true, force: true });
  }
});

test("report semantics cannot be forged by synchronizing report, record, and state hashes", async () => {
  const setup = await setupRepo();
  try {
    const base = (await git(setup.cwd, ["rev-parse", "HEAD"])).stdout.trim();
    const result = await runController(setup, new FakeHarness(setup.cwd, base));
    assert.equal(result.status, "completed");
    const recordPath = join(setup.packageRoot, ".runtime", "completions", "phase-01.json");
    const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
    const reportPath = join(setup.packageRoot, ...(String(record.execution_report_path).split("/")));
    const report = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, unknown>;
    report.summary = "forged but schema-valid execution semantics";
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    const reportBytes = await readFile(reportPath);
    record.execution_report_sha256 = createHash("sha256").update(reportBytes).digest("hex");
    const serialized = `${JSON.stringify(record, null, 2)}\n`;
    await writeFile(recordPath, serialized, "utf8");
    const phase = result.state.phases[0];
    assert.ok(phase);
    phase.completion_record_sha256 = createHash("sha256").update(serialized).digest("hex");
    await writeWorkflowState(setup.packageRoot, result.state);
    await assert.rejects(loadValidatedRun(setup.cwd, "stage-b-test"), /COMMIT_MESSAGE_MISMATCH|evidence anchor|immutable completion/i);
  } finally {
    await rm(setup.cwd, { recursive: true, force: true });
  }
});

test("Executor commit followed by reset is detected from refs and reflog", async () => {
  const setup = await setupRepo();
  try {
    const base = (await git(setup.cwd, ["rev-parse", "HEAD"])).stdout.trim();
    const harness: HarnessPair = {
      async execute() {
        await writeFile(join(setup.cwd, "src", "change.txt"), "executor\n", "utf8");
        await git(setup.cwd, ["add", "src/change.txt"]);
        await git(setup.cwd, ["commit", "-qm", "illegal executor commit"]);
        await git(setup.cwd, ["reset", "--mixed", base]);
        return execution(base);
      },
      async rework() { return execution(base); },
      async review() { throw new Error("review must not run"); },
      async close() {},
    };
    const result = await runController(setup, harness);
    assert.equal(result.status, "paused");
    assert.match(result.reason ?? "", /HARNESS_CHANGED_HISTORY/);
    assert.equal((await git(setup.cwd, ["log", "-1", "--pretty=%s"])).stdout.trim(), "initial");
  } finally {
    await rm(setup.cwd, { recursive: true, force: true });
  }
});

test("Reviewer commit followed by reset is detected even when final bytes are restored", async () => {
  const setup = await setupRepo();
  try {
    const base = (await git(setup.cwd, ["rev-parse", "HEAD"])).stdout.trim();
    const harness: HarnessPair = {
      async execute() {
        await writeFile(join(setup.cwd, "src", "change.txt"), "executor\n", "utf8");
        return execution(base);
      },
      async rework() { return execution(base); },
      async review() {
        await git(setup.cwd, ["add", "src/change.txt"]);
        await git(setup.cwd, ["commit", "-qm", "illegal reviewer commit"]);
        await git(setup.cwd, ["reset", "--mixed", base]);
        await writeFile(join(setup.cwd, "src", "change.txt"), "executor\n", "utf8");
        return review(base);
      },
      async close() {},
    };
    const result = await runController(setup, harness);
    assert.equal(result.status, "paused");
    assert.match(result.reason ?? "", /REVIEWER_CHANGED_WORKSPACE|HARNESS_CHANGED_HISTORY/);
    assert.equal((await git(setup.cwd, ["log", "-1", "--pretty=%s"])).stdout.trim(), "initial");
  } finally {
    await rm(setup.cwd, { recursive: true, force: true });
  }
});

test("acceptance commit followed by reset is detected before review", async () => {
  const setup = await setupRepo();
  try {
    const base = (await git(setup.cwd, ["rev-parse", "HEAD"])).stdout.trim();
    let acceptanceCalls = 0;
    const acceptanceRunner: AcceptanceCommandRunner = {
      async run() {
        acceptanceCalls += 1;
        if (acceptanceCalls === 1) {
          await git(setup.cwd, ["add", "src/change.txt"]);
          await git(setup.cwd, ["commit", "-qm", "illegal acceptance commit"]);
          await git(setup.cwd, ["reset", "--mixed", base]);
        }
        return { stdout: "", stderr: "", code: 0 };
      },
    };
    const harness = new FakeHarness(setup.cwd, base);
    const result = await runController(setup, harness, 3, { acceptanceRunner });
    assert.equal(result.status, "paused");
    assert.match(result.reason ?? "", /HARNESS_CHANGED_HISTORY/);
    assert.equal((await git(setup.cwd, ["log", "-1", "--pretty=%s"])).stdout.trim(), "initial");
  } finally {
    await rm(setup.cwd, { recursive: true, force: true });
  }
});

test("final acceptance cannot change deliverable bytes after Reviewer PASS", async () => {
  const setup = await setupRepo();
  try {
    const base = (await git(setup.cwd, ["rev-parse", "HEAD"])).stdout.trim();
    let calls = 0;
    const acceptanceRunner: AcceptanceCommandRunner = {
      async run() {
        calls += 1;
        if (calls === 2) await writeFile(join(setup.cwd, "src", "change.txt"), "UNREVIEWED-FINAL-ACCEPTANCE\n", "utf8");
        return { stdout: "", stderr: "", code: 0 };
      },
    };
    const result = await runController(setup, new FakeHarness(setup.cwd, base), 3, { acceptanceRunner });
    assert.equal(result.status, "paused");
    assert.match(result.reason ?? "", /ACCEPTANCE_CHANGED_REVIEWED_WORKSPACE/);
    assert.equal((await git(setup.cwd, ["log", "-1", "--pretty=%s"])).stdout.trim(), "initial");
  } finally {
    await rm(setup.cwd, { recursive: true, force: true });
  }
});

test("REWORK continues the same executor abstraction and does not create an intermediate commit", async () => {
  const setup = await setupRepo();
  try {
    const base = (await git(setup.cwd, ["rev-parse", "HEAD"])).stdout.trim();
    const harness = new FakeHarness(setup.cwd, base, true);
    const result = await runController(setup, harness);
    assert.equal(result.status, "completed");
    assert.equal(harness.executeCalls, 1);
    assert.equal(harness.reworkCalls, 1);
    assert.equal(harness.reviewCalls, 1);
    const count = await git(setup.cwd, ["rev-list", "--count", "HEAD"]);
    assert.equal(count.stdout.trim(), "2");
  } finally {
    await rm(setup.cwd, { recursive: true, force: true });
  }
});

test("ignored node_modules regular-file bytes are included in snapshots", async () => {
  const setup = await setupRepo();
  try {
    await writeFile(join(setup.cwd, ".gitignore"), ".pi-plan-execute-auto/\nnode_modules/\n", "utf8");
    await git(setup.cwd, ["add", ".gitignore"]);
    await git(setup.cwd, ["commit", "-qm", "ignore dependencies"]);
    await mkdir(join(setup.cwd, "node_modules", "dependency"), { recursive: true });
    const dependencyFile = join(setup.cwd, "node_modules", "dependency", "index.js");
    await writeFile(dependencyFile, "original\n", "utf8");
    const workspace = new GitWorkspace({ run: (args, options) => git(setup.cwd, args) }, { cwd: setup.cwd });
    const before = await workspace.snapshot();
    await writeFile(dependencyFile, "modified\n", "utf8");
    const after = await workspace.snapshot();
    assert.notEqual(before.ignored, after.ignored);
  } finally {
    await rm(setup.cwd, { recursive: true, force: true });
  }
});

test("Reviewer dependency-tree writes are detected and pause before commit", async () => {
  const setup = await setupRepo();
  try {
    await writeFile(join(setup.cwd, ".gitignore"), ".pi-plan-execute-auto/\nnode_modules/\n", "utf8");
    await git(setup.cwd, ["add", ".gitignore"]);
    await git(setup.cwd, ["commit", "-qm", "ignore dependencies"]);
    await mkdir(join(setup.cwd, "node_modules"), { recursive: true });
    const dependencyFile = join(setup.cwd, "node_modules", "dependency.js");
    await writeFile(dependencyFile, "original\n", "utf8");
    const base = (await git(setup.cwd, ["rev-parse", "HEAD"])).stdout.trim();
    const harness: HarnessPair = {
      async execute() {
        await writeFile(join(setup.cwd, "src", "change.txt"), "executor\n", "utf8");
        return execution(base);
      },
      async rework() { return execution(base); },
      async review() {
        await writeFile(dependencyFile, "reviewer!\n", "utf8");
        return review(base);
      },
      async close() {},
    };
    const result = await runController(setup, harness);
    assert.equal(result.status, "paused");
    assert.match(result.reason ?? "", /REVIEWER_CHANGED_WORKSPACE/);
    assert.equal((await git(setup.cwd, ["rev-list", "--count", "HEAD"])).stdout.trim(), "2");
  } finally {
    await rm(setup.cwd, { recursive: true, force: true });
  }
});

test("acceptance dependency-tree writes fail closed", async () => {
  const setup = await setupRepo();
  try {
    await writeFile(join(setup.cwd, ".gitignore"), ".pi-plan-execute-auto/\nnode_modules/\n", "utf8");
    await git(setup.cwd, ["add", ".gitignore"]);
    await git(setup.cwd, ["commit", "-qm", "ignore dependencies"]);
    await mkdir(join(setup.cwd, "node_modules"), { recursive: true });
    const dependencyFile = join(setup.cwd, "node_modules", "dependency.js");
    await writeFile(dependencyFile, "original\n", "utf8");
    const base = (await git(setup.cwd, ["rev-parse", "HEAD"])).stdout.trim();
    const result = await runController(setup, new FakeHarness(setup.cwd, base), 3, {
      acceptanceRunner: {
        async run() {
          await writeFile(dependencyFile, "acceptance\n", "utf8");
          return { stdout: "", stderr: "", code: 0 };
        },
      },
    });
    assert.equal(result.status, "paused");
    assert.match(result.reason ?? "", /HARNESS_CHANGED_HISTORY/);
    assert.equal((await git(setup.cwd, ["rev-list", "--count", "HEAD"])).stdout.trim(), "2");
  } finally {
    await rm(setup.cwd, { recursive: true, force: true });
  }
});

test("generic ignored build paths remain visible to workspace snapshots", async () => {
  const setup = await setupRepo();
  try {
    await writeFile(join(setup.cwd, ".gitignore"), ".pi-plan-execute-auto/\nbuild/\ndist/\n", "utf8");
    const workspace = new GitWorkspace({ run: (args, options) => git(setup.cwd, args) }, { cwd: setup.cwd });
    const before = await workspace.snapshot();
    await mkdir(join(setup.cwd, "packages", "x", "dist"), { recursive: true });
    await writeFile(join(setup.cwd, "packages", "x", "dist", "reviewer-wrote.js"), "changed\n", "utf8");
    const after = await workspace.snapshot();
    assert.notEqual(before.ignored, after.ignored);
  } finally {
    await rm(setup.cwd, { recursive: true, force: true });
  }
});

test("controlled dependency symlink topology is still visible", async () => {
  const setup = await setupRepo();
  try {
    await writeFile(join(setup.cwd, ".gitignore"), ".pi-plan-execute-auto/\nnode_modules/\n", "utf8");
    await mkdir(join(setup.cwd, "node_modules"), { recursive: true });
    await symlink("../src", join(setup.cwd, "node_modules", "link"));
    const workspace = new GitWorkspace({ run: (args, options) => git(setup.cwd, args) }, { cwd: setup.cwd });
    const before = await workspace.snapshot();
    await rm(join(setup.cwd, "node_modules", "link"));
    await symlink("../", join(setup.cwd, "node_modules", "link"));
    const after = await workspace.snapshot();
    assert.notEqual(before.ignored, after.ignored);
  } finally {
    await rm(setup.cwd, { recursive: true, force: true });
  }
});

test("ignored workspace byte mutations are detected during review", async () => {
  const setup = await setupRepo();
  try {
    await writeFile(join(setup.cwd, ".gitignore"), ".pi-plan-execute-auto/\nignored.txt\n", "utf8");
    await git(setup.cwd, ["add", ".gitignore"]);
    await git(setup.cwd, ["commit", "-qm", "test ignored path"]);
    const base = (await git(setup.cwd, ["rev-parse", "HEAD"])).stdout.trim();
    const harness: HarnessPair = {
      async execute() {
        await writeFile(join(setup.cwd, "src", "change.txt"), "executor\n", "utf8");
        return execution(base);
      },
      async rework() { return execution(base); },
      async review() {
        await writeFile(join(setup.cwd, "ignored.txt"), "reviewer mutation\n", "utf8");
        return review(base);
      },
      async close() {},
    };
    const result = await runController(setup, harness);
    assert.equal(result.status, "paused");
    assert.match(result.reason ?? "", /REVIEWER_CHANGED_WORKSPACE/);
    assert.equal((await git(setup.cwd, ["log", "-1", "--pretty=%s"])).stdout.trim(), "test ignored path");
  } finally {
    await rm(setup.cwd, { recursive: true, force: true });
  }
});

test("Reviewer byte mutation of an existing changed path pauses without a commit", async () => {
  const setup = await setupRepo();
  try {
    const base = (await git(setup.cwd, ["rev-parse", "HEAD"])).stdout.trim();
    const harness: HarnessPair = {
      async execute() {
        await writeFile(join(setup.cwd, "src", "change.txt"), "executor\n", "utf8");
        return execution(base);
      },
      async rework() { return execution(base); },
      async review() {
        await writeFile(join(setup.cwd, "src", "change.txt"), "reviewer-mutated\n", "utf8");
        return review(base);
      },
      async close() {},
    };
    const result = await runController(setup, harness);
    assert.equal(result.status, "paused");
    assert.match(result.reason ?? "", /REVIEWER_CHANGED_WORKSPACE/);
    assert.equal((await git(setup.cwd, ["rev-list", "--count", "HEAD"])).stdout.trim(), "1");
    assert.equal((await readFile(join(setup.cwd, "src", "change.txt"), "utf8")).trim(), "reviewer-mutated");
  } finally {
    await rm(setup.cwd, { recursive: true, force: true });
  }
});

test("Reviewer staging or committing is detected by the complete workspace snapshot", async () => {
  const setup = await setupRepo();
  try {
    const base = (await git(setup.cwd, ["rev-parse", "HEAD"])).stdout.trim();
    const harness: HarnessPair = {
      async execute() {
        await writeFile(join(setup.cwd, "src", "change.txt"), "executor\n", "utf8");
        return execution(base);
      },
      async rework() { return execution(base); },
      async review() {
        await git(setup.cwd, ["add", "src/change.txt"]);
        return review(base);
      },
      async close() {},
    };
    const result = await runController(setup, harness);
    assert.equal(result.status, "paused");
    assert.match(result.reason ?? "", /REVIEWER_CHANGED_WORKSPACE/);
    assert.equal((await git(setup.cwd, ["rev-list", "--count", "HEAD"])).stdout.trim(), "1");
    assert.notEqual((await git(setup.cwd, ["diff", "--cached", "--name-only"])).stdout.trim(), "");
  } finally {
    await rm(setup.cwd, { recursive: true, force: true });
  }
});

test("Executor must report every required self-test before Reviewer or commit", async () => {
  const setup = await setupRepo();
  try {
    const base = (await git(setup.cwd, ["rev-parse", "HEAD"])).stdout.trim();
    const harness: HarnessPair = {
      async execute() {
        await writeFile(join(setup.cwd, "src", "change.txt"), "executor\n", "utf8");
        return { ...execution(base), self_tests: [] };
      },
      async rework() { return execution(base); },
      async review() { throw new Error("review must not run"); },
      async close() {},
    };
    const result = await runController(setup, harness, 1);
    assert.equal(result.status, "paused");
    assert.match(result.reason ?? "", /deterministic validation|MAX_REVIEW_ROUNDS/);
    assert.equal((await git(setup.cwd, ["rev-list", "--count", "HEAD"])).stdout.trim(), "1");
  } finally {
    await rm(setup.cwd, { recursive: true, force: true });
  }
});

test("Fresh Reviewer receives previous findings and the same Executor abstraction handles REWORK", async () => {
  const setup = await setupRepo();
  try {
    const base = (await git(setup.cwd, ["rev-parse", "HEAD"])).stdout.trim();
    let secondPrompt = "";
    const executorBases: string[] = [];
    const harness: HarnessPair = {
      async execute(_prompt, _round, options) {
        executorBases.push(options?.phaseBaseCommit ?? "");
        await writeFile(join(setup.cwd, "src", "change.txt"), "first\n", "utf8");
        return execution(base);
      },
      async rework(_prompt, round, options) {
        executorBases.push(options?.phaseBaseCommit ?? "");
        await writeFile(join(setup.cwd, "src", "change.txt"), "fixed\n", "utf8");
        return { ...execution(base), round };
      },
      async review(prompt, round) {
        if (round === 2) secondPrompt = prompt;
        return round === 1
          ? { ...review(base, "REWORK"), round }
          : { ...review(base), round };
      },
      async close() {},
    };
    const result = await runController(setup, harness);
    assert.equal(result.status, "completed");
    assert.deepEqual(executorBases, [base, base]);
    assert.match(secondPrompt, /R001/);
    assert.match(secondPrompt, /round-01-review/);
  } finally {
    await rm(setup.cwd, { recursive: true, force: true });
  }
});

test("cancelled Stage B pauses before commit", async () => {
  const setup = await setupRepo();
  try {
    const base = (await git(setup.cwd, ["rev-parse", "HEAD"])).stdout.trim();
    const controller = new AbortController();
    controller.abort(new Error("test cancellation"));
    const harness = new FakeHarness(setup.cwd, base);
    const state = createDraftState(setup.pkg, "stage-b-test");
    state.status = "frozen";
    const result = await new StageBController({
      package: setup.pkg,
      state,
      git: new GitWorkspace({ run: (args, options) => git(setup.cwd, args) }, { cwd: setup.cwd, runtimeRoot: ".pi-plan-execute-auto/stage-b-test" }),
      acceptanceRunner: { run: async () => ({ stdout: "", stderr: "", code: 0 }) },
      harness,
      signal: controller.signal,
      requireDedicatedWorktree: false,
      saveState: (next) => writeWorkflowState(setup.packageRoot, next),
    }).run();
    assert.equal(result.status, "paused");
    assert.match(result.reason ?? "", /\[ABORTED\]/);
    assert.equal(result.state.pause?.code, "ABORTED");
    assert.equal(result.state.pause?.resumable, true);
    assert.equal(result.state.pause?.detail, "test cancellation");
    assert.equal((await readWorkflowState(setup.packageRoot))?.pause?.code, "ABORTED");
    assert.equal((await git(setup.cwd, ["rev-list", "--count", "HEAD"])).stdout.trim(), "1");
  } finally {
    await rm(setup.cwd, { recursive: true, force: true });
  }
});

test("Stage B aborts persist a precise, resumability-aware pause record", async () => {
  const setup = await setupRepo();
  try {
    const base = (await git(setup.cwd, ["rev-parse", "HEAD"])).stdout.trim();
    const cases: Array<{ reason: StageBAbortReason | Error; code: string }> = [
      { reason: { kind: "timeout", message: "Execution & Review timeout after 60000ms.", timeoutMs: 60_000, elapsedMs: 60_000 }, code: "TIMEOUT" },
      { reason: { kind: "human_stop", message: "Execution & Review stopped by human." }, code: "HUMAN_STOP" },
      { reason: { kind: "session_abort", message: "Pi session interrupted." }, code: "SESSION_ABORT" },
      { reason: new Error("untyped legacy cancellation"), code: "ABORTED" },
    ];
    for (const item of cases) {
      const controller = new AbortController();
      controller.abort(item.reason);
      const state = createDraftState(setup.pkg, "stage-b-test");
      state.status = "frozen";
      const result = await new StageBController({
        package: setup.pkg,
        state,
        git: new GitWorkspace({ run: (args, options) => git(setup.cwd, args) }, { cwd: setup.cwd, runtimeRoot: ".pi-plan-execute-auto/stage-b-test" }),
        acceptanceRunner: { run: async () => ({ stdout: "", stderr: "", code: 0 }) },
        harness: new FakeHarness(setup.cwd, base),
        signal: controller.signal,
        requireDedicatedWorktree: false,
        saveState: (next) => writeWorkflowState(setup.packageRoot, next),
      }).run();
      assert.equal(result.status, "paused");
      assert.equal(result.state.pause?.code, item.code, String(item.reason));
      assert.equal(result.state.pause?.resumable, true, String(item.reason));
      assert.equal(result.state.pause?.stage, "phase");
      assert.match(result.reason ?? "", new RegExp(`\\[${item.code}\\]`));
      assert.equal((await readWorkflowState(setup.packageRoot))?.pause_reason, result.reason);
    }
  } finally {
    await rm(setup.cwd, { recursive: true, force: true });
  }
});

test("a watchdog abort during Executor execution emits an interrupted status with the pause cause", async () => {
  const setup = await setupRepo();
  try {
    const base = (await git(setup.cwd, ["rev-parse", "HEAD"])).stdout.trim();
    const controller = new AbortController();
    const events: StageBStatusEvent[] = [];
    const harness: HarnessPair = {
      async execute() {
        controller.abort({ kind: "timeout", message: "Execution & Review timeout after 60000ms.", timeoutMs: 60_000, elapsedMs: 60_000 } satisfies StageBAbortReason);
        throw new Error("aborted by watchdog");
      },
      async rework() { throw new Error("unexpected rework"); },
      async review() { throw new Error("unexpected review"); },
      async close() {},
    };
    const state = createDraftState(setup.pkg, "stage-b-test");
    state.status = "frozen";
    const result = await new StageBController({
      package: setup.pkg,
      state,
      git: new GitWorkspace({ run: (args, options) => git(setup.cwd, args) }, { cwd: setup.cwd, runtimeRoot: ".pi-plan-execute-auto/stage-b-test" }),
      acceptanceRunner: { run: async () => ({ stdout: "", stderr: "", code: 0 }) },
      harness,
      signal: controller.signal,
      requireDedicatedWorktree: false,
      saveState: (next) => writeWorkflowState(setup.packageRoot, next),
      onStatus: (event) => events.push(event),
    }).run();
    assert.equal(result.status, "paused");
    assert.equal(result.state.pause?.code, "TIMEOUT");
    assert.equal(result.state.pause?.stage, "executor");
    assert.equal(result.state.pause?.timeout_ms, 60_000);
    assert.match(result.reason ?? "", /timed out after 1 minute/);
    const terminal = events.at(-1)!;
    assert.equal(terminal.executor_status, "interrupted");
    assert.equal(terminal.reviewer_status, "interrupted");
    assert.equal(terminal.pause?.code, "TIMEOUT");
    assert.match(terminal.message, /\[TIMEOUT\]/);
    assert.equal((await git(setup.cwd, ["rev-list", "--count", "HEAD"])).stdout.trim(), "1");
  } finally {
    await rm(setup.cwd, { recursive: true, force: true });
  }
});

test("a later phase detects tampering with an earlier phase completion record", async () => {
  const setup = await setupRepo();
  try {
    const input: FinalizeInput = {
      run_id: "two-phase-test",
      manifest: {
        version: 1,
        documents: [],
        phases: [
          { id: "phase-01", order: 1, spec: "phases/phase-01.md", acceptance: "acceptance/phase-01.yaml", commit: { required: true, message: "complete phase-01" } },
          { id: "phase-02", order: 2, spec: "phases/phase-02.md", acceptance: "acceptance/phase-02.yaml", commit: { required: true, message: "complete phase-02" } },
        ],
      },
      files: [
        { path: "phases/phase-01.md", content: "phase one\n" },
        { path: "phases/phase-02.md", content: "phase two\n" },
        ...["phase-01", "phase-02"].map((id) => ({
          path: `acceptance/${id}.yaml`,
          content: [
            "version: 1",
            `phase_id: ${id}`,
            "scope:",
            "  allowed_paths:",
            "    - src/**",
            "self_tests:",
            "  - id: unit",
            "    command: \"true\"",
            "    required: true",
            "review:",
            "  require_no_blocking_findings: true",
            "commit:",
            "  required: true",
            "  allow_empty: false",
            "",
          ].join("\n"),
        })),
      ],
    };
    const written = await writeValidatedPackage(setup.cwd, input, "two-phase-test");
    const validation = await validatePackageDirectory(written.package.root);
    assert.ok(validation.package);
    const base = (await git(setup.cwd, ["rev-parse", "HEAD"])).stdout.trim();
    const report = (phaseId: string, round: number): ExecutionReport => ({
      phase_id: phaseId,
      round,
      base_commit: base,
      status: "complete",
      summary: "done",
      changed_files: [`src/${phaseId}.txt`],
      self_tests: [{ id: "unit", command: "true", status: "passed" }],
      resolved_findings: [],
      known_issues: [],
    });
    const reviewer = (phaseId: string, round: number): ReviewReport => ({
      phase_id: phaseId,
      round,
      base_commit: base,
      verdict: "PASS",
      summary: "green",
      findings: [],
      evidence: ["checked"],
      acceptance_assessment: "pass",
      out_of_scope_changes: [],
    });
    let secondPhase = false;
    const harness: HarnessPair = {
      async execute(prompt) {
        const phaseId = /phase_id: phase-02/.test(prompt) ? "phase-02" : "phase-01";
        secondPhase = phaseId === "phase-02";
        await writeFile(join(setup.cwd, "src", `${phaseId}.txt`), phaseId, "utf8");
        if (secondPhase) await writeFile(join(written.package.root, ".runtime", "completions", "phase-01.diff"), "tampered\n", "utf8");
        return report(phaseId, 1);
      },
      async rework() { throw new Error("unexpected rework"); },
      async review(prompt, round) {
        const phaseId = /phase_id: phase-02/.test(prompt) ? "phase-02" : "phase-01";
        return reviewer(phaseId, round);
      },
      async close() {},
    };
    const result = await runController(setup, harness, 3, { package: validation.package, packageRoot: written.package.root, runId: "two-phase-test" });
    assert.equal(result.status, "paused");
    assert.match(result.reason ?? "", /COMPLETION_EVIDENCE_INVALID|hash mismatch/);
    assert.equal((await git(setup.cwd, ["rev-list", "--count", "HEAD"])).stdout.trim(), "2");
    assert.equal(secondPhase, true);
  } finally {
    await rm(setup.cwd, { recursive: true, force: true });
  }
});

test("two phases complete with an anchored parent commit chain", async () => {
  const setup = await setupRepo();
  try {
    const input: FinalizeInput = {
      run_id: "two-phase-success",
      manifest: {
        version: 1,
        documents: [],
        phases: [
          { id: "phase-01", order: 1, spec: "phases/phase-01.md", acceptance: "acceptance/phase-01.yaml", commit: { required: true, message: "complete phase-01" } },
          { id: "phase-02", order: 2, spec: "phases/phase-02.md", acceptance: "acceptance/phase-02.yaml", commit: { required: true, message: "complete phase-02" } },
        ],
      },
      files: [
        { path: "phases/phase-01.md", content: "phase one\n" },
        { path: "phases/phase-02.md", content: "phase two\n" },
        ...["phase-01", "phase-02"].map((id) => ({
          path: `acceptance/${id}.yaml`,
          content: [
            "version: 1",
            `phase_id: ${id}`,
            "scope:",
            "  allowed_paths:",
            "    - src/**",
            "self_tests:",
            "  - id: unit",
            "    command: \"true\"",
            "    required: true",
            "review:",
            "  require_no_blocking_findings: true",
            "commit:",
            "  required: true",
            "  allow_empty: false",
            "",
          ].join("\n"),
        })),
      ],
    };
    const written = await writeValidatedPackage(setup.cwd, input, "two-phase-success");
    const validation = await validatePackageDirectory(written.package.root);
    assert.ok(validation.package);
    const executorBases: string[] = [];
    const harness: HarnessPair = {
      async execute(prompt, _round, options) {
        const phaseId = /phase_id: (phase-\d+)/.exec(prompt)?.[1] ?? "phase-01";
        const baseCommit = /phase_base_commit: ([0-9a-f]+)/.exec(prompt)?.[1] ?? "";
        executorBases.push(options?.phaseBaseCommit ?? "");
        await writeFile(join(setup.cwd, "src", `${phaseId}.txt`), `${phaseId}\n`, "utf8");
        return {
          phase_id: phaseId,
          round: 1,
          base_commit: baseCommit,
          status: "complete",
          summary: "done",
          changed_files: [`src/${phaseId}.txt`],
          self_tests: [{ id: "unit", command: "true", status: "passed" }],
          resolved_findings: [],
          known_issues: [],
        };
      },
      async rework() { throw new Error("unexpected rework"); },
      async review(prompt) {
        const phaseId = /phase_id: (phase-\d+)/.exec(prompt)?.[1] ?? "phase-01";
        const baseCommit = /phase_base_commit: ([0-9a-f]+)/.exec(prompt)?.[1] ?? "";
        return {
          phase_id: phaseId,
          round: 1,
          base_commit: baseCommit,
          verdict: "PASS",
          summary: "green",
          findings: [],
          evidence: ["checked"],
          acceptance_assessment: "pass",
          out_of_scope_changes: [],
        };
      },
      async close() {},
    };
    const result = await runController(setup, harness, 3, {
      package: validation.package,
      packageRoot: written.package.root,
      runId: "two-phase-success",
    });
    assert.equal(result.status, "completed");
    assert.equal(result.state.phases.every((phase) => phase.status === "completed"), true);
    assert.equal(executorBases.length, 2);
    assert.equal(executorBases[0] === executorBases[1], false);
    assert.equal((await git(setup.cwd, ["rev-list", "--count", "HEAD"])).stdout.trim(), "3");
    await loadValidatedRun(setup.cwd, "two-phase-success");
  } finally {
    await rm(setup.cwd, { recursive: true, force: true });
  }
});

test("SIGKILL at commit / record / state windows recovers safely in single and second phases", { timeout: 180_000 }, async () => {
  for (const twoPhases of [false, true]) {
    for (const window of ["after-commit", "after-record", "after-save"] as const) {
      const setup = await setupRepo();
      const runId = twoPhases ? "crash-two" : "stage-b-test";
      const worktree = join(tmpdir(), ".pi-plan-execute-auto-worktrees", runId);
      try {
        await ensureDedicatedWorktree(createLocalGitOperations(setup.cwd), {
          sourceCwd: setup.cwd, runId, runtimeRoot: `.pi-plan-execute-auto/${runId}`,
          targetPath: worktree, branchName: `pi-plan-execute-auto/${runId}`,
          targetGit: createLocalGitOperations(worktree),
        });
        let pkg = setup.pkg;
        if (twoPhases) {
          const input: FinalizeInput = {
            run_id: runId,
            manifest: {
              version: 1, documents: [],
              phases: ["phase-01", "phase-02"].map((id, index) => ({
                id, order: index + 1, spec: `phases/${id}.md`, acceptance: `acceptance/${id}.yaml`,
                commit: { required: true, message: `complete ${id}` },
              })),
            },
            files: [
              ...["phase-01", "phase-02"].map((id) => ({ path: `phases/${id}.md`, content: `Create src/${id}.txt.\n` })),
              ...["phase-01", "phase-02"].map((id) => ({
                path: `acceptance/${id}.yaml`,
                content: ["version: 1", `phase_id: ${id}`, "scope:", "  allowed_paths:", "    - src/**",
                  "self_tests:", "  - id: unit", "    command: \"true\"", "    required: true",
                  "review:", "  require_no_blocking_findings: true", "commit:", "  required: true", "  allow_empty: false", ""].join("\n"),
              })),
            ],
          };
          const written = await writeValidatedPackage(setup.cwd, input, runId);
          const validation = await validatePackageDirectory(written.package.root);
          assert.ok(validation.package);
          pkg = validation.package;
        }
        const state = createDraftState(pkg, runId);
        state.status = "frozen";
        state.worktree_path = worktree;
        state.branch_name = `pi-plan-execute-auto/${runId}`;
        await writeWorkflowState(pkg.root, state);
        const targetPhase = twoPhases ? "phase-02" : "phase-01";
        const worker = join(process.cwd(), "tests", "fixtures", "crash-stage-b.ts");
        const runWorker = () => execFile(process.execPath, ["--import", "tsx", worker, setup.cwd, worktree, runId, targetPhase, window], {
          cwd: process.cwd(), timeout: 60_000,
        });
        await assert.rejects(runWorker(), (error: unknown) => {
          assert.equal((error as { signal?: string }).signal, "SIGKILL", String(error));
          return true;
        });
        const before = await readWorkflowState(pkg.root);
        assert.ok(before);
        const target = before.phases.at(-1);
        assert.ok(target);
        const record = join(pkg.root, ".runtime", "completions", `${targetPhase}.json`);
        assert.equal(await access(record).then(() => true, () => false), window !== "after-commit");
        assert.equal(target.status, window === "after-save" ? "completed" : "running");
        const expectedCommits = twoPhases ? "3" : "2";
        assert.equal((await git(worktree, ["rev-list", "--count", "HEAD"])).stdout.trim(), expectedCommits);
        await loadValidatedRun(setup.cwd, runId); // Incomplete phase must not be mistaken for a completed one.
        const loaded = await loadValidatedRun(setup.cwd, runId);
        const recover = () => reconcilePersistedCompletions(
          { exec: (_command: string, args: string[], options?: { cwd?: string }) =>
            createLocalGitOperations(options?.cwd ?? setup.cwd).run(args) } as Parameters<typeof reconcilePersistedCompletions>[0],
          {} as Parameters<typeof reconcilePersistedCompletions>[1],
          loaded.package,
          loaded.state,
        );
        if (window === "after-commit") {
          if (twoPhases) {
            await assert.rejects(recover(), /expects HEAD/);
          } else {
            assert.equal(await recover(), undefined);
          }
          const saved = await readWorkflowState(pkg.root);
          assert.notEqual(saved?.status, "completed");
        } else {
          const resumed = await recover();
          assert.equal(resumed?.status, "completed");
          const verified = await loadValidatedRun(setup.cwd, runId);
          assert.equal(verified.state.phases.every((phase) => phase.status === "completed"), true);
        }
        assert.equal((await git(worktree, ["rev-list", "--count", "HEAD"])).stdout.trim(), expectedCommits);
      } finally {
        await git(setup.cwd, ["worktree", "remove", "--force", worktree]);
        await rm(worktree, { recursive: true, force: true });
        await rm(setup.cwd, { recursive: true, force: true });
      }
    }
  }
});

test("review loop breaker pauses without creating a completion commit", async () => {
  const setup = await setupRepo();
  try {
    const base = (await git(setup.cwd, ["rev-parse", "HEAD"])).stdout.trim();
    const harness: HarnessPair = {
      async execute(_prompt, round) {
        await writeFile(join(setup.cwd, "src", "change.txt"), `round-${round}\n`, "utf8");
        return { ...execution(base), round };
      },
      async rework(_prompt, round) {
        await writeFile(join(setup.cwd, "src", "change.txt"), `round-${round}\n`, "utf8");
        return { ...execution(base), round };
      },
      async review(_prompt, round) {
        return { ...review(base, "REWORK"), round };
      },
      async close() {},
    };
    const result = await runController(setup, harness, 2);
    assert.equal(result.status, "paused");
    assert.match(result.reason ?? "", /MAX_REVIEW_ROUNDS/);
    assert.equal(result.state.phases[0]?.phase_commit_sha, undefined);
    const count = await git(setup.cwd, ["rev-list", "--count", "HEAD"]);
    assert.equal(count.stdout.trim(), "1");
  } finally {
    await rm(setup.cwd, { recursive: true, force: true });
  }
});


test("explicit Stage B resume rebuilds a fresh executor turn from persisted paused checkpoint", async () => {
  const setup = await setupRepo();
  try {
    const base = (await git(setup.cwd, ["rev-parse", "HEAD"])).stdout.trim();
    await writeFile(join(setup.cwd, "src", "change.txt"), "partial from interrupted session\n", "utf8");

    const state = createDraftState(setup.pkg, "stage-b-test");
    state.status = "paused";
    state.pause_reason = "[HARNESS_ERROR] Reviewer provider usage limit interrupted the run.";
    state.review_round_limit = 3;
    const phase = state.phases[0]!;
    phase.status = "paused";
    phase.base_commit_sha = base;
    phase.review_rounds = 1;
    phase.last_error = state.pause_reason;

    const harness = new FakeHarness(setup.cwd, base);
    const result = await new StageBController({
      package: setup.pkg,
      state,
      git: new GitWorkspace({ run: (args, options) => git(setup.cwd, args) }, {
        cwd: setup.cwd,
        runtimeRoot: ".pi-plan-execute-auto/stage-b-test",
      }),
      acceptanceRunner: { run: async () => ({ stdout: "", stderr: "", code: 0 }) },
      harness,
      maxReviewRounds: 3,
      resumePaused: true,
      requireDedicatedWorktree: false,
      saveState: (next) => writeWorkflowState(setup.packageRoot, next),
    }).run();

    assert.equal(result.status, "completed");
    assert.equal(harness.executeCalls, 0, "resume checkpoint should be treated as rework of persisted partial work");
    assert.equal(harness.reworkCalls, 1);
    assert.equal(harness.reviewCalls, 1);
    assert.match(harness.lastReworkPrompt, /RESUME CHECKPOINT/);
    assert.match(harness.lastReworkPrompt, /fresh Executor session/);
    assert.match(harness.lastReworkPrompt, /HARNESS_ERROR/);
    assert.match(harness.lastReworkPrompt, /CURRENT ACTUAL WORKTREE DIFF/);
    assert.equal(result.state.phases[0]?.review_rounds, 2);
    assert.equal(result.state.phases[0]?.status, "completed");
  } finally {
    await rm(setup.cwd, { recursive: true, force: true });
  }
});

test("paused Stage B remains inert unless resume is explicitly requested", async () => {
  const setup = await setupRepo();
  try {
    const base = (await git(setup.cwd, ["rev-parse", "HEAD"])).stdout.trim();
    const state = createDraftState(setup.pkg, "stage-b-test");
    state.status = "paused";
    state.pause_reason = "[HARNESS_ERROR] transient";
    state.phases[0]!.status = "paused";
    state.phases[0]!.base_commit_sha = base;
    const harness = new FakeHarness(setup.cwd, base);
    const result = await new StageBController({
      package: setup.pkg,
      state,
      git: new GitWorkspace({ run: (args, options) => git(setup.cwd, args) }, { cwd: setup.cwd }),
      acceptanceRunner: { run: async () => ({ stdout: "", stderr: "", code: 0 }) },
      harness,
      requireDedicatedWorktree: false,
      saveState: async () => {},
    }).run();
    assert.equal(result.status, "paused");
    assert.equal(harness.executeCalls + harness.reworkCalls + harness.reviewCalls, 0);
  } finally {
    await rm(setup.cwd, { recursive: true, force: true });
  }
});


test("resume reconciliation accepts a committed phase whose completion record landed before state save", async () => {
  const setup = await setupRepo();
  try {
    const base = (await git(setup.cwd, ["rev-parse", "HEAD"])).stdout.trim();
    const completed = await runController(setup, new FakeHarness(setup.cwd, base));
    assert.equal(completed.status, "completed");

    const phase = completed.state.phases[0]!;
    const committedSha = phase.phase_commit_sha;
    assert.ok(committedSha);

    // Simulate the crash window: immutable commit/record exist, but persisted
    // workflow state still says the phase was running.
    const stale = structuredClone(completed.state);
    stale.status = "running";
    delete stale.completed_at;
    stale.pause_reason = undefined;
    const stalePhase = stale.phases[0]!;
    stalePhase.status = "running";
    delete stalePhase.phase_commit_sha;
    delete stalePhase.committed_at;
    delete stalePhase.completion_record_path;
    delete stalePhase.completion_record_sha256;
    delete stalePhase.final_diff_path;
    delete stalePhase.final_diff_sha256;
    delete stalePhase.reviewed_diff_sha256;
    await writeWorkflowState(setup.packageRoot, stale);

    let harnessCalls = 0;
    const harness: HarnessPair = {
      async execute() { harnessCalls += 1; throw new Error("executor must not run"); },
      async rework() { harnessCalls += 1; throw new Error("executor must not run"); },
      async review() { harnessCalls += 1; throw new Error("reviewer must not run"); },
      async close() {},
    };
    const recovered = await new StageBController({
      package: setup.pkg,
      state: stale,
      git: new GitWorkspace({ run: (args, options) => git(setup.cwd, args) }, { cwd: setup.cwd }),
      acceptanceRunner: { run: async () => ({ stdout: "", stderr: "", code: 0 }) },
      harness,
      resumePaused: true,
      requireDedicatedWorktree: false,
      saveState: (next) => writeWorkflowState(setup.packageRoot, next),
    }).run();

    assert.equal(recovered.status, "completed");
    assert.equal(harnessCalls, 0);
    assert.equal(stale.status, "completed");
    assert.equal(stale.phases[0]?.status, "completed");
    assert.equal(stale.phases[0]?.phase_commit_sha, committedSha);
  } finally {
    await rm(setup.cwd, { recursive: true, force: true });
  }
});
