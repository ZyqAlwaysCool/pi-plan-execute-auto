import { dirname, join, resolve } from "node:path";
import {
  assertSafeRunId,
  readWorkflowState,
  validatePackageDirectory,
  writeWorkflowState,
} from "./package-validator.js";
import { completionRecordRelativePath, validatePhaseCompletionRecord } from "./completion.js";
import { createLocalGitOperations, GitWorkspace, phaseEvidenceHashesForRecord } from "./git.js";
import {
  type PhaseState,
  type ValidatedPackage,
  type WorkflowState,
  type WorkflowStatusSnapshot,
  WORKFLOW_VERSION,
} from "./types.js";

export function packageRoot(cwd: string, runId: string): string {
  assertSafeRunId(runId);
  return resolve(cwd, ".pi-plan-execute-auto", runId);
}

export function initialPhaseStates(pkg: ValidatedPackage): PhaseState[] {
  return pkg.phases.map((phase) => ({
    phase_id: phase.phase.id,
    status: "pending",
    review_rounds: 0,
    execution_report_paths: [],
    review_report_paths: [],
    unresolved_findings: [],
  }));
}

export function createDraftState(pkg: ValidatedPackage, runId: string): WorkflowState {
  return {
    version: WORKFLOW_VERSION,
    run_id: runId,
    package_hash: pkg.package_hash,
    package_dir: pkg.root,
    status: "draft",
    created_at: new Date().toISOString(),
    phases: initialPhaseStates(pkg),
  };
}

export async function loadValidatedRun(
  cwd: string,
  runId: string,
): Promise<{ package: ValidatedPackage; state: WorkflowState }> {
  const root = packageRoot(cwd, runId);
  const validation = await validatePackageDirectory(root);
  if (!validation.ok || !validation.package) {
    throw new Error(
      `Document package ${runId} is invalid:\n${validation.errors
        .map((entry) => `[${entry.code}] ${entry.path}: ${entry.message}`)
        .join("\n")}`,
    );
  }
  const state = await readWorkflowState(root);
  if (!state) throw new Error(`Workflow ${runId} has no valid ${root}/.state.json; it has not been approved.`);
  if (state.run_id !== runId || resolve(state.package_dir) !== resolve(root)) {
    throw new Error(`Workflow ${runId} state identity does not match its package root.`);
  }
  if (state.package_hash !== validation.package.package_hash) {
    throw new Error(`Workflow ${runId} package hash does not match its frozen state.`);
  }
  if (state.reasoning_effort !== undefined && !["low", "medium", "high", "max"].includes(state.reasoning_effort)) {
    throw new Error(`Workflow ${runId} has an unsupported persisted reasoning effort.`);
  }
  assertSafeRunId(state.run_id);
  const expectedPhaseIds = validation.package.phases.map((phase) => phase.phase.id);
  const actualPhaseIds = state.phases.map((phase) => phase.phase_id);
  if (expectedPhaseIds.length !== actualPhaseIds.length || expectedPhaseIds.some((id, index) => id !== actualPhaseIds[index])) {
    throw new Error(`Workflow ${runId} state phase structure does not match its frozen manifest.`);
  }
  const firstIncomplete = state.phases.findIndex((phase) => phase.status !== "completed");
  if (state.phases.some((phase, index) => phase.status === "completed" && firstIncomplete >= 0 && index > firstIncomplete)) {
    throw new Error(`Workflow ${runId} has a completed phase after an incomplete phase.`);
  }
  if (state.status === "completed") {
    if (state.phases.some((phase) => phase.status !== "completed") || !state.completed_at || !Number.isFinite(Date.parse(state.completed_at))) {
      throw new Error(`Workflow ${runId} is marked completed without completing every phase.`);
    }
  }
  if ((state.status === "draft" || state.status === "cancelled") && state.phases.some((phase) => phase.status === "completed")) {
    throw new Error(`Workflow ${runId} has completion evidence in ${state.status} state.`);
  }
  let completionGit: GitWorkspace | undefined;
  let previousCompletionCommit: string | undefined;
  for (const phase of state.phases) {
    if (phase.status === "completed" && (!phase.base_commit_sha || !phase.phase_commit_sha)) {
      throw new Error(`Workflow ${runId} has an incomplete completion record for ${phase.phase_id}.`);
    }
    if (phase.status === "completed") {
      if (!phase.completion_record_sha256) {
        throw new Error(`Workflow ${runId} has no completion record hash for ${phase.phase_id}.`);
      }
      const phasePackage = validation.package.phases.find((entry) => entry.phase.id === phase.phase_id);
      if (!phasePackage) throw new Error(`Workflow ${runId} completion phase is not in the frozen package: ${phase.phase_id}.`);
      if (phase.completion_record_path !== completionRecordRelativePath(phase.phase_id)) {
        throw new Error(`Workflow ${runId} has a non-canonical completion record path for ${phase.phase_id}.`);
      }
      try {
        const evidence = await validatePhaseCompletionRecord(root, phase.phase_id, state.package_hash, {
          ...(phase.base_commit_sha ? { base_commit_sha: phase.base_commit_sha } : {}),
          ...(phase.phase_commit_sha ? { phase_commit_sha: phase.phase_commit_sha } : {}),
          completion_record_sha256: phase.completion_record_sha256,
          ...(phase.reviewed_diff_sha256 ? { reviewed_diff_sha256: phase.reviewed_diff_sha256 } : {}),
        }, phasePackage.acceptance);
        if (!completionGit) {
          const expectedWorktreePath = resolve(dirname(cwd), ".pi-plan-execute-auto-worktrees", runId);
          if (state.worktree_path && state.worktree_path !== expectedWorktreePath) {
            throw new Error(`Workflow ${runId} has a non-run-scoped worktree path.`);
          }
          if (state.worktree_path && state.branch_name !== `pi-plan-execute-auto/${runId}`) {
            throw new Error(`Workflow ${runId} has a non-run-scoped branch name.`);
          }
          const gitRoot = state.worktree_path ?? cwd;
          completionGit = new GitWorkspace(createLocalGitOperations(gitRoot), { cwd: gitRoot });
        }
        if (previousCompletionCommit && evidence.record.base_commit_sha !== previousCompletionCommit) {
          throw new Error(`Workflow ${runId} completion commit chain is broken before ${phase.phase_id}.`);
        }
        await completionGit.verifyPhaseCommit(
          evidence.record.phase_commit_sha,
          evidence.record.base_commit_sha,
          phasePackage.phase.commit.message,
          evidence.record.final_diff_sha256,
          undefined,
          phaseEvidenceHashesForRecord(evidence.record),
        );
        previousCompletionCommit = evidence.record.phase_commit_sha;
        if (
          phase.review_rounds !== evidence.record.review_rounds ||
          phase.committed_at !== evidence.record.committed_at ||
          JSON.stringify(phase.acceptance_results ?? []) !== JSON.stringify(evidence.record.acceptance_results) ||
          phase.final_diff_path !== evidence.record.final_diff_path ||
          phase.final_diff_sha256 !== evidence.record.final_diff_sha256 ||
          phase.reviewed_diff_sha256 !== evidence.record.reviewed_diff_sha256 ||
          phase.execution_report_path !== evidence.record.execution_report_path ||
          phase.review_report_path !== evidence.record.review_report_path ||
          phase.acceptance_report_path !== evidence.record.acceptance_report_path
        ) throw new Error("workflow phase state does not match completion record");
      } catch (error) {
        throw new Error(`Workflow ${runId} has no valid immutable completion record for ${phase.phase_id}: ${String(error)}`);
      }
    }
  }
  if (state.status === "completed" && completionGit && previousCompletionCommit) {
    const head = await completionGit.head();
    if (head !== previousCompletionCommit) {
      throw new Error(`Workflow ${runId} HEAD ${head} does not equal its final completion commit ${previousCompletionCommit}.`);
    }
  }
  return { package: validation.package, state };
}

export async function freezeRun(
  pkg: ValidatedPackage,
  runId: string,
  options?: { executorModel?: string; reviewerModel?: string; reasoningEffort?: WorkflowState["reasoning_effort"]; reviewedPackageHash?: string },
): Promise<WorkflowState> {
  const root = pkg.root;
  const current = await readWorkflowState(root);
  if (current && current.status !== "draft") {
    throw new Error(`Workflow ${runId} is already ${current.status}; frozen packages cannot be approved again.`);
  }
  if (!options?.reviewedPackageHash) {
    throw new Error("Human freeze requires the exact package hash that was reviewed.");
  }
  if (current?.package_hash !== options.reviewedPackageHash) {
    throw new Error("The package changed after review; it must be reviewed again before freeze.");
  }
  const validation = await validatePackageDirectory(root);
  if (!validation.ok || !validation.package) throw new Error("Package became invalid before freeze.");
  if (validation.package.package_hash !== options.reviewedPackageHash || validation.package.package_hash !== current.package_hash) {
    throw new Error("The package hash changed after review; it remains draft and requires a new review.");
  }
  const state = createDraftState(validation.package, runId);
  state.status = "frozen";
  state.approved_at = new Date().toISOString();
  if (options?.executorModel) state.executor_model = options.executorModel;
  if (options?.reviewerModel) state.reviewer_model = options.reviewerModel;
  if (options?.reasoningEffort) state.reasoning_effort = options.reasoningEffort;
  await writeWorkflowState(root, state);
  return state;
}

export async function cancelRun(pkg: ValidatedPackage, runId: string): Promise<WorkflowState> {
  const current = await readWorkflowState(pkg.root);
  if (current && current.status !== "draft") {
    throw new Error(`Workflow ${runId} cannot be cancelled from status ${current.status}.`);
  }
  const state = current ?? createDraftState(pkg, runId);
  state.status = "cancelled";
  await writeWorkflowState(pkg.root, state);
  return state;
}

export async function readRunStatus(cwd: string, runId: string): Promise<WorkflowStatusSnapshot | undefined> {
  const root = packageRoot(cwd, runId);
  const validation = await validatePackageDirectory(root);
  if (!validation.ok || !validation.package) return undefined;
  const state = await readWorkflowState(root);
  if (!state) return undefined;
  const loaded = await loadValidatedRun(cwd, runId);
  const validatedState = loaded.state;
  const current = validatedState.phases.find((phase) => phase.status !== "completed");
  return {
    run_id: validatedState.run_id,
    status: validatedState.status,
    package_dir: validatedState.package_dir,
    package_hash: validatedState.package_hash,
    ...(validatedState.branch_name ? { branch_name: validatedState.branch_name } : {}),
    ...(validatedState.worktree_path ? { worktree_path: validatedState.worktree_path } : {}),
    ...(current?.phase_id ? { current_phase: current.phase_id } : {}),
    completed_phases: validatedState.phases.filter((phase) => phase.status === "completed").length,
    total_phases: validatedState.phases.length,
    ...(validatedState.pause_reason ? { pause_reason: validatedState.pause_reason } : {}),
  };
}

export function formatStatus(status: WorkflowStatusSnapshot): string {
  return [
    `Run: ${status.run_id}`,
    `Status: ${status.status}`,
    `Progress: ${status.completed_phases}/${status.total_phases}`,
    `Current phase: ${status.current_phase ?? "none"}`,
    `Package: ${status.package_dir}`,
    `Golden hash: ${status.package_hash}`,
    ...(status.branch_name ? [`Branch: ${status.branch_name}`] : []),
    ...(status.worktree_path ? [`Worktree: ${status.worktree_path}`] : []),
    ...(status.pause_reason ? [`Pause reason: ${status.pause_reason}`] : []),
  ].join("\n");
}

export { join };
