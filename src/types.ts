/** Public data contracts for pi-plan-execute-auto. */

export const WORKFLOW_VERSION = 1 as const;
export const DEFAULT_MAX_REVIEW_ROUNDS = 5;
export const RUNTIME_DIRECTORY = ".runtime";
export const STATE_FILE = ".state.json";
export const MANIFEST_FILE = "manifest.yaml";

export type WorkflowStatus =
  | "draft"
  | "frozen"
  | "running"
  | "paused"
  | "completed"
  | "cancelled";

export interface DocumentReference {
  id: string;
  path: string;
  purpose: string;
}

export interface CommitContract {
  required: true;
  message: string;
}

export interface PhaseReference {
  id: string;
  order: number;
  spec: string;
  acceptance: string;
  commit: CommitContract;
}

export interface Manifest {
  version: 1;
  documents: DocumentReference[];
  phases: PhaseReference[];
  max_review_rounds?: number;
}

export interface AcceptanceSelfTest {
  id: string;
  command: string;
  required: boolean;
  /**
   * Optional per-test wall-clock budget. Overrides the plugin-wide acceptance timeout so a
   * legitimately slow gate (for example a race-enabled suite) cannot be killed by a default
   * that was sized for fast unit commands.
   */
  timeout_ms?: number;
  /**
   * Optional environment requirements probed inside the real acceptance sandbox before the
   * first executor round. Each entry is either a command name resolved through the sandbox
   * PATH (`go`) or a repository-relative/absolute executable path (`./.cache/toolchain/bin/go`).
   */
  requires?: string[];
}

export interface AcceptanceContract {
  version: 1;
  phase_id: string;
  scope: {
    allowed_paths: string[];
  };
  self_tests: AcceptanceSelfTest[];
  review: {
    require_no_blocking_findings: true;
  };
  commit: {
    required: true;
    allow_empty: boolean;
  };
}

export interface PackageFileInput {
  path: string;
  content: string;
}

export interface FinalizeInput {
  run_id?: string;
  manifest: Manifest;
  files: PackageFileInput[];
  approval?: "ask" | "approve" | "cancel";
  start_stage_b?: boolean;
  executor_model?: string;
  reviewer_model?: string;
}

export interface PackageValidationIssue {
  code: string;
  path: string;
  message: string;
}

export interface PhasePackage {
  phase: PhaseReference;
  spec: string;
  acceptance: AcceptanceContract;
}

export interface ValidatedPackage {
  root: string;
  manifest: Manifest;
  phases: PhasePackage[];
  package_hash: string;
  golden_files: string[];
}

export interface ExecutionSelfTestEvidence {
  id: string;
  command: string;
  status: "passed" | "failed" | "skipped";
  output?: string;
}

export interface ExecutionReport {
  phase_id: string;
  round: number;
  base_commit: string;
  status: "complete" | "blocked" | "failed";
  summary: string;
  changed_files: string[];
  self_tests: ExecutionSelfTestEvidence[];
  resolved_findings: string[];
  known_issues: string[];
  executor_session_id?: string;
}

export type ReviewVerdict = "PASS" | "REWORK";

export interface ReviewFinding {
  id: string;
  severity: string;
  summary: string;
  evidence: string;
  blocking: boolean;
}

export interface ReviewReport {
  phase_id: string;
  round: number;
  base_commit: string;
  verdict: ReviewVerdict;
  summary: string;
  findings: ReviewFinding[];
  evidence: string[];
  acceptance_assessment: string;
  out_of_scope_changes: string[];
  reviewer_session_id?: string;
}

export interface AcceptanceResult {
  id: string;
  command: string;
  required: boolean;
  exit_code: number | null;
  passed: boolean;
  stdout: string;
  stderr: string;
  /** True when the command exceeded its budget; distinguishes a timeout from a crash or signal. */
  timed_out?: boolean;
  /** Effective budget applied to this command, so a timeout report is self-explanatory. */
  timeout_ms?: number;
}

export interface PhaseCompletionRecord {
  version: 1;
  phase_id: string;
  base_commit_sha: string;
  phase_commit_sha: string;
  committed_at: string;
  review_rounds: number;
  acceptance_results: AcceptanceResult[];
  execution_report_path: string;
  execution_report_sha256: string;
  review_report_path: string;
  review_report_sha256: string;
  acceptance_report_path: string;
  acceptance_report_sha256: string;
  final_diff_path: string;
  final_diff_sha256: string;
  reviewed_diff_sha256: string;
  package_hash: string;
}

export interface PhaseState {
  phase_id: string;
  status: "pending" | "running" | "paused" | "completed";
  base_commit_sha?: string;
  phase_commit_sha?: string;
  committed_at?: string;
  review_rounds: number;
  execution_report_path?: string;
  execution_report_paths: string[];
  review_report_path?: string;
  review_report_paths: string[];
  acceptance_report_path?: string;
  acceptance_results?: AcceptanceResult[];
  unresolved_findings: ReviewFinding[];
  executor_session_id?: string;
  reviewer_session_id?: string;
  final_diff_path?: string;
  final_diff_sha256?: string;
  reviewed_diff_sha256?: string;
  completion_record_path?: string;
  completion_record_sha256?: string;
  last_error?: string;
}

/**
 * Reasoning label advertised by an ACP backend.
 *
 * Deliberately an open label rather than a closed union: Codex advertises
 * `low / medium / high / xhigh / max` (some builds also `ultra`), and a hardcoded list silently
 * dropped the deeper levels from setup and rejected them when resuming. The backend catalog is
 * authoritative; the plugin only enforces a safe label shape and presence in that catalog.
 */
export type ReasoningEffort = string;

/** Safe label shape for a backend-advertised reasoning level. */
export const REASONING_EFFORT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u;

export function isValidReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && REASONING_EFFORT_PATTERN.test(value);
}

/** Display order for known levels; unknown advertised labels keep a stable lexical position. */
const REASONING_EFFORT_RANK = new Map(
  ["off", "none", "disabled", "default", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
    .map((label, index) => [label, index] as const),
);

/** Deduplicate advertised levels and order them from cheapest to deepest for the setup dialog. */
export function orderReasoningEfforts(advertised: readonly string[]): ReasoningEffort[] {
  const unique = [...new Set(advertised.filter((label) => isValidReasoningEffort(label)))];
  return unique.sort((left, right) => {
    const leftRank = REASONING_EFFORT_RANK.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = REASONING_EFFORT_RANK.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftRank === rightRank ? left.localeCompare(right) : leftRank - rightRank;
  });
}
export type AgentPermissionMode = "autonomous" | "ask";

/** Whole-run Execution & Review budget. `0` means no timeout. */
export const DEFAULT_STAGE_TIMEOUT_MS = 30 * 60 * 1000;
export const MIN_STAGE_TIMEOUT_MS = 60 * 1000;
export const MAX_STAGE_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export function isValidStageTimeoutMs(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) &&
    (value === 0 || (value >= MIN_STAGE_TIMEOUT_MS && value <= MAX_STAGE_TIMEOUT_MS));
}

/** Structured, resumability-aware classification of why a run is paused. */
export type PauseCode = KnownPauseCode | (string & {});
export type KnownPauseCode =
  | "ABORTED" | "TIMEOUT" | "HUMAN_STOP" | "SESSION_ABORT"
  | "HARNESS_ERROR" | "STAGE_B_ERROR" | "PROCESS_RESTART" | "PROCESS_RESTART_RECONCILED"
  | "PROCESS_RESTART_EVIDENCE" | "STARTUP_EVIDENCE" | "WORKTREE_IDENTITY_MISMATCH"
  | "COMPLETION_GIT_EVIDENCE" | "WORKTREE_SETUP" | "EXECUTION_UNHANDLED"
  | "MAX_REVIEW_ROUNDS" | "ACCEPTANCE_FAILED"
  | "ACCEPTANCE_ENVIRONMENT_MISSING" | "ACCEPTANCE_BLOCKED_REPEAT"
  | "WORKSPACE_SYMLINK_ESCAPE" | "EVIDENCE_REPAIRED";
export type PauseStage =
  | "executor" | "reviewer" | "acceptance" | "commit" | "phase" | "setup" | "preflight" | "unknown";

/** Typed abort reason shared between the Stage B watchdog and the ACP harness signal. */
export type StageBAbortKind = "timeout" | "human_stop" | "session_abort";
export interface StageBAbortReason {
  kind: StageBAbortKind;
  message: string;
  timeoutMs?: number;
  elapsedMs?: number;
}

export interface PauseRecord {
  code: PauseCode;
  /** Human-facing one-line cause. */
  summary: string;
  /** Raw signal/error text when it adds information beyond the summary. */
  detail?: string;
  stage: PauseStage;
  resumable: boolean;
  phase_id?: string;
  round?: number;
  timeout_ms?: number;
  elapsed_ms?: number;
  at: string;
}

export interface PauseInput {
  code: PauseCode;
  summary: string;
  detail?: string;
  stage?: PauseStage;
  resumable?: boolean;
  phase_id?: string;
  round?: number;
  timeout_ms?: number;
  elapsed_ms?: number;
}

export interface WorkflowState {
  version: 1;
  run_id: string;
  package_hash: string;
  package_dir: string;
  status: WorkflowStatus;
  created_at: string;
  /** Human-visible draft revision number; starts at 1 and increments on every accepted plan rewrite. */
  plan_revision?: number;
  approved_at?: string;
  started_at?: string;
  completed_at?: string;
  executor_model?: string;
  reviewer_model?: string;
  /** Legacy shared effort for runs frozen before per-role selection. */
  reasoning_effort?: ReasoningEffort;
  executor_reasoning_effort?: ReasoningEffort;
  reviewer_reasoning_effort?: ReasoningEffort;
  permission_mode?: AgentPermissionMode;
  review_round_limit?: number;
  branch_name?: string;
  worktree_path?: string;
  /** Exact disposable dependency roots provisioned for this run; never a basename wildcard. */
  controlled_environment_paths?: string[];
  phases: PhaseState[];
  pause_reason?: string | undefined;
  /** Structured pause cause; `pause_reason` stays as the legacy human string. */
  pause?: PauseRecord | undefined;
  /** Effective whole-run Stage B budget for this run; `0` means no timeout. */
  stage_timeout_ms?: number | undefined;
}

export interface WorkflowStatusSnapshot {
  run_id: string;
  status: WorkflowStatus;
  package_dir: string;
  package_hash: string;
  branch_name?: string | undefined;
  worktree_path?: string | undefined;
  current_phase?: string | undefined;
  completed_phases: number;
  total_phases: number;
  pause_reason?: string | undefined;
}

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
  /** True only when the process was killed because its own budget expired. */
  timed_out?: boolean;
}

export interface GitOperations {
  run(args: string[], options?: { signal?: AbortSignal | undefined; timeout?: number | undefined; cwd?: string | undefined }): Promise<GitCommandResult>;
}

export interface AcceptanceCommandRunner {
  run(command: string, options?: { signal?: AbortSignal | undefined; timeout?: number | undefined }): Promise<GitCommandResult>;
}

export interface HarnessPair {
  /** Open/configure both roles without sending a model turn. Called on every start/resume. */
  preflight?(options?: { signal?: AbortSignal | undefined }): Promise<void>;
  execute(
    prompt: string,
    round: number,
    options?: { signal?: AbortSignal | undefined; phaseBaseCommit?: string | undefined },
  ): Promise<ExecutionReport>;
  rework(
    prompt: string,
    round: number,
    options?: { signal?: AbortSignal | undefined; phaseBaseCommit?: string | undefined },
  ): Promise<ExecutionReport>;
  review(
    prompt: string,
    round: number,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<ReviewReport>;
  close(): Promise<void>;
}

export interface StageBPlanSnapshot {
  /** Ordered phase ids exactly as the frozen manifest declares them. */
  phase_ids: string[];
  phase_statuses: PhaseRuntimeStatus[];
  /** 0-based index of the first incomplete phase; -1 when every phase is completed. */
  current_index: number;
  review_round_limit: number;
}

export type PhaseRuntimeStatus = "pending" | "running" | "paused" | "completed";

export interface StageBStatusEvent {
  phase_id: string;
  round: number;
  executor_status: "pending" | "running" | "complete" | "failed" | "interrupted";
  reviewer_status: "pending" | "running" | "pass" | "rework" | "failed" | "interrupted";
  message: string;
  /** Present on the terminal pause event so the timeline carries the structured cause. */
  pause?: PauseRecord;
  /** Live plan progress; absent only in older persisted/test events. */
  plan?: StageBPlanSnapshot;
}

export interface StageBRunResult {
  status: "completed" | "paused" | "aborted" | "not_started";
  state: WorkflowState;
  reason?: string | undefined;
  pause?: PauseRecord | undefined;
}

