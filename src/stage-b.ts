import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_ACCEPTANCE_TIMEOUT_MS,
  acceptanceFailureFingerprint,
  formatAcceptanceDiagnosis,
  formatAcceptanceResults,
  requiredAcceptancePassed,
  runAcceptance,
} from "./acceptance.js";
import { describeAcceptanceSandbox, planAcceptanceProbes } from "./acceptance-environment.js";
import {
  GitPolicyError,
  GitWorkspace,
  phaseCommitMessage,
  phaseCompletionPayloadSha256,
  phaseEvidenceHashesForRecord,
  type GitHistorySnapshot,
  type PhaseEvidenceHashes,
  type WorkspaceSnapshot,
} from "./git.js";
import { isPathAllowed } from "./glob.js";
import {
  completionRecordRelativePath,
  finalDiffRelativePath,
  phaseReportRelativePath,
  sha256Bytes,
  validatePhaseCompletionRecord,
} from "./completion.js";
import {
  blockingFindings,
  formatReviewFeedback,
  makeInvalidExecutionReport,
  makeInvalidReviewReport,
  normalizeExecutionReport,
  MAX_FINDINGS,
  MAX_FINDING_ID_LENGTH,
  normalizeReviewReport,
  validateExecutionEvidence,
} from "./reports.js";
import {
  DEFAULT_MAX_REVIEW_ROUNDS,
  RUNTIME_DIRECTORY,
  type AcceptanceCommandRunner,
  type AcceptanceResult,
  type ExecutionReport,
  type HarnessPair,
  type PauseInput,
  type PauseRecord,
  type PauseStage,
  type PhaseCompletionRecord,
  type PhasePackage,
  type PhaseState,
  type ReviewReport,
  type StageBPlanSnapshot,
  type StageBRunResult,
  type StageBStatusEvent,
  type ValidatedPackage,
  type WorkflowState,
} from "./types.js";
import { abortPauseInput, createPauseRecord, formatPauseReason } from "./pause.js";
import {
  validatePackageDirectory,
  writeJsonAtomic,
  writeJsonExclusive,
  writeTextExclusive,
} from "./package-validator.js";

const MAX_SECTION_BYTES = 24_000;
const DEFAULT_GIT_TIMEOUT_MS = 30_000;
const DEFAULT_ACCEPTANCE_REPEAT_LIMIT = 3;
const ACCEPTANCE_PROBE_TIMEOUT_MS = 30_000;
const MAX_PREVIOUS_FINDING_IDS = 512;
const MAX_PREVIOUS_FINDING_ID_BYTES = 32_000;
const MAX_REVIEW_HISTORY_REPORTS = 100;

function boundSection(value: string, maxBytes = MAX_SECTION_BYTES): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  const head = Math.floor(maxBytes * 0.72);
  const tail = maxBytes - head;
  return `${bytes.subarray(0, head).toString("utf8")}\n[section truncated by plugin]\n${bytes.subarray(bytes.byteLength - tail).toString("utf8")}`;
}

function promptSection(label: string, value: string, maxBytes = MAX_SECTION_BYTES): string {
  return `${label}:\n${boundSection(value, maxBytes)}`;
}

function safePhaseReportPath(phaseId: string, round: number, kind: "execution" | "review" | "acceptance"): string {
  return phaseReportRelativePath(phaseId, round, kind);
}

function completionRecordPath(phaseId: string): string {
  return completionRecordRelativePath(phaseId);
}

function reviewDiffEvidencePath(phaseId: string, round: number): string {
  return `${RUNTIME_DIRECTORY}/review-diffs/${phaseId}-round-${String(round).padStart(2, "0")}.patch`;
}

function finalDiffPath(phaseId: string): string {
  return finalDiffRelativePath(phaseId);
}

function snapshotsEqual(left: WorkspaceSnapshot, right: WorkspaceSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

const GIT_HISTORY_FIELDS = ["head", "branch", "refs", "reflog", "unreachable", "index"] as const;

function changedGitHistoryFields(left: GitHistorySnapshot, right: GitHistorySnapshot): string[] {
  return GIT_HISTORY_FIELDS.filter((field) => left[field] !== right[field]);
}

/**
 * Gitignored dependency/build artifacts are outside the phase commit boundary. They may change
 * freely while the Executor installs or builds, but the Reviewer is told when they changed so
 * acceptance poisoning stays visible instead of silent.
 */
function ignoredChangeNote(before: string, after: string): string | undefined {
  if (before === after) return undefined;
  return [
    "The Executor changed gitignored dependency/build artifacts.",
    `ignored top-level entries before: ${before}`,
    `ignored top-level entries after: ${after}`,
    "Ignored artifacts never enter the phase commit; inspect them only if they could influence acceptance or hide unreviewed behavior.",
  ].join("\n");
}

function deliverableSnapshotsEqual(left: WorkspaceSnapshot, right: WorkspaceSnapshot): boolean {
  return left.status === right.status && left.workingTreeDiff === right.workingTreeDiff && left.fileHashes === right.fileHashes;
}

function sha256(value: string): string {
  return sha256Bytes(Buffer.from(value, "utf8"));
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

export interface StageBControllerOptions {
  package: ValidatedPackage;
  state: WorkflowState;
  git: GitWorkspace;
  acceptanceRunner: AcceptanceCommandRunner;
  harness: HarnessPair;
  saveState: (state: WorkflowState) => Promise<void>;
  onStatus?: (event: StageBStatusEvent) => void;
  signal?: AbortSignal | undefined;
  maxReviewRounds?: number | undefined;
  acceptanceTimeoutMs?: number | undefined;
  /**
   * Stop repeating an identical, unfixable acceptance failure. `1` disables the guard; the default
   * is 3 consecutive identical fingerprints.
   */
  acceptanceRepeatLimit?: number | undefined;
  gitTimeoutMs?: number | undefined;
  /** Extension entry points set this; unit tests may use an explicitly in-memory harness. */
  requireDedicatedWorktree?: boolean;
  /** Explicit safe-resume: rebuild fresh ACP sessions around persisted phase/worktree evidence. */
  resumePaused?: boolean;
}

/**
 * Thin business-policy loop above AgentPrism. It owns phase policy, evidence, and the commit
 * boundary; ACP sessions, structured transport, and harness processes belong to HarnessPair.
 */
export class StageBController {
  private readonly options: StageBControllerOptions;
  private readonly maxReviewRounds: number;
  private readonly acceptanceTimeoutMs: number;
  private readonly acceptanceRepeatLimit: number;
  private readonly gitTimeoutMs: number;
  private readonly state: WorkflowState;
  /** Phases whose acceptance environment preflight already passed in this controller instance. */
  private readonly acceptanceEnvironmentVerified = new Set<string>();
  private acceptanceFingerprint: string | undefined;
  private acceptanceRepeatCount = 0;

  constructor(options: StageBControllerOptions) {
    this.options = options;
    this.state = options.state;
    this.maxReviewRounds = options.maxReviewRounds ?? options.state.review_round_limit ?? options.package.manifest.max_review_rounds ?? DEFAULT_MAX_REVIEW_ROUNDS;
    this.acceptanceTimeoutMs = options.acceptanceTimeoutMs ?? DEFAULT_ACCEPTANCE_TIMEOUT_MS;
    this.acceptanceRepeatLimit = options.acceptanceRepeatLimit ?? DEFAULT_ACCEPTANCE_REPEAT_LIMIT;
    this.gitTimeoutMs = options.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  }

  get currentState(): WorkflowState {
    return this.state;
  }

  private emit(event: StageBStatusEvent): void {
    try {
      this.options.onStatus?.(event);
    } catch {
      // UI projection is observational and must never alter workflow policy.
    }
  }

  private async save(): Promise<void> {
    await this.options.saveState(this.state);
  }

  private gitOptions(): { signal?: AbortSignal; timeout: number } {
    return {
      ...(this.options.signal ? { signal: this.options.signal } : {}),
      timeout: this.gitTimeoutMs,
    };
  }

  private acceptanceOptions(): { signal?: AbortSignal; timeout: number } {
    return {
      ...(this.options.signal ? { signal: this.options.signal } : {}),
      timeout: this.acceptanceTimeoutMs,
    };
  }

  /**
   * Verify — inside the real acceptance sandbox — that every declared requirement and every
   * command's leading executable resolves, before the executor is started.
   *
   * This is the root-cause guard for the failure mode where a frozen contract referenced a host
   * tool that the sandbox cannot see: previously the executor spent rounds re-reporting
   * `command not found` while each round consumed review budget. The preflight is cheap (one probe
   * per distinct target, 30s cap) and pauses with an actionable, resumable diagnosis instead.
   */
  private async guardAcceptanceEnvironment(phase: PhasePackage): Promise<StageBRunResult | undefined> {
    if (this.acceptanceEnvironmentVerified.has(phase.phase.id)) return undefined;
    const probes = planAcceptanceProbes(phase.acceptance.self_tests);
    if (probes.length === 0) {
      this.acceptanceEnvironmentVerified.add(phase.phase.id);
      return undefined;
    }
    const missing: string[] = [];
    const probeTimeout = Math.min(ACCEPTANCE_PROBE_TIMEOUT_MS, this.acceptanceTimeoutMs);
    for (const probe of probes) {
      if (this.options.signal?.aborted) {
        return this.pause(phase, this.abortPause("preflight", "Execution & Review was cancelled during acceptance environment preflight."));
      }
      let result;
      try {
        result = await this.options.acceptanceRunner.run(probe.command, {
          ...(this.options.signal ? { signal: this.options.signal } : {}),
          timeout: probeTimeout,
        });
      } catch (error) {
        missing.push(`${probe.test_id}: probing ${probe.target} failed: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (result.killed) {
        missing.push(`${probe.test_id}: probe for ${probe.target} was killed before it completed.`);
        continue;
      }
      if (result.code !== 0) {
        missing.push(
          `${probe.test_id}: ${probe.kind === "command" ? "command" : "executable path"} ${probe.target}`
          + ` is not resolvable inside the acceptance sandbox (exit ${result.code}).`,
        );
      }
    }
    if (missing.length === 0) {
      this.acceptanceEnvironmentVerified.add(phase.phase.id);
      return undefined;
    }
    return await this.pause(phase, {
      code: "ACCEPTANCE_ENVIRONMENT_MISSING",
      stage: "preflight",
      summary: `Acceptance environment is missing ${missing.length} of ${probes.length} probed requirement(s); no executor round was started.`,
      detail: [
        ...missing,
        "",
        "The frozen acceptance contract cannot be edited by the executor, so this is a host/plan mismatch, not a source failure.",
        "Fix the host (install the tool, repair the symlink) or rewrite the phase acceptance contract, then resume.",
        "",
        ...describeAcceptanceSandbox(),
      ].join("\n"),
    });
  }

  /**
   * Detect an acceptance failure that repeats byte-identically: the executor has no remaining lever
   * (the contract is frozen and the environment is not the executor's to change), so spending the
   * remaining review rounds on it is pure waste.
   */
  private async acceptanceRepeatPause(phase: PhasePackage, results: readonly AcceptanceResult[], round: number): Promise<StageBRunResult | undefined> {
    const fingerprint = acceptanceFailureFingerprint(results);
    if (fingerprint === undefined) {
      this.acceptanceFingerprint = undefined;
      this.acceptanceRepeatCount = 0;
      return undefined;
    }
    if (fingerprint === this.acceptanceFingerprint) this.acceptanceRepeatCount += 1;
    else {
      this.acceptanceFingerprint = fingerprint;
      this.acceptanceRepeatCount = 1;
    }
    if (this.acceptanceRepeatLimit <= 1 || this.acceptanceRepeatCount < this.acceptanceRepeatLimit) return undefined;
    const failing = results.filter((result) => result.required && !result.passed).map((result) => result.id);
    return await this.pause(phase, {
      code: "ACCEPTANCE_BLOCKED_REPEAT",
      stage: "acceptance",
      summary: `Deterministic acceptance repeated the identical failure ${this.acceptanceRepeatCount} times (round ${round}); stopping before consuming the remaining review budget.`,
      detail: [
        `Failing self-tests: ${failing.join(", ") || "(none reported)"}`,
        formatAcceptanceDiagnosis(results),
        "An identical fingerprint across rounds means the round did not change the outcome: either the environment blocks the gate or the contract itself is unsatisfiable.",
        "Repair the host/environment or revise the phase acceptance contract, then resume; a new fingerprint resets this guard.",
      ].join("\n"),
    });
  }

  private phaseState(phase: PhasePackage): PhaseState {
    const state = this.state.phases.find((entry) => entry.phase_id === phase.phase.id);
    if (!state) throw new Error(`Workflow state is missing ${phase.phase.id}.`);
    state.execution_report_paths ??= [];
    state.review_report_paths ??= [];
    state.unresolved_findings ??= [];
    return state;
  }

  private async assertPackageUnchanged(): Promise<void> {
    const validation = await validatePackageDirectory(this.options.package.root);
    if (!validation.ok || !validation.package) {
      throw new WorkflowPauseError("GOLDEN_PACKAGE_INVALID", "Frozen Golden Document Package is no longer valid.");
    }
    if (validation.package.package_hash !== this.state.package_hash) {
      throw new WorkflowPauseError(
        "GOLDEN_PACKAGE_CHANGED",
        `Frozen Golden Document Package hash changed from ${this.state.package_hash} to ${validation.package.package_hash}.`,
      );
    }
  }

  private async assertBase(baseCommit: string): Promise<void> {
    const head = await this.options.git.head(this.gitOptions());
    if (head !== baseCommit) {
      throw new WorkflowPauseError(
        "HEAD_CHANGED",
        `HEAD changed from phase base ${baseCommit} to ${head}; history will not be rewritten automatically.`,
      );
    }
  }

  private async assertScope(phase: PhasePackage): Promise<string[]> {
    const changed = await this.options.git.changedPaths(this.gitOptions());
    return changed.filter((path) => !isPathAllowed(path, phase.acceptance.scope.allowed_paths));
  }

  private async assertNoHistoryOrIndexMutation(before: GitHistorySnapshot, actor: string): Promise<GitHistorySnapshot> {
    const after = await this.options.git.historySnapshot(this.gitOptions());
    const changed = changedGitHistoryFields(before, after);
    if (changed.length > 0) {
      throw new WorkflowPauseError(
        "HARNESS_CHANGED_HISTORY",
        `${actor} changed Git ${changed.join(", ")}; no reset was attempted.`,
      );
    }
    return after;
  }

  private async assertCompletedEvidence(): Promise<void> {
    for (const phaseState of this.state.phases.filter((entry) => entry.status === "completed")) {
      if (!phaseState.completion_record_sha256) {
        throw new WorkflowPauseError("COMPLETION_RECORD_MISSING", `Completed phase ${phaseState.phase_id} has no record hash.`);
      }
      try {
        const phase = this.options.package.phases.find((entry) => entry.phase.id === phaseState.phase_id);
        if (!phase) throw new WorkflowPauseError("PHASE_MISSING", `Completion phase is not in the frozen package: ${phaseState.phase_id}`);
        const evidence = await validatePhaseCompletionRecord(
          this.options.package.root,
          phaseState.phase_id,
          this.state.package_hash,
          {
            ...(phaseState.base_commit_sha ? { base_commit_sha: phaseState.base_commit_sha } : {}),
            ...(phaseState.phase_commit_sha ? { phase_commit_sha: phaseState.phase_commit_sha } : {}),
            completion_record_sha256: phaseState.completion_record_sha256,
            ...(phaseState.reviewed_diff_sha256 ? { reviewed_diff_sha256: phaseState.reviewed_diff_sha256 } : {}),
          },
          phase.acceptance,
        );
        await this.options.git.verifyPhaseCommit(
          evidence.record.phase_commit_sha,
          evidence.record.base_commit_sha,
          phase.phase.commit.message,
          evidence.record.final_diff_sha256,
          this.gitOptions(),
          phaseEvidenceHashesForRecord(evidence.record),
        );
      } catch (error) {
        throw new WorkflowPauseError(
          "COMPLETION_EVIDENCE_INVALID",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  private async writeExecutionReport(phase: PhasePackage, round: number, report: ExecutionReport): Promise<string> {
    const relative = safePhaseReportPath(phase.phase.id, round, "execution");
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    await writeJsonAtomic(join(this.options.package.root, ...relative.split("/")), report);
    const state = this.phaseState(phase);
    state.execution_report_path = relative;
    if (!state.execution_report_paths.includes(relative)) state.execution_report_paths.push(relative);
    if (report.executor_session_id) state.executor_session_id = report.executor_session_id;
    return sha256(serialized);
  }

  private async writeReviewReport(phase: PhasePackage, round: number, report: ReviewReport): Promise<string> {
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    const relative = safePhaseReportPath(phase.phase.id, round, "review");
    await writeJsonAtomic(join(this.options.package.root, ...relative.split("/")), report);
    const state = this.phaseState(phase);
    state.review_report_path = relative;
    if (!state.review_report_paths.includes(relative)) state.review_report_paths.push(relative);
    if (report.reviewer_session_id) state.reviewer_session_id = report.reviewer_session_id;
    state.unresolved_findings = report.verdict === "PASS" ? [] : blockingFindings(report);
    return sha256(serialized);
  }

  private async writeAcceptanceResults(phase: PhasePackage, round: number, results: AcceptanceResult[]): Promise<string> {
    const serialized = `${JSON.stringify(results, null, 2)}\n`;
    const relative = safePhaseReportPath(phase.phase.id, round, "acceptance");
    await writeJsonAtomic(join(this.options.package.root, ...relative.split("/")), results);
    const state = this.phaseState(phase);
    state.acceptance_report_path = relative;
    state.acceptance_results = results;
    return sha256(serialized);
  }

  private async captureReportHashes(phase: PhasePackage): Promise<Map<string, string>> {
    const state = this.phaseState(phase);
    if (state.execution_report_paths.length > MAX_REVIEW_HISTORY_REPORTS || state.review_report_paths.length > MAX_REVIEW_HISTORY_REPORTS) {
      throw new WorkflowPauseError("REPORT_CONTEXT_LIMIT", "Persisted report paths exceed the bounded evidence limit.");
    }
    const paths = new Set([
      ...state.execution_report_paths,
      ...state.review_report_paths,
      ...(state.acceptance_report_path ? [state.acceptance_report_path] : []),
    ]);
    const hashes = new Map<string, string>();
    for (const relative of paths) {
      if (!relative.startsWith(`${RUNTIME_DIRECTORY}/reports/`) || relative.includes("\\") || relative.split("/").some((part) => part === ".." || part === "." || part.length === 0)) {
        throw new WorkflowPauseError("REPORT_PATH_INVALID", `Invalid persisted report path: ${relative}`);
      }
      const bytes = await readFile(join(this.options.package.root, ...relative.split("/")));
      hashes.set(relative, sha256Bytes(bytes));
    }
    return hashes;
  }

  private async assertReportHashes(before: Map<string, string>, actor: string): Promise<void> {
    for (const [relative, expected] of before) {
      let actual: string;
      try {
        actual = sha256Bytes(await readFile(join(this.options.package.root, ...relative.split("/"))));
      } catch (error) {
        throw new WorkflowPauseError("REPORT_CHANGED", `${actor} removed report evidence ${relative}: ${String(error)}`);
      }
      if (actual !== expected) {
        throw new WorkflowPauseError("REPORT_CHANGED", `${actor} changed report evidence ${relative}; no completion commit was created.`);
      }
    }
  }

  private async loadReviewHistory(phase: PhasePackage): Promise<ReviewReport[]> {
    const state = this.phaseState(phase);
    if (state.review_report_paths.length > MAX_REVIEW_HISTORY_REPORTS) {
      throw new WorkflowPauseError("REPORT_CONTEXT_LIMIT", "Persisted review history exceeds the bounded report limit.");
    }
    const history: ReviewReport[] = [];
    for (const relative of state.review_report_paths) {
      const roundMatch = relative.match(/-round-(\d+)-review\.json$/);
      const round = Number(roundMatch?.[1] ?? 0);
      if (!roundMatch || relative !== safePhaseReportPath(phase.phase.id, round, "review")) {
        throw new WorkflowPauseError("REPORT_PATH_INVALID", `Invalid persisted review report path: ${relative}`);
      }
      let value: unknown;
      try {
        value = JSON.parse(await readFile(join(this.options.package.root, ...relative.split("/")), "utf8")) as unknown;
      } catch (error) {
        throw new WorkflowPauseError("REPORT_UNREADABLE", `Cannot load persisted review report ${relative}: ${String(error)}`);
      }
      const parsed = normalizeReviewReport(value, {
        phase_id: phase.phase.id,
        round,
        base_commit: state.base_commit_sha ?? "",
      });
      if (!parsed.report) throw new WorkflowPauseError("REPORT_INVALID", parsed.error ?? `Invalid review report ${relative}`);
      history.push(parsed.report);
    }
    return history;
  }

  private async reconcileCompletion(phase: PhasePackage): Promise<boolean> {
    const state = this.phaseState(phase);
    try {
      const evidence = await validatePhaseCompletionRecord(
        this.options.package.root,
        phase.phase.id,
        this.state.package_hash,
        state.completion_record_sha256
          ? {
              ...(state.base_commit_sha ? { base_commit_sha: state.base_commit_sha } : {}),
              ...(state.phase_commit_sha ? { phase_commit_sha: state.phase_commit_sha } : {}),
              completion_record_sha256: state.completion_record_sha256,
              ...(state.reviewed_diff_sha256 ? { reviewed_diff_sha256: state.reviewed_diff_sha256 } : {}),
            }
          : undefined,
        phase.acceptance,
      );
      const head = await this.options.git.head(this.gitOptions());
      if (
        head !== evidence.record.phase_commit_sha &&
        !(await this.options.git.isAncestor(evidence.record.phase_commit_sha, head, this.gitOptions()))
      ) {
        throw new WorkflowPauseError(
          "COMPLETION_HEAD_MISMATCH",
          `Completion record commit ${evidence.record.phase_commit_sha} is not an ancestor of worktree HEAD ${head}; the plugin did not reset anything.`,
        );
      }
      try {
        await this.options.git.verifyPhaseCommit(
          evidence.record.phase_commit_sha,
          evidence.record.base_commit_sha,
          phase.phase.commit.message,
          evidence.record.final_diff_sha256,
          this.gitOptions(),
          phaseEvidenceHashesForRecord(evidence.record),
        );
      } catch (error) {
        if (error instanceof GitPolicyError) throw new WorkflowPauseError(error.code, error.message);
        throw error;
      }
      state.base_commit_sha = evidence.record.base_commit_sha;
      state.phase_commit_sha = evidence.record.phase_commit_sha;
      state.committed_at = evidence.record.committed_at;
      state.review_rounds = evidence.record.review_rounds;
      state.execution_report_path = evidence.record.execution_report_path;
      state.review_report_path = evidence.record.review_report_path;
      state.acceptance_report_path = evidence.record.acceptance_report_path;
      state.acceptance_results = evidence.record.acceptance_results;
      state.completion_record_path = completionRecordPath(phase.phase.id);
      state.completion_record_sha256 = evidence.recordSha256;
      state.final_diff_path = evidence.record.final_diff_path;
      state.final_diff_sha256 = evidence.record.final_diff_sha256;
      state.reviewed_diff_sha256 = evidence.record.reviewed_diff_sha256;
      state.status = "completed";
      await this.save();
      return true;
    } catch (error) {
      if (isMissingFile(error)) return false;
      if (error instanceof Error && /ENOENT/.test(error.message)) return false;
      if (error instanceof WorkflowPauseError) throw error;
      throw new WorkflowPauseError(
        "COMPLETION_EVIDENCE_INVALID",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private executorPrompt(
    phase: PhasePackage,
    baseCommit: string,
    round: number,
    diff: string,
    feedback?: string,
  ): string {
    const lines = [
      "You are the Executor Agent in pi-plan-execute-auto.",
      "Implement CURRENT PHASE ONLY. Do not implement later phases, edit Golden Docs, or create any commit.",
      `The sandbox exposes a read-only Git metadata mirror for the run's own history (planning baseline through the current phase base ${baseCommit}); it never mounts the shared host Git directory or unrelated history. Use Git to inspect status/diff, but never stage or commit. The plugin owns all commits.`,
      "You must work in the supplied workspace, inspect the source yourself, and execute every required self-test in the frozen acceptance contract on every round.",
      "Your structured self_tests entries must exactly copy every required test id and command and report passed only after actually running it.",
      `acceptance_command_budget_ms: ${this.acceptanceTimeoutMs} (per required command unless the contract declares self_tests[].timeout_ms)`,
      promptSection("ACCEPTANCE SANDBOX CONTRACT (the plugin runs these commands here, not in your shell)", describeAcceptanceSandbox().join("\n"), 6_000),
      "The plugin, not you, owns phase commits.",
      `golden_package_root: ${this.options.package.root}`,
      `golden_package_hash: ${this.state.package_hash}`,
      promptSection("golden_manifest", JSON.stringify(this.options.package.manifest, null, 2), 12_000),
      `phase_id: ${phase.phase.id}`,
      `round: ${round}`,
      `review_round_limit: ${this.maxReviewRounds}`,
      `review_rounds_remaining_including_this_round: ${this.maxReviewRounds - round + 1}`,
      `review_rounds_remaining_after_this_round: ${this.maxReviewRounds - round}`,
      "Use the remaining review budget deliberately: finish the current phase, run all required self-tests, and address all known findings before returning.",
      `phase_base_commit: ${baseCommit}`,
      `allowed_paths: ${JSON.stringify(phase.acceptance.scope.allowed_paths)}`,
      promptSection("CURRENT PHASE SPEC", phase.spec, 20_000),
      promptSection("CURRENT PHASE ACCEPTANCE CONTRACT", JSON.stringify(phase.acceptance, null, 2), 12_000),
      promptSection("CURRENT ACTUAL WORKTREE DIFF (inspect the workspace and source independently)", diff || "(no tracked or untracked changes yet)", 24_000),
      ...(feedback ? [promptSection("PREVIOUS REVIEW / DETERMINISTIC FEEDBACK (must be fixed in this round)", feedback, 20_000)] : []),
      "At the end return ONLY a structured execution report with phase_id, round, base_commit, status, summary, changed_files, self_tests, resolved_findings, and known_issues.",
    ];
    return lines.join("\n\n");
  }

  private reviewerPrompt(
    phase: PhasePackage,
    baseCommit: string,
    round: number,
    diff: string,
    diffEvidencePath: string,
    diffSha256: string,
    execution: ExecutionReport,
    acceptance: AcceptanceResult[],
    history: ReviewReport[],
    workspaceNote?: string,
  ): string {
    const previousFindings = history.flatMap((report) => report.findings).map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      summary: finding.summary,
      evidence: finding.evidence.slice(0, 2000),
      blocking: finding.blocking,
    }));
    const reportPaths = this.phaseState(phase).review_report_paths;
    const previousFindingIds = [...new Set(previousFindings.map((finding) => finding.id))];
    if (
      previousFindingIds.length > MAX_PREVIOUS_FINDING_IDS ||
      previousFindingIds.some((id) => id.length > MAX_FINDING_ID_LENGTH) ||
      Buffer.byteLength(previousFindingIds.join(", "), "utf8") > MAX_PREVIOUS_FINDING_ID_BYTES ||
      previousFindings.length > MAX_REVIEW_HISTORY_REPORTS * MAX_FINDINGS
    ) {
      throw new WorkflowPauseError("REPORT_CONTEXT_LIMIT", "Review finding history exceeds the bounded Reviewer prompt limit.");
    }
    const boundedHistory = history.map((report) => ({
      ...report,
      findings: report.findings.map((finding) => ({
        ...finding,
        evidence: finding.evidence.slice(0, 1500),
      })),
      evidence: report.evidence.map((entry) => entry.slice(0, 1000)),
    }));
    const lines = [
      "You are the independent Reviewer Agent in pi-plan-execute-auto.",
      "Review CURRENT PHASE ONLY. Do not modify files, stage files, or create a commit. Any requested write permission must be rejected.",
      "You must independently read the frozen Golden Docs, current phase spec, current acceptance contract, relevant source and tests, and inspect the actual workspace.",
      `Use ${baseCommit} as the phase base. The sandbox provides a read-only Git metadata mirror for the run's own history up to this commit, not the shared host Git directory or unrelated pre-run history. Independently run git status and generate tracked changes with git diff --no-ext-diff --no-textconv --no-renames --binary ${baseCommit}; include each untracked path with git diff --no-index --binary -- /dev/null <path>. Ignore plugin runtime artifacts under .pi-plan-execute-auto/. Compare the result with the complete immutable plugin-generated diff below and inspect relevant source/tests. Never stage or commit.`,
      `complete_canonical_diff_path: ${diffEvidencePath}`,
      `complete_canonical_diff_sha256: ${diffSha256}`,
      "Verify the supplied complete patch SHA-256 against the stated hash before review; report any mismatch as a blocking finding.",
      "Every previous review report is included below. Re-check every previous finding and state whether it is resolved; do not silently drop a finding in a fresh session.",
      `golden_package_root: ${this.options.package.root}`,
      `golden_package_hash: ${this.state.package_hash}`,
      promptSection("golden_manifest", JSON.stringify(this.options.package.manifest, null, 2), 12_000),
      `phase_id: ${phase.phase.id}`,
      `round: ${round}`,
      `review_round_limit: ${this.maxReviewRounds}`,
      `review_rounds_remaining_including_this_round: ${this.maxReviewRounds - round + 1}`,
      `review_rounds_remaining_after_this_round: ${this.maxReviewRounds - round}`,
      "Use the remaining review budget explicitly: identify every blocking issue now, avoid drip-feeding findings across rounds, and PASS only when this phase is actually acceptable.",
      `phase_base_commit: ${baseCommit}`,
      promptSection("CURRENT PHASE SPEC", phase.spec, 20_000),
      promptSection("CURRENT PHASE ACCEPTANCE CONTRACT", JSON.stringify(phase.acceptance, null, 2), 12_000),
      promptSection("ACTUAL DIFF PREVIEW (the full immutable patch is at complete_canonical_diff_path)", diff || "(no tracked or untracked changes)", 24_000),
      ...(workspaceNote ? [promptSection("EXECUTOR WORKSPACE NOTE (advisory; ignored artifacts are outside the phase commit boundary)", workspaceNote, 4_000)] : []),
      promptSection("EXECUTOR REPORT (evidence to verify, not authority)", JSON.stringify(execution, null, 2), 12_000),
      promptSection("PLUGIN ACCEPTANCE RESULTS", JSON.stringify(acceptance, null, 2), 10_000),
      promptSection("PREVIOUS REVIEW REPORT PATHS (all must remain in scope)", JSON.stringify(reportPaths, null, 2), 8_000),
      `PREVIOUS FINDING IDS (complete, no truncation): ${previousFindingIds.join(", ") || "(none)"}`,
      promptSection("PREVIOUS FINDINGS TO RECHECK (summaries/evidence are bounded; use the complete ID index above)", JSON.stringify(previousFindings, null, 2), 18_000),
      promptSection("PREVIOUS REVIEW REPORTS (bounded additional evidence)", JSON.stringify(boundedHistory, null, 2), 18_000),
      "Return ONLY a structured review report with phase_id, round, base_commit, verdict (PASS or REWORK), summary, findings, evidence, acceptance_assessment, and out_of_scope_changes.",
      "PASS is allowed only when there are no blocking findings, all previous blocking findings are resolved, and deterministic acceptance is green.",
    ];
    return lines.join("\n\n");
  }

  private resumeFeedback(
    phase: PhasePackage,
    history: ReviewReport[],
  ): string {
    const state = this.phaseState(phase);
    const pause = this.state.pause;
    const previousPause = pause
      ? `[${pause.code}] ${pause.summary}${pause.detail && pause.detail !== pause.summary ? ` (${pause.detail})` : ""}`
      : state.last_error ?? this.state.pause_reason ?? "(unknown)";
    const pieces = [
      "RESUME CHECKPOINT: a previous ACP session ended before this phase completed.",
      "This is a fresh Executor session. Do not assume conversational memory from the prior session.",
      `Persisted rounds already consumed: ${state.review_rounds} of ${this.maxReviewRounds}.`,
      `Previous pause: ${previousPause}`,
      "Inspect the actual current worktree diff and frozen phase contract before changing anything.",
      "Preserve valid in-scope partial work; fix it in place rather than resetting or discarding the worktree.",
    ];
    if (state.acceptance_results?.length) {
      pieces.push(`Last persisted deterministic acceptance:\n${formatAcceptanceResults(state.acceptance_results)}`);
    }
    if (state.unresolved_findings.length > 0) {
      pieces.push(`Persisted unresolved findings:\n${state.unresolved_findings.map((finding) => `- ${finding.id}: ${finding.summary}`).join("\n")}`);
    }
    const lastReview = history.at(-1);
    if (lastReview) pieces.push(`Last persisted Reviewer report:\n${formatReviewFeedback(lastReview)}`);
    pieces.push("Continue CURRENT PHASE ONLY, rerun every required self-test, and return a fresh structured execution report. Do not commit.");
    return pieces.join("\n\n");
  }

  private feedbackForExecution(
    execution: ExecutionReport,
    acceptance: AcceptanceResult[],
    outOfScope: string[],
    review?: ReviewReport,
    validationError?: string,
  ): string {
    const pieces = [
      "Plugin validation rejected this round. Keep working in the same phase and same executor session.",
      `Executor report status: ${execution.status}`,
      `Deterministic acceptance:\n${formatAcceptanceResults(acceptance)}`,
    ];
    if (validationError) pieces.push(`Executor evidence validation: ${validationError}`);
    if (acceptance.some((result) => result.timed_out === true)) {
      pieces.push(`Killed by the plugin budget, not by the project:\n${formatAcceptanceDiagnosis(acceptance)}`);
    }
    if (outOfScope.length > 0) pieces.push(`Out-of-scope changed paths (must be corrected, do not reset history): ${outOfScope.join(", ")}`);
    if (review) pieces.push(formatReviewFeedback(review));
    pieces.push("Do not commit. Return a new structured execution report after fixing the findings and rerunning every required self-test.");
    return pieces.join("\n\n");
  }

  private async pause(phase: PhasePackage | undefined, input: PauseInput): Promise<StageBRunResult> {
    const phaseState = phase ? this.phaseState(phase) : undefined;
    const record: PauseRecord = createPauseRecord({
      ...input,
      ...(phase && phaseState ? { phase_id: phase.phase.id, round: phaseState.review_rounds } : {}),
    });
    this.state.status = "paused";
    this.state.pause = record;
    this.state.pause_reason = formatPauseReason(record);
    if (phase && phaseState) {
      if (phaseState.status !== "completed") {
        phaseState.status = "paused";
        phaseState.last_error = this.state.pause_reason;
      }
      this.emit({
        phase_id: phase.phase.id,
        round: phaseState.review_rounds,
        executor_status: "interrupted",
        reviewer_status: "interrupted",
        message: this.state.pause_reason,
        pause: record,
        plan: this.planSnapshot(),
      });
    }
    await this.save();
    const pauseReason = this.state.pause_reason ?? formatPauseReason(record);
    return { status: "paused", state: this.state, reason: pauseReason, pause: record };
  }

  /** Classify the Stage B abort signal into a precise, resumability-aware pause cause. */
  private abortPause(stage: PauseStage, summary: string): PauseInput {
    return abortPauseInput(this.options.signal?.reason, { stage, summary });
  }

  /** Cheap plan progress snapshot shared by every status event and the live widget. */
  private planSnapshot(): StageBPlanSnapshot {
    const phases = this.options.package.phases;
    const phaseStatuses = phases.map((phase) => this.phaseState(phase).status);
    return {
      phase_ids: phases.map((phase) => phase.phase.id),
      phase_statuses: phaseStatuses,
      current_index: phaseStatuses.findIndex((status) => status !== "completed"),
      review_round_limit: this.maxReviewRounds,
    };
  }

  private async phase(phase: PhasePackage): Promise<StageBRunResult | undefined> {
    await this.assertCompletedEvidence();
    const phaseState = this.phaseState(phase);
    const resumingFromCheckpoint = this.options.resumePaused === true &&
      (phaseState.status === "paused" || phaseState.status === "running");
    if (phaseState.status === "completed") {
      if (!(await this.reconcileCompletion(phase))) {
        throw new WorkflowPauseError("COMPLETION_RECORD_MISSING", `Completed phase ${phase.phase.id} has no immutable completion record.`);
      }
      return undefined;
    }
    if (await this.reconcileCompletion(phase)) return undefined;

    let baseCommit = phaseState.base_commit_sha;
    if (!baseCommit) {
      baseCommit = await this.options.git.head(this.gitOptions());
      phaseState.base_commit_sha = baseCommit;
      phaseState.status = "running";
      phaseState.review_rounds = 0;
      phaseState.execution_report_paths = [];
      phaseState.review_report_paths = [];
      phaseState.unresolved_findings = [];
      await this.options.git.assertNoCachedChanges(this.gitOptions());
      if ((await this.options.git.changedPaths(this.gitOptions())).length > 0) {
        throw new WorkflowPauseError(
          "DIRTY_WORKTREE",
          "Phase must start from a clean worktree outside the plugin runtime directory.",
        );
      }
      await this.save();
    } else {
      await this.assertBase(baseCommit);
      phaseState.status = "running";
    }

    let history = await this.loadReviewHistory(phase);
    let feedback: string | undefined = resumingFromCheckpoint ? this.resumeFeedback(phase, history) : undefined;
    let freshResumeTurn = resumingFromCheckpoint;
    const environmentPause = await this.guardAcceptanceEnvironment(phase);
    if (environmentPause) return environmentPause;
    this.acceptanceFingerprint = undefined;
    this.acceptanceRepeatCount = 0;
    while (phaseState.review_rounds < this.maxReviewRounds) {
      if (this.options.signal?.aborted) {
        return this.pause(phase, this.abortPause("phase", "Execution & Review was cancelled before phase completion."));
      }
      const round = phaseState.review_rounds + 1;
      await this.assertPackageUnchanged();
      await this.assertBase(baseCommit);
      await this.options.git.assertNoCachedChanges(this.gitOptions());
      const initialDiff = await this.options.git.diffFrom(baseCommit, this.gitOptions());
      const beforeExecutorReports = await this.captureReportHashes(phase);
      const beforeExecutorHistory = await this.options.git.historySnapshot(this.gitOptions());
      const beforeExecutorIgnored = await this.options.git.ignoredSummary(this.gitOptions());
      this.emit({
        phase_id: phase.phase.id,
        round,
        executor_status: "running",
        reviewer_status: "pending",
        message: freshResumeTurn
          ? "Executor rebuilding a fresh session from the persisted resume checkpoint."
          : feedback
            ? "Executor resuming same session after feedback."
            : "Executor implementing current phase.",
        plan: this.planSnapshot(),
      });

      const harnessOptions = {
        phaseBaseCommit: baseCommit,
        ...(this.options.signal ? { signal: this.options.signal } : {}),
      };
      let execution: ExecutionReport;
      try {
        const raw = feedback
          ? await this.options.harness.rework(
              this.executorPrompt(phase, baseCommit, round, initialDiff, feedback),
              round,
              harnessOptions,
            )
          : await this.options.harness.execute(
              this.executorPrompt(phase, baseCommit, round, initialDiff),
              round,
              harnessOptions,
            );
        const normalized = normalizeExecutionReport(raw, {
          phase_id: phase.phase.id,
          round,
          base_commit: baseCommit,
        });
        execution = normalized.report ?? makeInvalidExecutionReport(
          { phase_id: phase.phase.id, round, base_commit: baseCommit },
          normalized.error ?? "unknown structured report error",
        );
      } catch (error) {
        if (this.options.signal?.aborted) {
          return this.pause(phase, this.abortPause("executor", "Execution & Review was cancelled during Executor execution."));
        }
        if (error instanceof WorkflowPauseError) throw error;
        throw new WorkflowPauseError(
          "HARNESS_ERROR",
          `Executor harness failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      freshResumeTurn = false;
      await this.assertNoHistoryOrIndexMutation(beforeExecutorHistory, "Executor");
      const executorWorkspaceNote = ignoredChangeNote(
        beforeExecutorIgnored,
        await this.options.git.ignoredSummary(this.gitOptions()),
      );
      await this.assertReportHashes(beforeExecutorReports, "Executor");
      await this.assertPackageUnchanged();
      await this.assertCompletedEvidence();
      const executionReportSha256 = await this.writeExecutionReport(phase, round, execution);
      phaseState.review_rounds = round;
      await this.save();

      await this.assertBase(baseCommit);
      await this.options.git.assertNoCachedChanges(this.gitOptions());
      const actualChanged = await this.options.git.changedPaths(this.gitOptions());
      const evidenceError = validateExecutionEvidence(execution, phase.acceptance, actualChanged);
      const outOfScope = await this.assertScope(phase);
      const beforeAcceptanceReports = await this.captureReportHashes(phase);
      const beforeAcceptanceHistory = await this.options.git.historySnapshot(this.gitOptions());
      const acceptance = await runAcceptance(phase.acceptance, this.options.acceptanceRunner, this.acceptanceOptions());
      await this.assertNoHistoryOrIndexMutation(beforeAcceptanceHistory, "Deterministic acceptance");
      await this.assertReportHashes(beforeAcceptanceReports, "Deterministic acceptance");
      await this.assertCompletedEvidence();
      await this.writeAcceptanceResults(phase, round, acceptance);
      await this.save();
      if (execution.status !== "complete" || evidenceError || outOfScope.length > 0 || !requiredAcceptancePassed(acceptance)) {
        feedback = this.feedbackForExecution(execution, acceptance, outOfScope, undefined, evidenceError);
        const repeatPause = await this.acceptanceRepeatPause(phase, acceptance, round);
        if (repeatPause) return repeatPause;
        if (round >= this.maxReviewRounds) {
          return this.pause(phase, { code: "MAX_REVIEW_ROUNDS", stage: "acceptance", summary: `Phase did not pass deterministic validation after ${round} review rounds.` });
        }
        continue;
      }

      const beforeReviewReports = await this.captureReportHashes(phase);
      const beforeReviewSnapshot = await this.options.git.snapshot(this.gitOptions());
      const reviewDiff = await this.options.git.diffFrom(baseCommit, this.gitOptions());
      const reviewDiffRelative = reviewDiffEvidencePath(phase.phase.id, round);
      const reviewDiffAbsolute = join(this.options.package.root, ...reviewDiffRelative.split("/"));
      await writeTextExclusive(reviewDiffAbsolute, reviewDiff);
      const reviewDiffSha256 = sha256Bytes(Buffer.from(reviewDiff, "utf8"));
      this.emit({
        phase_id: phase.phase.id,
        round,
        executor_status: "complete",
        reviewer_status: "running",
        message: "Independent reviewer inspecting current phase diff.",
        plan: this.planSnapshot(),
      });
      let review: ReviewReport;
      try {
        const raw = await this.options.harness.review(
          this.reviewerPrompt(phase, baseCommit, round, reviewDiff, reviewDiffAbsolute, reviewDiffSha256, execution, acceptance, history, executorWorkspaceNote),
          round,
          harnessOptions,
        );
        const normalized = normalizeReviewReport(raw, {
          phase_id: phase.phase.id,
          round,
          base_commit: baseCommit,
        });
        review = normalized.report ?? makeInvalidReviewReport(
          { phase_id: phase.phase.id, round, base_commit: baseCommit },
          normalized.error ?? "unknown structured report error",
        );
      } catch (error) {
        if (this.options.signal?.aborted) {
          return this.pause(phase, this.abortPause("reviewer", "Execution & Review was cancelled during Reviewer execution."));
        }
        if (error instanceof WorkflowPauseError) throw error;
        throw new WorkflowPauseError(
          "HARNESS_ERROR",
          `Reviewer harness failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await this.assertReportHashes(beforeReviewReports, "Reviewer");
      const persistedReviewDiff = await readFile(reviewDiffAbsolute);
      if (sha256Bytes(persistedReviewDiff) !== reviewDiffSha256) {
        throw new WorkflowPauseError("REVIEW_DIFF_CHANGED", "The immutable Reviewer diff evidence changed during review.");
      }
      const reviewReportSha256 = await this.writeReviewReport(phase, round, review);
      await this.save();

      const afterReviewSnapshot = await this.options.git.snapshot(this.gitOptions());
      if (!snapshotsEqual(beforeReviewSnapshot, afterReviewSnapshot)) {
        throw new WorkflowPauseError(
          "REVIEWER_CHANGED_WORKSPACE",
          "Reviewer changed HEAD, the index, file bytes, or workspace status; no reset was attempted.",
        );
      }
      await this.assertPackageUnchanged();
      await this.assertCompletedEvidence();
      history = [...history, review];

      const invalidReview = review.verdict !== "PASS" || blockingFindings(review).length > 0 || review.out_of_scope_changes.length > 0;
      if (invalidReview) {
        this.emit({
          phase_id: phase.phase.id,
          round,
          executor_status: "complete",
          reviewer_status: "rework",
          message: `Reviewer requested rework: ${review.summary}`,
          plan: this.planSnapshot(),
        });
        feedback = this.feedbackForExecution(execution, acceptance, [], review);
        if (round >= this.maxReviewRounds) {
          return this.pause(phase, { code: "MAX_REVIEW_ROUNDS", stage: "reviewer", summary: `Reviewer did not PASS after ${round} review rounds.` });
        }
        continue;
      }

      // Acceptance is deliberately rerun after PASS. The reviewer result alone is never enough.
      const reviewedDiff = await this.options.git.diffFrom(baseCommit, this.gitOptions());
      const reviewedDiffSha256 = sha256(reviewedDiff);
      phaseState.reviewed_diff_sha256 = reviewedDiffSha256;
      await this.save();
      const beforeFinalAcceptanceReports = await this.captureReportHashes(phase);
      const beforeFinalAcceptanceSnapshot = await this.options.git.snapshot(this.gitOptions());
      const finalAcceptance = await runAcceptance(phase.acceptance, this.options.acceptanceRunner, this.acceptanceOptions());
      const afterFinalAcceptanceSnapshot = await this.options.git.snapshot(this.gitOptions());
      await this.assertNoHistoryOrIndexMutation(beforeFinalAcceptanceSnapshot, "Final deterministic acceptance");
      await this.assertReportHashes(beforeFinalAcceptanceReports, "Final deterministic acceptance");
      if (!deliverableSnapshotsEqual(beforeFinalAcceptanceSnapshot, afterFinalAcceptanceSnapshot)) {
        throw new WorkflowPauseError(
          "ACCEPTANCE_CHANGED_REVIEWED_WORKSPACE",
          "Final deterministic acceptance changed deliverable bytes after Reviewer PASS; no commit was created.",
        );
      }
      await this.assertCompletedEvidence();
      const acceptanceReportSha256 = await this.writeAcceptanceResults(phase, round, finalAcceptance);
      await this.save();
      await this.assertPackageUnchanged();
      await this.assertBase(baseCommit);
      await this.options.git.assertNoCachedChanges(this.gitOptions());
      const finalOutOfScope = await this.assertScope(phase);
      if (!requiredAcceptancePassed(finalAcceptance) || finalOutOfScope.length > 0) {
        feedback = this.feedbackForExecution(execution, finalAcceptance, finalOutOfScope, review);
        const repeatPause = await this.acceptanceRepeatPause(phase, finalAcceptance, round);
        if (repeatPause) return repeatPause;
        if (round >= this.maxReviewRounds) {
          return this.pause(phase, { code: "MAX_REVIEW_ROUNDS", stage: "acceptance", summary: `Acceptance failed after reviewer PASS on round ${round}.` });
        }
        continue;
      }

      const changed = await this.options.git.changedPaths(this.gitOptions());
      const finalDiff = await this.options.git.diffFrom(baseCommit, this.gitOptions());
      const finalDiffRelative = finalDiffPath(phase.phase.id);
      const finalDiffHash = sha256(finalDiff);
      if (finalDiffHash !== reviewedDiffSha256) {
        throw new WorkflowPauseError(
          "ACCEPTANCE_CHANGED_REVIEWED_WORKSPACE",
          "Final phase diff differs from the diff approved by Reviewer; no commit was created.",
        );
      }
      await writeTextExclusive(join(this.options.package.root, ...finalDiffRelative.split("/")), finalDiff);
      const executionReportPath = phaseState.execution_report_path ?? safePhaseReportPath(phase.phase.id, round, "execution");
      const reviewReportPath = phaseState.review_report_path ?? safePhaseReportPath(phase.phase.id, round, "review");
      const acceptanceReportPath = phaseState.acceptance_report_path ?? safePhaseReportPath(phase.phase.id, round, "acceptance");
      const executionReportBytes = await readFile(join(this.options.package.root, ...executionReportPath.split("/")));
      const reviewReportBytes = await readFile(join(this.options.package.root, ...reviewReportPath.split("/")));
      const acceptanceReportBytes = await readFile(join(this.options.package.root, ...acceptanceReportPath.split("/")));
      if (
        sha256Bytes(executionReportBytes) !== executionReportSha256 ||
        sha256Bytes(reviewReportBytes) !== reviewReportSha256 ||
        sha256Bytes(acceptanceReportBytes) !== acceptanceReportSha256
      ) {
        throw new WorkflowPauseError("REPORT_CHANGED", "Completion report bytes changed before the immutable commit anchor was created.");
      }
      const committedAt = new Date().toISOString();
      const completionPayload: Omit<PhaseCompletionRecord, "phase_commit_sha"> = {
        version: 1,
        phase_id: phase.phase.id,
        base_commit_sha: baseCommit,
        committed_at: committedAt,
        review_rounds: round,
        acceptance_results: finalAcceptance,
        execution_report_path: executionReportPath,
        execution_report_sha256: sha256Bytes(executionReportBytes),
        review_report_path: reviewReportPath,
        review_report_sha256: sha256Bytes(reviewReportBytes),
        acceptance_report_path: acceptanceReportPath,
        acceptance_report_sha256: sha256Bytes(acceptanceReportBytes),
        final_diff_path: finalDiffRelative,
        final_diff_sha256: finalDiffHash,
        reviewed_diff_sha256: reviewedDiffSha256,
        package_hash: this.state.package_hash,
      };
      const evidence: PhaseEvidenceHashes = {
        execution_report_sha256: completionPayload.execution_report_sha256,
        review_report_sha256: completionPayload.review_report_sha256,
        acceptance_report_sha256: completionPayload.acceptance_report_sha256,
        final_diff_sha256: finalDiffHash,
        reviewed_diff_sha256: reviewedDiffSha256,
        completion_payload_sha256: phaseCompletionPayloadSha256(completionPayload),
      };
      let phaseCommit: string;
      try {
        phaseCommit = await this.options.git.commitPhase(
          baseCommit,
          changed,
          phaseCommitMessage(phase.phase.commit.message, evidence),
          phase.acceptance.commit.allow_empty,
          { ...this.gitOptions(), expectedDiffSha256: reviewedDiffSha256 },
        );
      } catch (error) {
        if (error instanceof GitPolicyError) throw new WorkflowPauseError(error.code, error.message);
        throw error;
      }
      try {
        await this.options.git.verifyPhaseCommit(
          phaseCommit,
          baseCommit,
          phase.phase.commit.message,
          finalDiffHash,
          this.gitOptions(),
          evidence,
        );
      } catch (error) {
        if (error instanceof GitPolicyError) throw new WorkflowPauseError(error.code, error.message);
        throw error;
      }
      const record: PhaseCompletionRecord = {
        ...completionPayload,
        phase_commit_sha: phaseCommit,
      };
      const recordText = `${JSON.stringify(record, null, 2)}\n`;
      phaseState.phase_commit_sha = phaseCommit;
      phaseState.committed_at = committedAt;
      phaseState.execution_report_path = executionReportPath;
      phaseState.review_report_path = reviewReportPath;
      phaseState.acceptance_report_path = acceptanceReportPath;
      phaseState.final_diff_path = finalDiffRelative;
      phaseState.final_diff_sha256 = finalDiffHash;
      phaseState.reviewed_diff_sha256 = reviewedDiffSha256;
      phaseState.completion_record_path = completionRecordPath(phase.phase.id);
      phaseState.completion_record_sha256 = sha256(recordText);
      await writeJsonExclusive(join(this.options.package.root, ...phaseState.completion_record_path.split("/")), record);
      phaseState.status = "completed";
      phaseState.review_rounds = round;
      phaseState.unresolved_findings = [];
      delete phaseState.last_error;
      await this.save();
      this.emit({
        phase_id: phase.phase.id,
        round,
        executor_status: "complete",
        reviewer_status: "pass",
        message: `Phase committed at ${phaseCommit}.`,
        plan: this.planSnapshot(),
      });
      return undefined;
    }

    return this.pause(phase, { code: "MAX_REVIEW_ROUNDS", stage: "reviewer", summary: `Phase reached max_review_rounds=${this.maxReviewRounds}.` });
  }

  async run(): Promise<StageBRunResult> {
    if (this.state.status === "draft") {
      return {
        status: "not_started",
        state: this.state,
        reason: "Human approval is required before Execution & Review; draft planning never starts Executor or Reviewer sessions.",
      };
    }
    if (
      (this.state.status === "paused" && this.options.resumePaused !== true) ||
      this.state.status === "completed" ||
      this.state.status === "cancelled"
    ) {
      return this.state.status === "completed"
        ? { status: "completed", state: this.state }
        : this.state.pause_reason
          ? { status: "paused", state: this.state, reason: this.state.pause_reason }
          : { status: "paused", state: this.state };
    }
    let currentPhase: PhasePackage | undefined;
    try {
      this.state.status = "running";
      this.state.started_at ??= new Date().toISOString();
      delete this.state.pause_reason;
      delete this.state.pause;
      await this.save();
      if (this.options.requireDedicatedWorktree !== false) await this.options.git.assertDedicatedIdentity();
      await this.assertPackageUnchanged();
      for (const phase of this.options.package.phases) {
        currentPhase = phase;
        const result = await this.phase(phase);
        if (result) return result;
      }
      await this.assertCompletedEvidence();
      this.state.status = "completed";
      this.state.completed_at = new Date().toISOString();
      await this.save();
      return { status: "completed", state: this.state };
    } catch (error) {
      if (this.options.signal?.aborted) return this.pause(currentPhase, this.abortPause("unknown", "Execution & Review was cancelled."));
      if (error instanceof WorkflowPauseError) return this.pause(currentPhase, { code: error.code, stage: "unknown", summary: error.message });
      if (error instanceof GitPolicyError) return this.pause(currentPhase, { code: error.code, stage: "unknown", summary: error.message });
      const message = error instanceof Error ? error.message : String(error);
      return this.pause(currentPhase, { code: "STAGE_B_ERROR", stage: "unknown", summary: message });
    }
  }
}

export class WorkflowPauseError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkflowPauseError";
    this.code = code;
  }
}
