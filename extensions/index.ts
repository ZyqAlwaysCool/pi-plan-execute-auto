import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import {
  formatValidationIssues,
  makeRunId,
  PackageInputError,
  PackageValidationError,
  readWorkflowState,
  replaceValidatedDraftPackage,
  validatePackageDirectory,
  writeValidatedPackage,
  writeWorkflowState,
} from "../src/package-validator.js";
import {
  cancelRun,
  createDraftState,
  freezeRun,
  loadValidatedRun,
  packageRoot,
  readRunStatus,
} from "../src/workflow-state.js";
import {
  CONTROLLED_ENVIRONMENT_PATHS,
  createPiGitOperations,
  ensureDedicatedWorktree,
  GitWorkspace,
  phaseEvidenceHashesForRecord,
  provisionDedicatedEnvironment,
} from "../src/git.js";
import { completionRecordRelativePath, validatePhaseCompletionRecord } from "../src/completion.js";
import { AgentPrismSessionPair, requireAcpNetworkRiskAcknowledgement } from "../src/agent-prism.js";
import {
  discoverAcpClis,
  inspectClaudeNativeSandbox,
  loadProjectPluginProfile,
  normalizeSelectedModel,
  probeAcpConfiguration,
  probeAcpModels,
  verifyAcpModelCall,
  saveProjectPluginProfile,
  type AcpBackend,
  type DetectedCli,
  type ProjectPluginProfile,
} from "../src/plugin-config.js";
import { defaultIsolationProvider } from "../src/isolation-provider.js";
import { supportedBackendForModel } from "../src/sandbox.js";
import { isPathAllowed } from "../src/glob.js";
import { ensureSetupRepository } from "../src/setup-repository.js";
import { agentSessionTranscriptRelativePath, appendRunEvent, captureMainPiSession } from "../src/run-log.js";
import { StageBController } from "../src/stage-b.js";
import { StageBActivityModel, StageBActivityWidget, formatPlanChecklist } from "../src/status-widget.js";
import {
  REPAIR_VERIFIED_CODE,
  createPauseRecord,
  formatPauseDetails,
  formatPauseHeadline,
  formatPauseReason,
  formatStageTimeout,
  isStageBAbortReason,
  parseStageTimeoutValue,
  pauseRepairable,
  pauseResumable,
  roundLimitResumeAllowed,
} from "../src/pause.js";
import {
  DEFAULT_MAX_REVIEW_ROUNDS,
  DEFAULT_STAGE_TIMEOUT_MS,
  MAX_STAGE_TIMEOUT_MS,
  MIN_STAGE_TIMEOUT_MS,
} from "../src/types.js";
import type {
  AcceptanceCommandRunner,
  AgentPermissionMode,
  FinalizeInput,
  Manifest,
  PauseRecord,
  ReasoningEffort,
  StageBAbortReason,
  StageBPlanSnapshot,
  StageBRunResult,
  StageBStatusEvent,
  WorkflowState,
} from "../src/types.js";

const WIDGET_KEY = "pi-plan-execute-auto";
const STATE_ENTRY = "plan-execute-state";
const PHASE_ENTRY = "plan-execute-phase";
const DEFAULT_ACCEPTANCE_TIMEOUT_MS = 120 * 1000;
/** Persist a timeline warning once this fraction of the whole-run budget is consumed. */
export const BUDGET_WARNING_RATIO = 0.8;
const REVIEW_ROUND_CHOICES = [3, 5, 8, 12, 20] as const;
/** Setup-stage whole-run Execution & Review budgets. `0` means no timeout. */
const STAGE_TIMEOUT_CHOICES = [
  { label: "5 minutes", ms: 5 * 60 * 1000 },
  { label: "15 minutes", ms: 15 * 60 * 1000 },
  { label: "30 minutes (recommended default)", ms: DEFAULT_STAGE_TIMEOUT_MS },
  { label: "Custom…", ms: -1 },
  { label: "No timeout — run until it finishes", ms: 0 },
] as const;

function validateControlledEnvironmentPaths(state: WorkflowState): void {
  const paths = state.controlled_environment_paths ?? [];
  if (paths.some((path) => !CONTROLLED_ENVIRONMENT_PATHS.some((allowed) => allowed === path))) {
    throw new Error("Workflow contains an unapproved provisioned environment path.");
  }
}

const FINALIZE_PROMPT_LINES = [
  "The user explicitly invoked /plan-execute.",
  "Use the complete current conversation and repository investigation context to call plan_execute_finalize.",
  "Create a Golden Document Package with at least one ordered phase. Every phase needs its own spec, acceptance YAML contract, and required completion commit.",
  "Do not implement code or approve/freeze the package on the user's behalf. The plugin will validate the draft, let the human request revisions repeatedly, and ask for approval.",
  "Do not supply executor_model or reviewer_model: only the human's /plan-execute setup selection owns the ACP routing.",
  "After plan_execute_finalize succeeds, end this Main Pi turn with only a brief handoff that the validated draft is ready and the plugin Review & Approval UI will open.",
  "Do not restate or summarize the draft plan after finalization, do not ask for approval in chat, and do not give Request Changes instructions in prose; the plugin UI is authoritative for review and approval.",
];

export function buildFinalizePrompt(directive?: string): string {
  const humanDirective = directive?.trim();
  if (!humanDirective) return FINALIZE_PROMPT_LINES.join("\n");
  return [
    ...FINALIZE_PROMPT_LINES,
    "",
    "The slash command included an explicit human directive for this invocation.",
    "Treat that directive as authoritative when resolving alternatives or choices discussed earlier in the conversation.",
    "Do not ask the human to repeat or reconfirm the directive merely because it was supplied as slash-command arguments; use the current conversation and repository context and finalize the draft now.",
    "Words such as execute, start, implement, or their equivalents inside this directive select the intended plan/scope only; they do NOT authorize bypassing the plugin's later Plan Review & Approval gate or starting Stage B.",
    "",
    "Human /plan-execute directive (verbatim):",
    humanDirective,
  ].join("\n");
}

export type PlanExecuteCommand =
  | { kind: "finalize"; directive?: string }
  | { kind: "setup" }
  | { kind: "settings"; runId?: string }
  | { kind: "start"; runId: string }
  | { kind: "resume"; runId: string }
  | { kind: "stop"; runId: string }
  | { kind: "status"; runId: string }
  | { kind: "usage" };

export function parsePlanExecuteCommand(args: string): PlanExecuteCommand {
  const trimmed = args.trim();
  if (!trimmed) return { kind: "finalize" };

  const tokens = trimmed.split(/\s+/u);
  const action = tokens[0] ?? "";
  if (action === "finalize") {
    const directive = trimmed.slice(action.length).trim();
    return directive ? { kind: "finalize", directive } : { kind: "finalize" };
  }
  if (action === "setup") return tokens.length === 1 ? { kind: "setup" } : { kind: "usage" };
  if (action === "settings") {
    if (tokens.length === 1) return { kind: "settings" };
    if (tokens.length === 2) return { kind: "settings", runId: tokens[1]! };
    return { kind: "usage" };
  }
  if (action === "start") return tokens.length === 2 ? { kind: "start", runId: tokens[1]! } : { kind: "usage" };
  if (action === "resume") return tokens.length === 2 ? { kind: "resume", runId: tokens[1]! } : { kind: "usage" };
  if (action === "stop") return tokens.length === 2 ? { kind: "stop", runId: tokens[1]! } : { kind: "usage" };
  if (action === "status") return tokens.length === 2 ? { kind: "status", runId: tokens[1]! } : { kind: "usage" };

  // Any non-reserved text is an explicit human directive for finalization.
  // This lets one command both select the plan and enter plan-execute, e.g.
  // /plan-execute 按方案B执行
  return { kind: "finalize", directive: trimmed };
}

const DOCUMENT_SCHEMA = Type.Object({
  id: Type.String({ minLength: 1 }),
  path: Type.String({ minLength: 1 }),
  purpose: Type.String({ minLength: 1 }),
});

const PHASE_SCHEMA = Type.Object({
  id: Type.String({ minLength: 1 }),
  order: Type.Integer({ minimum: 1 }),
  spec: Type.String({ minLength: 1 }),
  acceptance: Type.String({ minLength: 1 }),
  commit: Type.Object({
    required: Type.Boolean(),
    message: Type.String({ minLength: 1 }),
  }),
});

const MANIFEST_SCHEMA = Type.Object({
  version: Type.Integer(),
  documents: Type.Optional(Type.Array(DOCUMENT_SCHEMA)),
  phases: Type.Array(PHASE_SCHEMA, { minItems: 1 }),
  max_review_rounds: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

const FILE_SCHEMA = Type.Object({
  path: Type.String({ minLength: 1 }),
  content: Type.String(),
});

const FINALIZE_SCHEMA = Type.Object({
  manifest: MANIFEST_SCHEMA,
  files: Type.Array(FILE_SCHEMA),
  // Human approval is collected only by native UI or an explicit human command.
  approval: Type.Optional(Type.Union([Type.Literal("ask"), Type.Literal("cancel")])),
  executor_model: Type.Optional(Type.String({ minLength: 1 })),
  reviewer_model: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

type FinalizeParams = Static<typeof FINALIZE_SCHEMA>;

const REVISE_SCHEMA = Type.Object({
  run_id: Type.String({ minLength: 1, maxLength: 64 }),
  previous_package_hash: Type.String({ minLength: 64, maxLength: 64 }),
  manifest: MANIFEST_SCHEMA,
  files: Type.Array(FILE_SCHEMA),
}, { additionalProperties: false });

type ReviseParams = Static<typeof REVISE_SCHEMA>;

interface ActiveRun {
  controller: AbortController;
  startedAt: string;
}

const activeRuns = new Map<string, ActiveRun>();
const pendingHumanReviews = new Set<string>();

/** Stop key advertised in messages; registered as an extension shortcut too. */
export const STOP_SHORTCUT = "ctrl+shift+x";
export const STOP_SHORTCUT_LABEL = "Ctrl+Shift+X";

export function humanStopReason(): StageBAbortReason {
  return { kind: "human_stop", message: "Execution & Review stopped by human." };
}

/** Register a live Stage B run in this Pi process. */
export function trackActiveRun(runId: string, active: ActiveRun): void {
  activeRuns.set(runId, active);
}

export function untrackActiveRun(runId: string): void {
  activeRuns.delete(runId);
}

export function activeRunIds(): string[] {
  return [...activeRuns.keys()];
}

/** Abort one active run; `false` when this process has no live session for the id. */
export function requestRunStop(runId: string, reason: StageBAbortReason): boolean {
  const active = activeRuns.get(runId);
  if (!active) return false;
  active.controller.abort(reason);
  return true;
}

/** Abort every active run and return the affected run ids (stop shortcut and session shutdown). */
export function stopAllActiveRuns(reason: StageBAbortReason): string[] {
  const stopped = activeRunIds();
  for (const runId of stopped) requestRunStop(runId, reason);
  return stopped;
}

/**
 * Launch Stage B without blocking Pi's interactive input loop.
 *
 * Pi's main loop awaits a typed command handler; a handler that awaits the whole
 * run makes every later input (chat or `/plan-execute stop`) wait until the run
 * ends. Detaching keeps `/plan-execute stop` and the stop shortcut usable while
 * the run is live; results are reported through `notify` instead of the return
 * value.
 */
export function startStageBInBackground(options: {
  start: () => Promise<StartResult>;
  notify: (message: string, type: "info" | "warning" | "error") => void;
  notStarted?: (reason: string | undefined) => string;
  completed?: (result: StageBRunResult) => string;
}): void {
  void options.start().then((result) => {
    if (result.status === "not_started") {
      options.notify(options.notStarted?.(result.reason) ?? (result.reason ?? "Execution & Review did not start."), "warning");
      return;
    }
    if (result.status === "paused") return; // persistAndEscalatePause already reported the cause
    if (result.status !== "completed") {
      options.notify(`Execution & Review ${result.status}.`, "warning");
      return;
    }
    const state = result.state;
    const completed = state.phases.filter((phase) => phase.status === "completed").length;
    const branch = state.branch_name ? ` · branch ${state.branch_name}` : "";
    options.notify(
      options.completed?.(result as StageBRunResult) ?? `Execution & Review completed · ${state.run_id} · ${completed}/${state.phases.length} phases${branch}.`,
      "info",
    );
  }).catch((error) => {
    options.notify(error instanceof Error ? error.message : String(error), "error");
  });
}

function textResult(text: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function showWidget(ctx: ExtensionContext, lines: string[]): void {
  if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, lines);
}

function clearWidget(ctx: ExtensionContext): void {
  if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
}

/**
 * Terminal runs must not pin a widget in the Main Pi session: after a completed/cancelled run the
 * user keeps chatting and may start another plan. Paused and running states stay visible because
 * they are actionable. The completion summary is reported through notify/transcript entries instead.
 */
export function presentRunState(ctx: ExtensionContext, state: WorkflowState): void {
  if (state.status === "completed" || state.status === "cancelled") {
    clearWidget(ctx);
    return;
  }
  showWidget(ctx, stateLines(state));
}

function stateLines(state: WorkflowState): string[] {
  const completed = state.phases.filter((phase) => phase.status === "completed").length;
  const pause = state.status === "paused" ? state.pause : undefined;
  const plan: StageBPlanSnapshot = {
    phase_ids: state.phases.map((phase) => phase.phase_id),
    phase_statuses: state.phases.map((phase) => phase.status),
    current_index: state.phases.findIndex((phase) => phase.status !== "completed"),
    review_round_limit: state.review_round_limit ?? DEFAULT_MAX_REVIEW_ROUNDS,
  };
  const currentRound = plan.current_index >= 0
    ? Math.min((state.phases[plan.current_index]?.review_rounds ?? 0) + 1, plan.review_round_limit)
    : undefined;
  const pauseResumable = pause ? evaluateResumeEligibility(state, { allowOrphanedRunning: true }).ok : false;
  return [
    `Execution & Review · ${state.run_id} · ${state.status} · ${completed}/${state.phases.length} phases` +
      (state.stage_timeout_ms !== undefined ? ` · timeout ${formatStageTimeout(state.stage_timeout_ms)}` : ""),
    `  ${formatPlanChecklist(plan, 240, currentRound !== undefined ? { round: currentRound } : {})}`,
    ...(pause
      ? [
          formatPauseHeadline(pause, pauseResumable ? { resumable: true } : undefined),
          ...(pauseResumable
            ? [`Resume: /plan-execute resume ${state.run_id}`]
            : ["Resume is refused; repair the reported evidence first."]),
        ]
      : state.status === "paused"
        ? ["Needs attention · details saved in the run .runtime directory"]
        : []),
  ];
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message, type);
}

async function packageReviewText(
  pkg: Awaited<ReturnType<typeof loadValidatedRun>>["package"],
  revision?: number,
): Promise<string> {
  const chunks = [
    "# Draft Plan Review",
    ...(revision ? [`Revision: ${revision}`] : []),
    `Golden hash candidate: ${pkg.package_hash}`,
    "",
    "## Manifest",
    JSON.stringify(pkg.manifest, null, 2),
  ];
  for (const relative of pkg.golden_files) {
    if (relative === "manifest.yaml") continue;
    const content = await readFile(join(pkg.root, ...relative.split("/")), "utf8");
    chunks.push(`\n\n## ${relative}\n\n${content}`);
  }
  return chunks.join("\n");
}

export function approvalStartsStageB(approval: "approve-start" | "cancel" | "pending"): boolean {
  return approval === "approve-start";
}

type ApprovalDecision =
  | { kind: "approve-start" }
  | { kind: "cancel" }
  | { kind: "pending" }
  | { kind: "request-changes"; feedback: string };

async function chooseApproval(
  ctx: ExtensionContext,
  pkg: Awaited<ReturnType<typeof loadValidatedRun>>["package"],
  profile?: ProjectPluginProfile,
  revision?: number,
  readiness?: () => Promise<void>,
): Promise<ApprovalDecision> {
  if (!ctx.hasUI) return { kind: "pending" };
  await appendRunEvent(pkg.root, "plan_review_presented", {
    package_hash: pkg.package_hash,
    plan_revision: revision ?? null,
  }).catch(() => undefined);
  for (;;) {
    const choice = await ctx.ui.select("Plan Review & Approval", ["Review Plan", "Request Changes", "Approve & Start", "Cancel"]);
    await appendRunEvent(pkg.root, "plan_review_choice", {
      package_hash: pkg.package_hash,
      plan_revision: revision ?? null,
      choice: choice ?? "dismissed",
    }).catch(() => undefined);
    if (choice === "Cancel" || !choice) return { kind: "cancel" };
    if (choice === "Review Plan") {
      const review = await packageReviewText(pkg, revision);
      await ctx.ui.confirm(
        "Draft plan preview",
        `${review}\n\nExecutor: ${profile?.executorModel ?? "headless"} (${profile?.executorReasoningEffort ?? profile?.reasoningEffort ?? "backend default"})\nReviewer: ${profile?.reviewerModel ?? "headless"} (${profile?.reviewerReasoningEffort ?? profile?.reasoningEffort ?? "backend default"})\nReview limit: ${profile?.reviewRoundLimit ?? pkg.manifest.max_review_rounds ?? DEFAULT_MAX_REVIEW_ROUNDS} round(s) per phase`,
      );
      continue;
    }
    if (choice === "Request Changes") {
      notify(
        ctx,
        "Describe what should be added, removed, clarified, reordered, or changed in acceptance. Submit the editor to ask Main Pi to regenerate the complete draft plan.",
        "info",
      );
      const feedback = (await ctx.ui.editor("Describe plan changes for Main Pi", ""))?.trim();
      if (feedback) return { kind: "request-changes", feedback };
      continue;
    }
    try {
      await readiness?.();
      return { kind: "approve-start" };
    } catch (error) {
      notify(ctx, `Execution is not ready yet: ${error instanceof Error ? error.message : String(error)}\nFix the prerequisite, then choose Approve & Start again. The plan is still an editable draft.`, "warning");
    }
  }
}


async function captureCurrentMainPiSession(ctx: ExtensionContext, runRoot: string): Promise<void> {
  try {
    await captureMainPiSession(runRoot, ctx.sessionManager.getBranch());
  } catch (error) {
    await appendRunEvent(runRoot, "main_pi_session_capture_failed", {
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
  }
}

async function executionReadinessPreflight(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runId: string,
  executorModel: string,
  reviewerModel: string,
): Promise<void> {
  supportedBackendForModel(executorModel);
  supportedBackendForModel(reviewerModel);
  await defaultIsolationProvider.preflight();

  const source = new GitWorkspace(createPiGitOperations(pi, ctx.cwd), {
    cwd: ctx.cwd,
    runtimeRoot: `.pi-plan-execute-auto/${runId}`,
  });
  try {
    await source.head();
  } catch {
    throw new Error("Git has no usable baseline commit. Create the baseline commit before starting execution.");
  }
  try {
    await source.assertNoCachedChanges();
  } catch {
    throw new Error("The main worktree has staged changes. Commit or unstage them before starting; the execution worktree is created from HEAD.");
  }
  const dirty = await source.changedPaths();
  if (dirty.length > 0) {
    throw new Error(
      `The main worktree has uncommitted changes: ${dirty.join(", ")}. Commit, discard, or intentionally ignore them before starting; the execution worktree is created from HEAD.`,
    );
  }
  const targetPath = resolve(dirname(ctx.cwd), ".pi-plan-execute-auto-worktrees", runId);
  try {
    await access(targetPath);
    throw new Error(`The dedicated execution worktree path already exists: ${targetPath}. Remove the stale path or use a new run id.`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("The dedicated execution worktree path already exists:")) throw error;
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  await appendRunEvent(packageRoot(ctx.cwd, runId), "start_preflight_pass", {
    executor_model: executorModel,
    reviewer_model: reviewerModel,
  }).catch(() => undefined);
}

async function requestPlanRevision(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  pkg: Awaited<ReturnType<typeof loadValidatedRun>>["package"],
  feedback: string,
): Promise<void> {
  await appendRunEvent(pkg.root, "plan_revision_requested", {
    package_hash: pkg.package_hash,
    feedback,
  });
  await captureCurrentMainPiSession(ctx, pkg.root);
  const prompt = [
    "The human requested changes to the draft plan. Do not implement project code.",
    `Run id: ${basenameForPrompt(pkg.root)}`,
    `Current package hash: ${pkg.package_hash}`,
    "Use the complete current conversation, repository context, existing draft package, and the human feedback below.",
    "Regenerate the COMPLETE replacement manifest and all draft plan files, then call plan_execute_revise with the same run_id and previous_package_hash.",
    "After revision the plugin will validate the full package and reopen human Review & Approval.",
    "After plan_execute_revise succeeds, end the Main Pi turn with only a brief handoff. Do not restate the revised plan or ask for approval in chat; the plugin UI owns review and approval.",
    "",
    "Human revision request:",
    feedback,
  ].join("\n");
  await pi.sendMessage(
    {
      customType: "plan-execute-revision-request",
      content: prompt,
      display: false,
      details: { run_id: basenameForPrompt(pkg.root), previous_package_hash: pkg.package_hash, feedback },
    },
    { deliverAs: "followUp", triggerTurn: true },
  );
}

function basenameForPrompt(path: string): string {
  const parts = resolve(path).split("/");
  return parts[parts.length - 1] ?? path;
}

const SETUP_STATUS_KEY = "plan-execute-setup";

async function withSetupProgress<T>(ctx: ExtensionCommandContext, label: string, work: () => Promise<T>): Promise<T> {
  if (typeof ctx.ui.setStatus !== "function") return work();
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const started = Date.now();
  let frame = 0;
  const render = () => ctx.ui.setStatus(SETUP_STATUS_KEY, `${frames[frame++ % frames.length]} ${label} (${Math.floor((Date.now() - started) / 1000)}s)`);
  // RPC has status updates but no terminal animation. Avoid a running timer in
  // non-TUI clients; always clear status even when discovery fails.
  render();
  const timer = ctx.mode === "tui" ? setInterval(render, 120) : undefined;
  try { return await work(); }
  finally {
    if (timer) clearInterval(timer);
    ctx.ui.setStatus(SETUP_STATUS_KEY, undefined);
  }
}

async function chooseConfiguredModel(
  ctx: ExtensionCommandContext, role: "Executor" | "Reviewer", clis: DetectedCli[], acpCatalog: (backend: AcpBackend) => Promise<string[]>,
): Promise<string | undefined> {
  const entries = clis.map((cli) => ({ label: `${cli.backend} · ${cli.version}`, cli }));
  const backendLabel = await ctx.ui.select(`${role}: choose local coding CLI`, entries.map((entry) => entry.label));
  const selected = entries.find((entry) => entry.label === backendLabel)?.cli;
  if (!selected) return undefined;
  let model: string | undefined;
  let candidates = selected.models;
  if (selected.backend === "pi") {
    try {
      const liveCatalog = await withSetupProgress(ctx, `${role}: loading Pi ACP models`, () => acpCatalog("pi"));
      candidates = candidates.filter((candidate) => liveCatalog.includes(candidate));
      if (candidates.length === 0) candidates = liveCatalog;
    } catch (error) {
      notify(ctx, `Isolated Pi ACP model discovery failed: ${error instanceof Error ? error.message : String(error)}. CLI candidates alone are not proof of ACP availability.`, "warning");
      candidates = [];
    }
  }
  if (candidates.length === 0 && selected.backend !== "pi") {
    try { candidates = await withSetupProgress(ctx, `${role}: loading ${selected.backend} ACP models`, () => acpCatalog(selected.backend)); }
    catch (error) {
      notify(ctx, `Isolated ${selected.backend} ACP model discovery failed: ${error instanceof Error ? error.message : String(error)}. Enter an exact model ID manually; ACP still verifies it at start.`, "warning");
    }
  }
  if (candidates.length) {
    const custom = `Enter another ${selected.backend} model ID…`;
    const chosen = await ctx.ui.select(`${role}: ${selected.backend} model (candidates; checked again at ACP start)`, [...candidates, custom]);
    if (!chosen) return undefined;
    model = chosen === custom ? await ctx.ui.input(`${selected.backend} model ID`, selected.backend === "pi" || selected.backend === "opencode" ? "provider/model-id" : "model-id") : chosen;
  } else {
    model = await ctx.ui.input(`${role}: ${selected.backend} model ID (catalog unavailable)`, selected.backend === "pi" || selected.backend === "opencode" ? "provider/model-id" : "model-id");
  }
  if (!model?.trim()) return undefined;
  return normalizeSelectedModel(selected.backend as AcpBackend, model);
}

async function chooseRoleEffort(
  ctx: ExtensionCommandContext, role: "Executor" | "Reviewer", model: string,
  discover: () => Promise<ReasoningEffort[]>,
): Promise<ReasoningEffort | "default" | undefined> {
  const efforts = await withSetupProgress(ctx, `${role}: loading reasoning levels for ${model}`, discover);
  const choices = (["low", "medium", "high", "max"] as const).filter((effort) => efforts.includes(effort));
  const chosen = await ctx.ui.select(`${role}: reasoning effort for ${model}`, [...choices, "backend default", "Cancel"]);
  if (!chosen || chosen === "Cancel") return undefined;
  return chosen === "backend default" ? "default" : selectStageBReasoningEffort(chosen);
}

function setupProfileSummary(profile: ProjectPluginProfile): string {
  return [
    "Current project setup",
    `Executor: ${profile.executorModel} (${profile.executorReasoningEffort ?? profile.reasoningEffort ?? "backend default"})`,
    `Reviewer: ${profile.reviewerModel} (${profile.reviewerReasoningEffort ?? profile.reasoningEffort ?? "backend default"})`,
    `Review loop limit: ${profile.reviewRoundLimit} round(s) per phase`,
    `Permissions: ${profile.permissionMode === "autonomous" ? "Autonomous" : "Ask me"}`,
    `Execution timeout: ${formatStageTimeout(profile.stageTimeoutMs)}`,
    `Approved: ${profile.networkRiskApprovedAt}`,
  ].join("\n");
}

async function runCurrentSetupHealthCheck(
  ctx: ExtensionCommandContext,
  profile: ProjectPluginProfile,
  verifyConnectivity: (projectRoot: string, model: string, effort?: ReasoningEffort) => Promise<void> = verifyAcpModelCall,
): Promise<"passed" | "skipped"> {
  const selected = [
    [profile.executorModel, profile.executorReasoningEffort ?? profile.reasoningEffort],
    [profile.reviewerModel, profile.reviewerReasoningEffort ?? profile.reasoningEffort],
  ] as const;
  const unique = selected.filter(([model, effort], index) =>
    selected.findIndex(([otherModel, otherEffort]) => model === otherModel && effort === otherEffort) === index);
  const labels = unique.map(([model, effort]) => `${model} (${effort ?? "backend default"})`);
  const approved = await ctx.ui.confirm(
    "Run health check for current setup? (optional)",
    `Routes: ${labels.join(", ")}. This sends a tiny READY request through each selected Agent CLI/provider and may incur provider charges. ` +
    "No project files are mounted. The saved project setup will not be changed whether the check passes, fails, or is skipped.",
  );
  if (!approved) {
    notify(ctx, "Health check skipped. Current project setup is unchanged.", "info");
    return "skipped";
  }
  for (const [model, effort] of unique) {
    await withSetupProgress(ctx, `Checking ${model} (${effort ?? "backend default"})`, () =>
      verifyConnectivity(ctx.cwd, model, effort));
  }
  notify(ctx, "Health check passed for the current Executor/Reviewer routes. Project setup is unchanged.", "info");
  return "passed";
}

export async function chooseExistingSetupAction(
  ctx: ExtensionCommandContext,
  profile: ProjectPluginProfile,
  verifyConnectivity: (projectRoot: string, model: string, effort?: ReasoningEffort) => Promise<void> = verifyAcpModelCall,
): Promise<"keep" | "reconfigure" | "cancel"> {
  notify(ctx, setupProfileSummary(profile), "info");
  for (;;) {
    const choice = await ctx.ui.select("Plan Execute Setup", [
      "Keep current setup",
      "Run health check — optional, may incur provider charges",
      "Reconfigure",
      "Cancel",
    ]);
    if (!choice || choice === "Cancel") return "cancel";
    if (choice === "Keep current setup") {
      notify(ctx, "Current project setup kept. No CLI discovery, model probe, or provider call was run.", "info");
      return "keep";
    }
    if (choice.startsWith("Run health check")) {
      await runCurrentSetupHealthCheck(ctx, profile, verifyConnectivity);
      return "keep";
    }
    if (choice === "Reconfigure") {
      const approved = await ctx.ui.confirm(
        "Reconfigure this project?",
        "New selections become the default for future plans/runs. Existing approved runs keep the settings frozen into their own state; " +
        "a frozen run whose settings differ from the new project setup will not silently switch agents and cannot be resumed until you restore matching setup or create a new run. " +
        "The execution timeout is an operational policy: raising it here takes effect the next time a paused run is resumed.",
      );
      if (approved) return "reconfigure";
    }
  }
}

export async function chooseStageTimeout(ctx: ExtensionCommandContext): Promise<number | undefined> {
  notify(
    ctx,
    "The execution timeout is the total budget for the whole Execution & Review across every phase, including Executor, Reviewer, and acceptance runs. " +
    "When it expires, the run pauses as a resumable TIMEOUT checkpoint instead of running unattended without a bound. " +
    "Choose No timeout only if you accept that an unattended run may never return.",
    "info",
  );
  const labels = STAGE_TIMEOUT_CHOICES.map((choice) => choice.label);
  const choice = await ctx.ui.select("Execution timeout for the whole run", [...labels, "Cancel"]);
  if (!choice || choice === "Cancel") return undefined;
  const selected = STAGE_TIMEOUT_CHOICES.find((entry) => entry.label === choice);
  if (!selected) return undefined;
  if (selected.ms >= 0) return selected.ms;
  const minMinutes = MIN_STAGE_TIMEOUT_MS / 60_000;
  const maxMinutes = MAX_STAGE_TIMEOUT_MS / 60_000;
  for (;;) {
    const raw = await ctx.ui.input(`Custom execution timeout in minutes (${minMinutes}–${maxMinutes})`, "e.g. 45");
    if (raw === undefined) return undefined;
    const minutes = Number(raw.trim());
    const ms = minutes * 60_000;
    if (Number.isInteger(minutes) && ms >= MIN_STAGE_TIMEOUT_MS && ms <= MAX_STAGE_TIMEOUT_MS) return ms;
    ctx.ui.notify(`Enter a whole number of minutes between ${minMinutes} and ${maxMinutes}, or cancel the dialog to abort setup.`, "warning");
  }
}

export async function runSetupWizard(
  ctx: ExtensionCommandContext,
  clis: DetectedCli[] | (() => Promise<DetectedCli[]>),
  agentDir?: string,
  discoverModels: (projectRoot: string, backend: AcpBackend) => Promise<string[]> = probeAcpModels,
  discoverEfforts: (projectRoot: string, backend: AcpBackend, model: string) => Promise<ReasoningEffort[]> = async (root, backend, model) =>
    (await probeAcpConfiguration(root, backend, model)).efforts,
  verifyConnectivity: (projectRoot: string, model: string, effort?: ReasoningEffort) => Promise<void> = verifyAcpModelCall,
  inspectClaudeSandbox: typeof inspectClaudeNativeSandbox = inspectClaudeNativeSandbox,
): Promise<ProjectPluginProfile | undefined> {
  if (!ctx.hasUI) throw new Error("Setup requires Pi's interactive UI (or RPC dialogs).");
  const preConsent = await ctx.ui.confirm(
    "Allow Agent CLI discovery?",
    "CLI model discovery may access the host network. ACP catalog fallbacks for Claude, Codex, OpenCode and Pi use a temporary sandboxed read-only session. " +
    "ACP servers still share the host network namespace. Do not proceed for sensitive repositories. " +
    "Catalog discovery mounts no project files and submits no model turn. A separate live connectivity check is offered later and may be skipped.",
  );
  if (!preConsent) return undefined;
  const detected = typeof clis === "function" ? await withSetupProgress(ctx, "Detecting local Agent CLIs", clis) : clis;
  if (detected.length === 0) throw new Error("No working Claude, Codex, OpenCode or Pi CLI was found on PATH. Install and authenticate a supported Agent CLI before setup.");
  notify(
    ctx,
    ["Agent CLI preflight", ...detected.map((cli) => `✓ ${cli.backend}: ${cli.version} (${cli.executable})`)].join("\n"),
    "info",
  );
  const catalogs = new Map<AcpBackend, Promise<string[]>>();
  const catalog = (backend: AcpBackend) => {
    let pending = catalogs.get(backend);
    if (!pending) { pending = discoverModels(ctx.cwd, backend); catalogs.set(backend, pending); }
    return pending;
  };
  const efforts = new Map<string, Promise<ReasoningEffort[]>>();
  const effortCatalog = (model: string) => {
    let pending = efforts.get(model);
    if (!pending) {
      pending = discoverEfforts(ctx.cwd, supportedBackendForModel(model), model);
      efforts.set(model, pending);
    }
    return pending;
  };
  const executorModel = await chooseConfiguredModel(ctx, "Executor", detected, catalog);
  if (!executorModel) return undefined;
  const executorChoice = await chooseRoleEffort(ctx, "Executor", executorModel, () => effortCatalog(executorModel));
  if (!executorChoice) return undefined;
  const reviewerModel = await chooseConfiguredModel(ctx, "Reviewer", detected, catalog);
  if (!reviewerModel) return undefined;
  const reviewerChoice = await chooseRoleEffort(ctx, "Reviewer", reviewerModel, () => effortCatalog(reviewerModel));
  if (!reviewerChoice) return undefined;
  const executorReasoningEffort = executorChoice === "default" ? undefined : executorChoice;
  const reviewerReasoningEffort = reviewerChoice === "default" ? undefined : reviewerChoice;
  if ([executorModel, reviewerModel].some((model) => model.startsWith("claude/"))) {
    const claudeSandbox = await inspectClaudeSandbox(ctx.cwd);
    const claudeNeedsSocat = process.platform === "linux" && claudeSandbox.enabled;
    if (claudeNeedsSocat && !claudeSandbox.socat) {
      throw new Error(
        "Claude Code's native Bash sandbox is enabled by your own Claude configuration, but socat was not found on PATH. " +
        "On Linux/WSL install it with: sudo apt-get install -y socat. " +
        "This is a Claude Code dependency for its native Linux sandbox, not a pi-plan-execute-auto requirement. " +
        "Detected from: " + (claudeSandbox.sources.join("; ") || "Claude native configuration"),
      );
    }
    notify(
      ctx,
      claudeSandbox.enabled
        ? claudeNeedsSocat
          ? `Claude native Bash sandbox: enabled by your Claude configuration\n✓ socat: ${claudeSandbox.socat}\nThe plugin preserves this native Claude behavior; socat is required by Claude Code on Linux/WSL in this configuration.`
          : "Claude native Bash sandbox: enabled by your Claude configuration. On macOS the plugin uses the platform Seatbelt boundary and does not require the Linux socat preflight."
        : "Claude native Bash sandbox: not enabled by the detected Claude configuration. pi-plan-execute-auto does not force it, so socat is not required by the plugin.",
      "info",
    );
  }
  notify(ctx,
    "Review loop limit controls the maximum Executor → Reviewer cycles allowed for each phase. " +
    "The remaining round budget is injected into both agents every round so they can converge instead of drip-feeding work or findings. " +
    "If the limit is exhausted without PASS, execution pauses for you instead of looping indefinitely.",
    "info");
  const roundLabels = REVIEW_ROUND_CHOICES.map((value) =>
    `${value} rounds${value === DEFAULT_MAX_REVIEW_ROUNDS ? " (recommended default)" : ""}`);
  const roundChoice = await ctx.ui.select("Maximum review rounds per phase", [...roundLabels, "Cancel"]);
  if (!roundChoice || roundChoice === "Cancel") return undefined;
  const reviewRoundLimit = REVIEW_ROUND_CHOICES[roundLabels.indexOf(roundChoice)];
  if (!reviewRoundLimit) return undefined;

  notify(ctx,
    "Agent permission handling does not remove tools. Autonomous mode automatically accepts one-time tool permission prompts so execution can continue unattended. " +
    "Ask me mode keeps the same CLI capabilities but pauses on each ACP permission request and lets you choose one of that CLI's advertised options in Pi.",
    "info");
  const autonomousLabel = "Autonomous — automatically approve agent tool permission requests";
  const askLabel = "Ask me — pause and show each agent permission request in Pi";
  const permissionChoice = await ctx.ui.select("Agent permission handling during Execution & Review", [autonomousLabel, askLabel, "Cancel"]);
  if (!permissionChoice || permissionChoice === "Cancel") return undefined;
  const permissionMode: AgentPermissionMode = permissionChoice === askLabel ? "ask" : "autonomous";

  const configuredStageTimeoutMs = await chooseStageTimeout(ctx);
  if (configuredStageTimeoutMs === undefined) return undefined;

  const selectedChecks = [[executorModel, executorReasoningEffort], [reviewerModel, reviewerReasoningEffort]] as const;
  const needsLiveCheck = [...new Set(selectedChecks.map(([route, effort]) => `${route} (${effort ?? "backend default"})`))];
  let liveConnectivity = "skipped";
  if (needsLiveCheck.length) {
    const allowCalls = await ctx.ui.confirm(
      "Run live Agent CLI connectivity checks? (optional)",
      `Selected routes: ${needsLiveCheck.join(", ")}. Each check opens the selected ACP/CLI in an isolated disposable repository and sends a tiny READY prompt. ` +
      "This uses your normal CLI/provider configuration and may incur provider charges. Choose No to skip this optional check and continue setup normally. " +
      "If you choose Yes, a failed check stops setup; the plugin never substitutes another model. No project files are mounted.",
    );
    if (allowCalls) {
      for (const [route, effort] of selectedChecks.filter(([model, level], index) =>
        selectedChecks.findIndex(([otherModel, otherLevel]) => model === otherModel && level === otherLevel) === index)) {
        await withSetupProgress(ctx, `Checking ${route} (${effort ?? "backend default"})`, () => verifyConnectivity(ctx.cwd, route, effort));
      }
      liveConnectivity = "passed";
    } else {
      notify(ctx, "Live Agent CLI connectivity checks skipped. Setup will continue; authentication/provider errors, if any, may surface when Execution & Review actually starts.", "info");
    }
  }
  const consent = await ctx.ui.confirm(
    "Confirm normal Agent CLI network access?",
    `Executor: ${executorModel} (${executorReasoningEffort ?? "backend default"})\nReviewer: ${reviewerModel} (${reviewerReasoningEffort ?? "backend default"})\nReview loop limit: ${reviewRoundLimit}\nPermission mode: ${permissionMode}\nExecution timeout: ${formatStageTimeout(configuredStageTimeoutMs)}\nLive connectivity: ${liveConnectivity}\n\n` +
    "The selected Agent CLIs and their tools keep normal network access, matching a normal standalone CLI session. " +
    "The plugin still isolates the dedicated worktree and unrelated host files; this confirmation does not approve or start execution.",
  );
  if (!consent) return undefined;
  return saveProjectPluginProfile(ctx.cwd, {
    executorModel,
    reviewerModel,
    ...(executorReasoningEffort ? { executorReasoningEffort } : {}),
    ...(reviewerReasoningEffort ? { reviewerReasoningEffort } : {}),
    permissionMode,
    reviewRoundLimit,
    stageTimeoutMs: configuredStageTimeoutMs,
  }, agentDir);
}

async function commandSetup(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    notify(ctx, "Setup requires Pi's interactive UI (or RPC dialogs). For headless automation use the documented explicit environment fallback.", "warning");
    return;
  }
  try {
    if (!await ensureSetupRepository(ctx.cwd, ctx.ui)) return;

    let existing: ProjectPluginProfile | undefined;
    try {
      existing = await loadProjectPluginProfile(ctx.cwd);
    } catch (error) {
      notify(
        ctx,
        `Existing project setup could not be validated and must be reapproved: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
    if (existing) {
      const action = await chooseExistingSetupAction(ctx, existing);
      if (action !== "reconfigure") return;
    }

    const isolation = await defaultIsolationProvider.preflight();
    const isolationDetails = isolation.provider === "linux-bubblewrap"
      ? [`✓ bubblewrap: ${isolation.bubblewrap}`, "✓ Linux user namespaces available"]
      : [`✓ sandbox-exec: ${isolation.sandboxExec}`, "✓ macOS Seatbelt launcher available"];
    notify(
      ctx,
      [
        "Environment preflight",
        `✓ Isolation: ${isolation.provider}`,
        ...isolationDetails,
        "✓ Agent/tool network: normal host networking",
        "✓ Plugin-level socat dependency: none (Claude Code may require socat only for its own native Linux/WSL Bash sandbox)",
      ].join("\n"),
      "info",
    );
    const saved = await runSetupWizard(ctx, discoverAcpClis);
    notify(ctx, saved
      ? `Project configured: Executor ${saved.executorModel} (${saved.executorReasoningEffort ?? saved.reasoningEffort ?? "backend default"}) → Reviewer ${saved.reviewerModel} (${saved.reviewerReasoningEffort ?? saved.reasoningEffort ?? "backend default"}); review limit ${saved.reviewRoundLimit}; permissions ${saved.permissionMode}. Run /plan-execute when the plan is ready for human review.`
      : "Setup cancelled; the previous project setup (if any) was left unchanged.", saved ? "info" : "warning");
  } catch (error) {
    notify(ctx, error instanceof Error ? error.message : String(error), "error");
  }
}

interface EditableSettings {
  executorModel: string;
  reviewerModel: string;
  executorReasoningEffort: ReasoningEffort | undefined;
  reviewerReasoningEffort: ReasoningEffort | undefined;
  permissionMode: AgentPermissionMode;
  reviewRoundLimit: number;
  stageTimeoutMs: number | undefined;
}

/**
 * Keep a frozen run's persisted settings identical to the approved project profile so an explicit
 * resume is not refused by `frozenProfileMismatch`. Timeout is synced for status display only; it is
 * an operational policy and never invalidates a frozen run. Exported for tests.
 */
export function applyProfileToFrozenState(state: WorkflowState, profile: ProjectPluginProfile): string[] {
  const record = state as unknown as Record<string, unknown>;
  const changed: string[] = [];
  const set = (key: string, value: unknown): void => {
    if (record[key] !== value) {
      record[key] = value;
      changed.push(key);
    }
  };
  const unset = (key: string): void => {
    if (record[key] !== undefined) {
      delete record[key];
      changed.push(key);
    }
  };
  set("executor_model", profile.executorModel);
  set("reviewer_model", profile.reviewerModel);
  if (profile.reasoningEffort) set("reasoning_effort", profile.reasoningEffort); else unset("reasoning_effort");
  if (profile.executorReasoningEffort) set("executor_reasoning_effort", profile.executorReasoningEffort); else unset("executor_reasoning_effort");
  if (profile.reviewerReasoningEffort) set("reviewer_reasoning_effort", profile.reviewerReasoningEffort); else unset("reviewer_reasoning_effort");
  set("permission_mode", profile.permissionMode);
  set("review_round_limit", profile.reviewRoundLimit);
  set("stage_timeout_ms", stageTimeoutMs(profile));
  return changed;
}

async function discoverRunIds(cwd: string): Promise<string[]> {
  const root = join(cwd, ".pi-plan-execute-auto");
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const runs: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith("run-")) continue;
    try {
      await access(join(root, entry, ".state.json"));
      runs.push(entry);
    } catch {
      // Not a persisted run directory.
    }
  }
  return runs.sort();
}

async function persistSettings(
  ctx: ExtensionCommandContext,
  settings: EditableSettings,
  loaded: Awaited<ReturnType<typeof loadValidatedRun>> | undefined,
): Promise<ProjectPluginProfile> {
  const profile = await saveProjectPluginProfile(ctx.cwd, {
    executorModel: settings.executorModel,
    reviewerModel: settings.reviewerModel,
    ...(settings.executorReasoningEffort ? { executorReasoningEffort: settings.executorReasoningEffort } : {}),
    ...(settings.reviewerReasoningEffort ? { reviewerReasoningEffort: settings.reviewerReasoningEffort } : {}),
    permissionMode: settings.permissionMode,
    reviewRoundLimit: settings.reviewRoundLimit,
    ...(settings.stageTimeoutMs !== undefined ? { stageTimeoutMs: settings.stageTimeoutMs } : {}),
  });
  if (loaded) {
    const changed = applyProfileToFrozenState(loaded.state, profile);
    if (changed.length > 0) {
      await writeWorkflowState(loaded.package.root, loaded.state);
      await appendRunEvent(loaded.package.root, "workflow_settings_changed", {
        run_id: loaded.state.run_id,
        changed,
        executor_model: profile.executorModel,
        reviewer_model: profile.reviewerModel,
        permission_mode: profile.permissionMode,
        review_round_limit: profile.reviewRoundLimit,
        stage_timeout_ms: stageTimeoutMs(profile),
      }).catch(() => undefined);
    }
  }
  return profile;
}

async function commandSettings(ctx: ExtensionCommandContext, runIdArg?: string): Promise<void> {
  if (!ctx.hasUI) {
    notify(ctx, "Settings requires Pi's interactive UI. Use /plan-execute setup for the full wizard.", "warning");
    return;
  }
  try {
    let runId = runIdArg;
    if (!runId) {
      const candidates = await discoverRunIds(ctx.cwd);
      if (candidates.length > 0) {
        const choice = await ctx.ui.select("Apply settings to", [
          "Project defaults (new runs and resumes)",
          ...candidates.map((id) => `Run: ${id}`),
          "Cancel",
        ]);
        if (!choice || choice === "Cancel") return;
        if (choice.startsWith("Run: ")) runId = choice.slice("Run: ".length);
      }
    }
    let loaded: Awaited<ReturnType<typeof loadValidatedRun>> | undefined;
    if (runId) {
      if (activeRuns.has(runId)) {
        notify(ctx, `Run ${runId} is executing. Stop it first with /plan-execute stop ${runId}; changed settings only apply to sessions created after a resume.`, "warning");
        return;
      }
      try {
        loaded = await loadValidatedRun(ctx.cwd, runId);
      } catch (error) {
        notify(ctx, `Cannot load ${runId}: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
      if (loaded.state.status === "completed" || loaded.state.status === "cancelled") {
        notify(ctx, `Run ${runId} is ${loaded.state.status}; settings no longer affect it.`, "warning");
        return;
      }
    }
    let profile: ProjectPluginProfile | undefined;
    try {
      profile = await loadProjectPluginProfile(ctx.cwd);
    } catch (error) {
      notify(ctx, `Existing project setup could not be validated: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
    if (!profile && !loaded) {
      notify(ctx, "No project configuration. Run /plan-execute setup first.", "warning");
      return;
    }

    const settings: EditableSettings = {
      executorModel: loaded?.state.executor_model ?? profile!.executorModel,
      reviewerModel: loaded?.state.reviewer_model ?? profile!.reviewerModel,
      executorReasoningEffort: loaded?.state.executor_reasoning_effort ?? loaded?.state.reasoning_effort ?? profile!.executorReasoningEffort ?? profile!.reasoningEffort,
      reviewerReasoningEffort: loaded?.state.reviewer_reasoning_effort ?? loaded?.state.reasoning_effort ?? profile!.reviewerReasoningEffort ?? profile!.reasoningEffort,
      permissionMode: loaded?.state.permission_mode ?? profile!.permissionMode,
      reviewRoundLimit: loaded?.state.review_round_limit ?? profile!.reviewRoundLimit,
      stageTimeoutMs: loaded?.state.stage_timeout_ms ?? profile!.stageTimeoutMs,
    };

    let clis: DetectedCli[] | undefined;
    const detected = async (): Promise<DetectedCli[]> => {
      clis ??= await withSetupProgress(ctx, "Detecting local Agent CLIs", discoverAcpClis);
      return clis;
    };
    const catalogs = new Map<AcpBackend, Promise<string[]>>();
    const catalog = (backend: AcpBackend): Promise<string[]> => {
      let pending = catalogs.get(backend);
      if (!pending) {
        pending = probeAcpModels(ctx.cwd, backend);
        catalogs.set(backend, pending);
      }
      return pending;
    };
    const effortCatalog = (model: string): Promise<ReasoningEffort[]> =>
      probeAcpConfiguration(ctx.cwd, supportedBackendForModel(model), model).then((result) => result.efforts);

    const autonomousLabel = "Autonomous — automatically approve agent tool permission requests";
    const askLabel = "Ask me — pause and show each agent permission request in Pi";
    const target = runId ? `run ${runId}` : "project defaults";

    for (;;) {
      const labels = [
        `Executor model: ${settings.executorModel}`,
        `Executor reasoning effort: ${settings.executorReasoningEffort ?? "backend default"}`,
        `Reviewer model: ${settings.reviewerModel}`,
        `Reviewer reasoning effort: ${settings.reviewerReasoningEffort ?? "backend default"}`,
        `Agent permission mode: ${settings.permissionMode === "ask" ? "Ask me" : "Autonomous"}`,
        `Review round limit: ${settings.reviewRoundLimit}`,
        `Execution timeout: ${formatStageTimeout(settings.stageTimeoutMs)}`,
        "Done",
      ];
      const choice = await ctx.ui.select(`Plan-execute settings · ${target}`, [...labels, "Cancel"]);
      if (!choice || choice === "Cancel") return;
      if (choice === "Done") break;

      if (choice.startsWith("Executor model: ")) {
        const model = await chooseConfiguredModel(ctx, "Executor", await detected(), catalog);
        if (!model) continue;
        settings.executorModel = model;
        const effort = await chooseRoleEffort(ctx, "Executor", model, () => effortCatalog(model));
        if (effort !== undefined) settings.executorReasoningEffort = effort === "default" ? undefined : effort;
      } else if (choice.startsWith("Executor reasoning effort: ")) {
        const effort = await chooseRoleEffort(ctx, "Executor", settings.executorModel, () => effortCatalog(settings.executorModel));
        if (effort !== undefined) settings.executorReasoningEffort = effort === "default" ? undefined : effort;
      } else if (choice.startsWith("Reviewer model: ")) {
        const model = await chooseConfiguredModel(ctx, "Reviewer", await detected(), catalog);
        if (!model) continue;
        settings.reviewerModel = model;
        const effort = await chooseRoleEffort(ctx, "Reviewer", model, () => effortCatalog(model));
        if (effort !== undefined) settings.reviewerReasoningEffort = effort === "default" ? undefined : effort;
      } else if (choice.startsWith("Reviewer reasoning effort: ")) {
        const effort = await chooseRoleEffort(ctx, "Reviewer", settings.reviewerModel, () => effortCatalog(settings.reviewerModel));
        if (effort !== undefined) settings.reviewerReasoningEffort = effort === "default" ? undefined : effort;
      } else if (choice.startsWith("Agent permission mode: ")) {
        const chosen = await ctx.ui.select("Agent permission handling during Execution & Review", [autonomousLabel, askLabel, "Cancel"]);
        if (!chosen || chosen === "Cancel") continue;
        settings.permissionMode = chosen === askLabel ? "ask" : "autonomous";
      } else if (choice.startsWith("Review round limit: ")) {
        const roundLabels = REVIEW_ROUND_CHOICES.map((value) => `${value} rounds${value === DEFAULT_MAX_REVIEW_ROUNDS ? " (recommended default)" : ""}`);
        const chosen = await ctx.ui.select("Maximum review rounds per phase", [...roundLabels, "Cancel"]);
        if (!chosen || chosen === "Cancel") continue;
        const limit = REVIEW_ROUND_CHOICES[roundLabels.indexOf(chosen)];
        if (!limit) continue;
        settings.reviewRoundLimit = limit;
      } else if (choice.startsWith("Execution timeout: ")) {
        const ms = await chooseStageTimeout(ctx);
        if (ms !== undefined) settings.stageTimeoutMs = ms;
      } else {
        continue;
      }

      const saved = await persistSettings(ctx, settings, loaded);
      notify(ctx, [
        `Settings saved${runId ? ` for ${runId}` : ""}.`,
        `Executor: ${saved.executorModel} (${saved.executorReasoningEffort ?? saved.reasoningEffort ?? "backend default"})`,
        `Reviewer: ${saved.reviewerModel} (${saved.reviewerReasoningEffort ?? saved.reasoningEffort ?? "backend default"})`,
        `Review limit ${saved.reviewRoundLimit}; permissions ${saved.permissionMode}; timeout ${formatStageTimeout(saved.stageTimeoutMs)}`,
        runId ? "Model/effort changes apply to sessions created after the next resume." : "",
      ].filter(Boolean).join("\n"), "info");
    }
  } catch (error) {
    notify(ctx, error instanceof Error ? error.message : String(error), "error");
  }
}

function makeAcceptanceRunner(
  cwd: string,
  sourceRoot: string,
  goldenRoot: string,
  historyRootCommit?: () => string | undefined,
): AcceptanceCommandRunner {
  return {
    async run(command, options) {
      const historyRoot = historyRootCommit?.();
      return defaultIsolationProvider.runAcceptanceCommand({
        cwd,
        sourceRoot,
        goldenRoot,
        command,
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(historyRoot ? { historyRootCommit: historyRoot } : {}),
        timeout: options?.timeout ?? DEFAULT_ACCEPTANCE_TIMEOUT_MS,
      });
    },
  };
}

export function selectStageBReasoningEffort(value: string | undefined): ReasoningEffort | undefined {
  if (!value) return undefined;
  if (value !== "low" && value !== "medium" && value !== "high" && value !== "max") {
    throw new Error("PI_PLAN_EXECUTE_REASONING_EFFORT accepts only low, medium, high, or max.");
  }
  return value;
}

export function frozenProfileMismatch(
  state: WorkflowState,
  profile: ProjectPluginProfile,
  executorOverride?: string,
  reviewerOverride?: string,
): string[] {
  const mismatches: string[] = [];
  const compare = (label: string, frozen: unknown, setup: unknown): void => {
    if (frozen !== setup) mismatches.push(`${label}: run ${show(frozen)} ≠ setup ${show(setup)}`);
  };
  compare("executor model", state.executor_model, profile.executorModel);
  compare("reviewer model", state.reviewer_model, profile.reviewerModel);
  compare("shared reasoning effort", state.reasoning_effort, profile.reasoningEffort);
  compare("executor reasoning effort", state.executor_reasoning_effort, profile.executorReasoningEffort);
  compare("reviewer reasoning effort", state.reviewer_reasoning_effort, profile.reviewerReasoningEffort);
  compare("permission mode", state.permission_mode, profile.permissionMode);
  compare("review round limit", state.review_round_limit, profile.reviewRoundLimit);
  if (executorOverride && executorOverride !== profile.executorModel) {
    mismatches.push(`requested executor model: ${executorOverride} ≠ setup ${profile.executorModel}`);
  }
  if (reviewerOverride && reviewerOverride !== profile.reviewerModel) {
    mismatches.push(`requested reviewer model: ${reviewerOverride} ≠ setup ${profile.reviewerModel}`);
  }
  return mismatches;
}

function show(value: unknown): string {
  return value === undefined ? "(unset)" : String(value);
}

export function frozenProfileMatches(
  state: WorkflowState,
  profile: ProjectPluginProfile,
  executorOverride?: string,
  reviewerOverride?: string,
): boolean {
  // The whole-run timeout is an operational resource policy, not artifact
  // provenance: it may be raised through a new human-approved setup (for
  // example after a TIMEOUT pause) without invalidating the frozen run.
  return frozenProfileMismatch(state, profile, executorOverride, reviewerOverride).length === 0;
}

/**
 * Resolve the whole-run Stage B budget. The human-approved project profile owns
 * the value when present; headless runs without a profile use the explicit env
 * fallback. Malformed values fall back to the recommended default instead of
 * silently disabling the watchdog.
 */
export function stageTimeoutMs(profile?: ProjectPluginProfile, env: NodeJS.ProcessEnv = process.env): number {
  if (profile?.stageTimeoutMs !== undefined) return profile.stageTimeoutMs;
  return parseStageTimeoutValue(env.PI_PLAN_EXECUTE_STAGE_B_TIMEOUT_MS);
}

function acceptanceTimeoutMs(): number {
  const parsed = Number(process.env.PI_PLAN_EXECUTE_ACCEPTANCE_TIMEOUT_MS ?? DEFAULT_ACCEPTANCE_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ACCEPTANCE_TIMEOUT_MS;
}

/**
 * Abort plumbing with a typed cause. The watchdog, `/plan-execute stop`, and
 * the surrounding Pi session all abort the same controller, but their reasons
 * stay distinguishable so a persisted pause can say WHY it happened.
 */
export function linkedAbortSignal(
  external: AbortSignal | undefined,
  timeoutMs: number,
  startedAt = Date.now(),
): { signal: AbortSignal; controller: AbortController; dispose: () => void } {
  const controller = new AbortController();
  const timer = timeoutMs > 0
    ? setTimeout(() => controller.abort({
        kind: "timeout",
        message: `Stage B timed out after ${formatStageTimeout(timeoutMs)}.`,
        timeoutMs,
        elapsedMs: Date.now() - startedAt,
      } satisfies StageBAbortReason), timeoutMs)
    : undefined;
  const abort = () => {
    const reason = external?.reason;
    controller.abort(isStageBAbortReason(reason)
      ? reason
      : {
          kind: "session_abort",
          message: reason instanceof Error ? reason.message : "Pi session interrupted Execution & Review.",
        } satisfies StageBAbortReason);
  };
  if (external) {
    if (external.aborted) abort();
    else external.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    controller,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", abort);
    },
  };
}

type StartResult =
  | StageBRunResult
  | {
      status: "not_started";
      state?: WorkflowState;
      reason: string;
    };

function pauseCode(reason: string | undefined): string | undefined {
  return reason?.match(/^\[([A-Z0-9_]+)\]/u)?.[1];
}

export function evaluateResumeEligibility(
  state: WorkflowState,
  options?: { allowOrphanedRunning?: boolean },
): { ok: true; code: string; currentPhase: string; repairRequired?: boolean } | { ok: false; reason: string } {
  if (state.status !== "paused" && !(options?.allowOrphanedRunning && state.status === "running")) {
    return { ok: false, reason: `Run is ${state.status}; only a paused run or an orphaned persisted running run can be resumed.` };
  }
  if (!state.worktree_path || !state.branch_name) {
    return { ok: false, reason: "Run has no persisted dedicated worktree/branch identity to resume safely." };
  }
  const current = state.phases.find((phase) => phase.status !== "completed");
  if (!current) return { ok: false, reason: "Run has no incomplete phase to resume." };
  const limit = state.review_round_limit ?? DEFAULT_MAX_REVIEW_ROUNDS;
  if (current.review_rounds >= limit) {
    return { ok: false, reason: `Current phase already consumed review_round_limit=${limit}; resume cannot create extra hidden review rounds.` };
  }
  const code = state.status === "running" ? "PROCESS_RESTART" : state.pause?.code ?? pauseCode(state.pause_reason);
  const resumable = (state.status === "paused" && state.pause ? state.pause.resumable : pauseResumable(code))
    || roundLimitResumeAllowed(code, current.review_rounds, limit);
  const repairable = state.status === "paused" && pauseRepairable(code);
  if (!code || (!resumable && !repairable)) {
    return {
      ok: false,
      reason: `Pause reason ${state.pause_reason ?? "(missing)"} is not an execution-interruption checkpoint. Safety/evidence failures require human repair or a new reviewed run.`,
    };
  }
  return {
    ok: true,
    code,
    currentPhase: current.phase_id,
    ...(!resumable ? { repairRequired: true } : {}),
  };
}

async function verifyResumeCheckpoint(
  pkg: Awaited<ReturnType<typeof loadValidatedRun>>["package"],
  state: WorkflowState,
  git: GitWorkspace,
): Promise<void> {
  const currentIndex = state.phases.findIndex((phase) => phase.status !== "completed");
  if (currentIndex < 0) throw new Error("Run has no incomplete phase.");
  const current = state.phases[currentIndex]!;
  const phase = pkg.phases.find((entry) => entry.phase.id === current.phase_id);
  if (!phase) throw new Error(`Current phase ${current.phase_id} is missing from the frozen package.`);

  await git.assertDedicatedIdentity();
  await git.assertNoCachedChanges();
  const head = await git.head();
  const previous = currentIndex > 0 ? state.phases[currentIndex - 1] : undefined;
  if (previous?.status === "completed" && previous.phase_commit_sha) {
    if (current.base_commit_sha && current.base_commit_sha !== previous.phase_commit_sha) {
      throw new Error(`Current phase base ${current.base_commit_sha} does not continue previous completion commit ${previous.phase_commit_sha}.`);
    }
    if (!current.base_commit_sha && head !== previous.phase_commit_sha) {
      throw new Error(`Resume HEAD ${head} does not equal previous completion commit ${previous.phase_commit_sha}.`);
    }
  }
  if (current.base_commit_sha && head !== current.base_commit_sha) {
    throw new Error(`Resume HEAD ${head} does not equal current phase base ${current.base_commit_sha}.`);
  }
  if (!current.base_commit_sha && current.review_rounds > 0) {
    throw new Error("Current phase has persisted review rounds but no phase base commit.");
  }

  const changed = await git.changedPaths();
  if (!current.base_commit_sha && changed.length > 0) {
    throw new Error("A phase without a persisted base commit must resume from a clean worktree.");
  }
  const outOfScope = changed.filter((path) => !isPathAllowed(path, phase.acceptance.scope.allowed_paths));
  if (outOfScope.length > 0) {
    throw new Error(`Resume checkpoint has out-of-scope changes for ${current.phase_id}: ${outOfScope.join(", ")}.`);
  }
}

/**
 * Persist the round-limit checkpoint as resumable once a human-approved settings change
 * raised `review_round_limit` above the rounds the current phase already consumed. The
 * pause keeps its `MAX_REVIEW_ROUNDS` code because that is what stopped the run; only
 * its resumability is recomputed for the raised limit, so the existing paused run can
 * continue without hand-edited state or a new run.
 */
export async function acknowledgeRoundLimitResume(pkgRoot: string, state: WorkflowState): Promise<boolean> {
  const pause = state.pause;
  const current = state.phases.find((phase) => phase.status !== "completed");
  if (!pause || !current || pause.resumable) return false;
  const limit = state.review_round_limit ?? DEFAULT_MAX_REVIEW_ROUNDS;
  if (!roundLimitResumeAllowed(pause.code, current.review_rounds, limit)) return false;
  state.pause = {
    ...pause,
    resumable: true,
    detail: `${pause.detail ? `${pause.detail} ` : ""}Review round limit raised to ${limit}; the remaining rounds may continue.`,
  };
  state.pause_reason = formatPauseReason(state.pause);
  await writeWorkflowState(pkgRoot, state);
  await appendRunEvent(pkgRoot, "workflow_round_limit_resumed", {
    run_id: state.run_id,
    code: pause.code,
    phase_id: current.phase_id,
    review_rounds: current.review_rounds,
    review_round_limit: limit,
  }).catch(() => undefined);
  return true;
}

/**
 * Controlled evidence re-verification for a repairable pause before resume. Only the exact
 * evidence class that failed is re-checked (currently the workspace symlink policy); the
 * caller still runs `verifyResumeCheckpoint` for identity/HEAD/index/scope. On success the
 * persisted pause becomes a resumable EVIDENCE_REPAIRED checkpoint; failure records
 * `workflow_repair_failed` and rethrows without touching the paused checkpoint.
 */
export async function repairResumeEvidence(
  pkgRoot: string,
  state: WorkflowState,
  git: GitWorkspace,
  code: string,
  options?: { signal?: AbortSignal; timeout?: number },
): Promise<void> {
  if (!pauseRepairable(code)) throw new Error(`Pause code ${code} is not repairable.`);
  const current = state.phases.find((phase) => phase.status !== "completed");
  try {
    await git.auditWorkspaceSymlinks(options);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await appendRunEvent(pkgRoot, "workflow_repair_failed", {
      run_id: state.run_id,
      code,
      current_phase: current?.phase_id ?? null,
      reason,
    }).catch(() => undefined);
    throw error;
  }
  const previous = state.pause;
  state.pause = createPauseRecord({
    code: REPAIR_VERIFIED_CODE,
    stage: previous?.stage ?? "unknown",
    summary: `Repair verified: ${code} evidence re-check passed.`,
    ...(previous?.phase_id !== undefined ? { phase_id: previous.phase_id } : {}),
    ...(previous?.round !== undefined ? { round: previous.round } : {}),
  });
  state.pause_reason = formatPauseReason(state.pause);
  await writeWorkflowState(pkgRoot, state);
  await appendRunEvent(pkgRoot, "workflow_repair_verified", {
    run_id: state.run_id,
    code,
    recovered_code: REPAIR_VERIFIED_CODE,
    current_phase: current?.phase_id ?? null,
  }).catch(() => undefined);
}

/** Human-facing pause summary used for the notification and timeline. */
function escalationSummary(state: WorkflowState, pause: PauseRecord): string {
  const phase = state.phases.find((entry) => entry.status !== "completed");
  const findings = phase?.unresolved_findings.map((finding) => finding.id).join(", ") || "none";
  const acceptanceFailures = phase?.acceptance_results
    ?.filter((result) => result.required && !result.passed)
    .map((result) => result.id).join(", ") || "none";
  const repairable = !pause.resumable && pauseRepairable(pause.code);
  return [
    `pi-plan-execute-auto paused run ${state.run_id} · ${pause.resumable ? "resumable interruption" : repairable ? "repair required (re-verified on resume)" : "requires human repair"}`,
    ...formatPauseDetails(pause),
    `Phase: ${phase?.phase_id ?? "none"} · round ${phase?.review_rounds ?? 0}`,
    `Unresolved findings: ${findings}`,
    `Acceptance failures: ${acceptanceFailures}`,
    ...(pause.resumable
      ? [`Resume: /plan-execute resume ${state.run_id}`]
      : repairable
        ? [`Repair & resume: /plan-execute resume ${state.run_id} (the reported evidence is re-verified first)`]
        : ["Resume is refused for this pause; restore the reported evidence first."]),
    `Diagnostics: ${pkgDiagnosticsPath(state)}`,
  ].join("\n");
}

function pkgDiagnosticsPath(state: WorkflowState): string {
  return join(state.package_dir, ".runtime", "events.jsonl");
}

/** Stable payload for the one-shot budget warning on the workflow timeline. */
export function budgetWarningEvent(runId: string, timeoutMs: number): Record<string, unknown> {
  return {
    run_id: runId,
    timeout_ms: timeoutMs,
    warning_after_ms: Math.round(timeoutMs * BUDGET_WARNING_RATIO),
    message: `Execution & Review consumed ${Math.round(BUDGET_WARNING_RATIO * 100)}% of its ${formatStageTimeout(timeoutMs)} budget.`,
  };
}

/**
 * Stable schema for the persisted pause event. Kept pure so the timeline
 * contract (code/stage/resumability/elapsed budget) is unit-testable without a
 * full Stage B run.
 */
export function workflowPausedEvent(state: WorkflowState, pause: PauseRecord): Record<string, unknown> {
  const current = state.phases.find((phase) => phase.status !== "completed");
  return {
    run_id: state.run_id,
    code: pause.code,
    summary: pause.summary,
    detail: pause.detail ?? null,
    stage: pause.stage,
    resumable: pause.resumable,
    timeout_ms: pause.timeout_ms ?? null,
    elapsed_ms: pause.elapsed_ms ?? null,
    reason: state.pause_reason,
    phase_id: current?.phase_id ?? pause.phase_id ?? null,
    review_rounds: current?.review_rounds ?? pause.round ?? 0,
    executor_session_id: current?.executor_session_id ?? null,
    reviewer_session_id: current?.reviewer_session_id ?? null,
    execution_report_path: current?.execution_report_path ?? null,
    review_report_path: current?.review_report_path ?? null,
    acceptance_report_path: current?.acceptance_report_path ?? null,
  };
}

/**
 * Durable phase-completion entry payload. Emitted once per `reviewer_status:
 * "pass"` status event (the commit emit) so the session history records
 * `Phase 2/4 finished` even when the live widget is missed. Start transitions
 * stay widget-only to avoid transcript noise.
 */
export function phaseCompletedEntry(
  event: StageBStatusEvent,
  state: WorkflowState,
): Record<string, unknown> | undefined {
  if (event.reviewer_status !== "pass" || !event.plan) return undefined;
  const index = event.plan.phase_ids.indexOf(event.phase_id);
  if (index < 0) return undefined;
  const phase = state.phases.find((entry) => entry.phase_id === event.phase_id);
  return {
    run_id: state.run_id,
    phase_id: event.phase_id,
    phase_index: index + 1,
    phase_total: event.plan.phase_ids.length,
    review_rounds: phase?.review_rounds ?? event.round,
    commit: phase?.phase_commit_sha ?? null,
    committed_at: phase?.committed_at ?? new Date().toISOString(),
  };
}

async function persistAndEscalatePause(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  pkg: Awaited<ReturnType<typeof loadValidatedRun>>["package"],
  state: WorkflowState,
  pause: PauseRecord,
): Promise<StageBRunResult> {
  state.status = "paused";
  state.pause = pause;
  state.pause_reason = formatPauseReason(pause);
  const current = state.phases.find((phase) => phase.status !== "completed");
  if (current) {
    current.status = "paused";
    current.last_error = state.pause_reason;
  }
  await writeWorkflowState(pkg.root, state);
  await appendRunEvent(pkg.root, "workflow_paused", workflowPausedEvent(state, pause)).catch(() => undefined);
  await captureCurrentMainPiSession(ctx, pkg.root);
  showWidget(ctx, stateLines(state));
  pi.appendEntry(STATE_ENTRY, state);
  notify(ctx, escalationSummary(state, pause), pause.resumable ? "warning" : "error");
  return { status: "paused", state, reason: state.pause_reason, pause };
}

export async function reconcilePersistedCompletions(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  pkg: Awaited<ReturnType<typeof loadValidatedRun>>["package"],
  state: WorkflowState,
  options?: { continueAfterRecovery?: boolean },
): Promise<StageBRunResult | undefined> {
  if (!state.worktree_path || !state.branch_name) return undefined;
  validateControlledEnvironmentPaths(state);
  const targetGit = createPiGitOperations(pi, state.worktree_path);
  const target = new GitWorkspace(targetGit, {
    cwd: state.worktree_path,
    dedicatedBranch: state.branch_name,
    dedicatedWorktreePath: state.worktree_path,
  });
  await target.assertDedicatedIdentity();

  const recovered: Array<{
    phase: WorkflowState["phases"][number];
    relative: string;
    evidence: Awaited<ReturnType<typeof validatePhaseCompletionRecord>>;
  }> = [];
  let gap = false;
  let previousCommit: string | undefined;
  for (const phase of state.phases) {
    const relative = completionRecordRelativePath(phase.phase_id);
    const path = join(pkg.root, ...relative.split("/"));
    let exists = true;
    try {
      await access(path);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") exists = false;
      else throw error;
    }
    if (!exists) {
      gap = true;
      continue;
    }
    if (gap) throw new Error(`Completion record exists after a missing earlier phase: ${phase.phase_id}.`);
    const phasePackage = pkg.phases.find((entry) => entry.phase.id === phase.phase_id);
    if (!phasePackage) throw new Error(`Persisted completion phase is not in the frozen package: ${phase.phase_id}.`);
    const evidence = await validatePhaseCompletionRecord(
      pkg.root,
      phase.phase_id,
      state.package_hash,
      {
        ...(phase.base_commit_sha ? { base_commit_sha: phase.base_commit_sha } : {}),
        ...(phase.phase_commit_sha ? { phase_commit_sha: phase.phase_commit_sha } : {}),
        ...(phase.completion_record_sha256 ? { completion_record_sha256: phase.completion_record_sha256 } : {}),
        ...(phase.reviewed_diff_sha256 ? { reviewed_diff_sha256: phase.reviewed_diff_sha256 } : {}),
      },
      phasePackage.acceptance,
    );
    if (previousCommit && evidence.record.base_commit_sha !== previousCommit) {
      throw new Error(`Completion chain is broken before ${phase.phase_id}: expected base ${previousCommit}.`);
    }
    await target.verifyPhaseCommit(
      evidence.record.phase_commit_sha,
      evidence.record.base_commit_sha,
      phasePackage.phase.commit.message,
      evidence.record.final_diff_sha256,
      undefined,
      phaseEvidenceHashesForRecord(evidence.record),
    );
    recovered.push({ phase, relative, evidence });
    previousCommit = evidence.record.phase_commit_sha;
  }
  if (recovered.length === 0) return undefined;
  const head = await target.head();
  if (head !== previousCommit) {
    throw new Error(`Persisted completion chain expects HEAD ${previousCommit}, found ${head}.`);
  }
  for (const { phase, relative, evidence } of recovered) {
    phase.base_commit_sha = evidence.record.base_commit_sha;
    phase.phase_commit_sha = evidence.record.phase_commit_sha;
    phase.committed_at = evidence.record.committed_at;
    phase.review_rounds = evidence.record.review_rounds;
    phase.execution_report_path = evidence.record.execution_report_path;
    phase.review_report_path = evidence.record.review_report_path;
    phase.acceptance_report_path = evidence.record.acceptance_report_path;
    phase.acceptance_results = evidence.record.acceptance_results;
    phase.completion_record_path = relative;
    phase.completion_record_sha256 = evidence.recordSha256;
    phase.final_diff_path = evidence.record.final_diff_path;
    phase.final_diff_sha256 = evidence.record.final_diff_sha256;
    phase.reviewed_diff_sha256 = evidence.record.reviewed_diff_sha256;
    phase.status = "completed";
  }
  if (state.phases.every((phase) => phase.status === "completed")) {
    state.status = "completed";
    state.completed_at ??= new Date().toISOString();
    await writeWorkflowState(pkg.root, state);
    return { status: "completed", state };
  }
  if (options?.continueAfterRecovery) {
    await writeWorkflowState(pkg.root, state);
    await appendRunEvent(pkg.root, "completion_reconciled_for_resume", {
      run_id: state.run_id,
      recovered_phases: recovered.map(({ phase }) => phase.phase_id),
      next_phase: state.phases.find((phase) => phase.status !== "completed")?.phase_id ?? null,
    }).catch(() => undefined);
    return undefined;
  }
  return persistAndEscalatePause(
    pi,
    ctx,
    pkg,
    state,
    createPauseRecord({
      code: "PROCESS_RESTART_RECONCILED",
      stage: "setup",
      summary: "Immutable completion evidence was reconciled, but the next phase cannot safely resume without its original AgentPrism session.",
    }),
  );
}

/**
 * Decide whether Execution & Review may start for this persisted state.
 *
 * A paused (or orphaned running) run may continue ONLY through an explicit,
 * eligibility-checked resume: the plan-approval guard was written for
 * `/plan-execute start` and must not reject a valid resume checkpoint. A frozen
 * run that already carries execution evidence still requires the explicit
 * resume path instead of silently restarting.
 */
export function stageBStartDisposition(
  state: WorkflowState,
  resumeApproved: boolean,
): "start" | "restart_required" | "plan_not_approved" {
  if (resumeApproved && (state.status === "paused" || state.status === "running")) return "start";
  if (state.status !== "frozen") return "plan_not_approved";
  const hasExecutionEvidence = state.phases.some(
    (phase) => phase.status === "running" || phase.review_rounds > 0 || Boolean(phase.executor_session_id),
  );
  return hasExecutionEvidence ? "restart_required" : "start";
}

async function startStageB(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runId: string,
  options?: {
    executorModel?: string;
    reviewerModel?: string;
    signal?: AbortSignal;
    resume?: boolean;
  },
): Promise<StartResult> {
  let loaded: Awaited<ReturnType<typeof loadValidatedRun>>;
  try {
    loaded = await loadValidatedRun(ctx.cwd, runId);
  } catch (error) {
    // A persisted evidence failure is itself a paused run, not a reason to silently continue.
    try {
      const root = packageRoot(ctx.cwd, runId);
      const validation = await validatePackageDirectory(root);
      const persisted = await readWorkflowState(root);
      if (validation.package && persisted && persisted.run_id === runId) {
        return persistAndEscalatePause(
          pi,
          ctx,
          validation.package,
          persisted,
          createPauseRecord({
            code: "STARTUP_EVIDENCE",
            stage: "setup",
            summary: "Startup evidence validation failed.",
            ...(error instanceof Error ? { detail: error.message } : {}),
          }),
        );
      }
    } catch {
      // Preserve the original load error when the package/state cannot itself be recovered.
    }
    throw error;
  }
  const { package: pkg, state } = loaded;
  if (activeRuns.has(runId)) return { status: "not_started", state, reason: `Run ${runId} is already active.` };
  const expectedWorktreePath = resolve(dirname(ctx.cwd), ".pi-plan-execute-auto-worktrees", runId);
  const expectedBranchName = `pi-plan-execute-auto/${runId}`;
  if (
    (state.worktree_path && state.worktree_path !== expectedWorktreePath) ||
    (state.branch_name && state.branch_name !== expectedBranchName)
  ) {
    return persistAndEscalatePause(
      pi,
      ctx,
      pkg,
      state,
      createPauseRecord({
        code: "WORKTREE_IDENTITY_MISMATCH",
        stage: "setup",
        summary: "Persisted dedicated worktree identity is not the run-scoped plugin identity.",
      }),
    );
  }
  if (state.status === "completed") {
    try {
      const verified = await reconcilePersistedCompletions(pi, ctx, pkg, state);
      if (verified) return verified;
      throw new Error("Completed workflow has no verifiable dedicated worktree completion chain.");
    } catch (error) {
      return persistAndEscalatePause(
        pi,
        ctx,
        pkg,
        state,
        createPauseRecord({
          code: "COMPLETION_GIT_EVIDENCE",
          stage: "commit",
          summary: "Completed workflow has no verifiable dedicated worktree completion chain.",
          ...(error instanceof Error ? { detail: error.message } : {}),
        }),
      );
    }
  }
  const resumeRequested = options?.resume === true;
  if (state.status === "paused" && !resumeRequested) {
    return {
      status: "paused",
      state,
      reason: `${state.pause_reason ?? "Run is paused."} Use /plan-execute resume ${runId} for an explicit safe-resume attempt.`,
    };
  }
  if (state.status === "running" && !resumeRequested) {
    if (activeRuns.has(runId)) return { status: "not_started", state, reason: `Run ${runId} is already active.` };
    try {
      const reconciled = await reconcilePersistedCompletions(pi, ctx, pkg, state);
      if (reconciled) return reconciled;
    } catch (error) {
      return persistAndEscalatePause(pi, ctx, pkg, state, createPauseRecord({
        code: "PROCESS_RESTART_EVIDENCE",
        stage: "commit",
        summary: "Completion evidence could not be reconciled after a process restart.",
        ...(error instanceof Error ? { detail: error.message } : {}),
      }));
    }
    return persistAndEscalatePause(pi, ctx, pkg, state, createPauseRecord({
      code: "PROCESS_RESTART",
      stage: "setup",
      summary: "The previous Pi process ended while this run was active.",
      detail: `Use /plan-execute resume ${runId} to rebuild fresh ACP sessions from the persisted checkpoint.`,
    }));
  }
  let resumeApproved = false;
  if (resumeRequested) {
    if (activeRuns.has(runId)) return { status: "not_started", state, reason: `Run ${runId} is already active.` };
    try {
      const reconciled = await reconcilePersistedCompletions(pi, ctx, pkg, state, { continueAfterRecovery: true });
      if (reconciled) {
        presentRunState(ctx, reconciled.state);
        pi.appendEntry(STATE_ENTRY, reconciled.state);
        return reconciled;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await appendRunEvent(pkg.root, "workflow_resume_rejected", {
        run_id: runId,
        reason,
        pause_reason: state.pause_reason ?? null,
        stage: "completion-reconciliation",
      }).catch(() => undefined);
      return { status: "not_started", state, reason: `Resume completion evidence verification failed: ${reason}` };
    }
    const eligibility = evaluateResumeEligibility(state, { allowOrphanedRunning: true });
    if (!eligibility.ok) {
      await appendRunEvent(pkg.root, "workflow_resume_rejected", {
        run_id: runId,
        reason: eligibility.reason,
        pause_reason: state.pause_reason ?? null,
      }).catch(() => undefined);
      return { status: "not_started", state, reason: `Resume refused: ${eligibility.reason}` };
    }
    await acknowledgeRoundLimitResume(pkg.root, state);
    resumeApproved = true;
  }
  const disposition = stageBStartDisposition(state, resumeApproved);
  if (disposition === "restart_required") {
    return persistAndEscalatePause(
      pi,
      ctx,
      pkg,
      state,
      createPauseRecord({
        code: "PROCESS_RESTART",
        stage: "setup",
        summary: `Frozen run ${runId} contains persisted execution evidence from an interrupted process.`,
        detail: `Use /plan-execute resume ${runId} after it is marked paused.`,
      }),
    );
  }
  if (disposition === "plan_not_approved") {
    return { status: "not_started", state, reason: `Run is ${state.status}; its plan must be approved before Execution & Review can start.` };
  }

  let profile: ProjectPluginProfile | undefined;
  try {
    profile = await loadProjectPluginProfile(ctx.cwd);
  } catch (error) {
    return { status: "not_started", state, reason: `Project setup is invalid: ${error instanceof Error ? error.message : String(error)}` };
  }
  let executorModel: string;
  let reviewerModel: string;
  let configuredReasoningEffort: ReasoningEffort | undefined;
  let configuredExecutorEffort: ReasoningEffort | undefined;
  let configuredReviewerEffort: ReasoningEffort | undefined;
  let configuredPermissionMode: AgentPermissionMode;
  let configuredReviewRoundLimit: number;
  if (profile) {
    const mismatches = frozenProfileMismatch(state, profile, options?.executorModel, options?.reviewerModel);
    if (mismatches.length > 0) {
      return {
        status: "not_started",
        state,
        reason: [
          "Frozen run settings differ from the human-approved project setup; use a new run or restore the approved setup.",
          ...mismatches.map((entry) => `- ${entry}`),
        ].join("\n"),
      };
    }
    executorModel = profile.executorModel;
    reviewerModel = profile.reviewerModel;
    configuredReasoningEffort = profile.reasoningEffort;
    configuredExecutorEffort = profile.executorReasoningEffort;
    configuredReviewerEffort = profile.reviewerReasoningEffort;
    configuredPermissionMode = profile.permissionMode;
    configuredReviewRoundLimit = profile.reviewRoundLimit;
  } else {
    if (ctx.hasUI) return { status: "not_started", state, reason: "Run /plan-execute setup to select and approve both ACP models for this project." };
    const envExecutor = process.env.PI_PLAN_EXECUTE_EXECUTOR_MODEL;
    const envReviewer = process.env.PI_PLAN_EXECUTE_REVIEWER_MODEL;
    if (!envExecutor || !envReviewer) {
      return { status: "not_started", state, reason: "Headless Execution & Review requires explicit PI_PLAN_EXECUTE_EXECUTOR_MODEL and PI_PLAN_EXECUTE_REVIEWER_MODEL." };
    }
    if ((state.executor_model && state.executor_model !== envExecutor) || (state.reviewer_model && state.reviewer_model !== envReviewer) ||
      (options?.executorModel && options.executorModel !== envExecutor) || (options?.reviewerModel && options.reviewerModel !== envReviewer)) {
      return { status: "not_started", state, reason: "Frozen run models do not match the explicit headless model selection." };
    }
    executorModel = envExecutor;
    reviewerModel = envReviewer;
    try {
      configuredReasoningEffort = selectStageBReasoningEffort(process.env.PI_PLAN_EXECUTE_REASONING_EFFORT);
      configuredExecutorEffort = selectStageBReasoningEffort(process.env.PI_PLAN_EXECUTE_EXECUTOR_REASONING_EFFORT);
      configuredReviewerEffort = selectStageBReasoningEffort(process.env.PI_PLAN_EXECUTE_REVIEWER_REASONING_EFFORT);
      if (configuredReasoningEffort && (configuredExecutorEffort || configuredReviewerEffort)) {
        throw new Error("Headless reasoning effort must use either the legacy shared variable or the per-role variables, not both.");
      }
      const permissionMode = process.env.PI_PLAN_EXECUTE_PERMISSION_MODE ?? "autonomous";
      if (permissionMode !== "autonomous" && permissionMode !== "ask") {
        throw new Error("PI_PLAN_EXECUTE_PERMISSION_MODE must be autonomous or ask.");
      }
      configuredPermissionMode = permissionMode;
      const reviewLimit = Number(process.env.PI_PLAN_EXECUTE_MAX_REVIEW_ROUNDS ?? DEFAULT_MAX_REVIEW_ROUNDS);
      if (!Number.isInteger(reviewLimit) || reviewLimit < 1 || reviewLimit > 100) {
        throw new Error("PI_PLAN_EXECUTE_MAX_REVIEW_ROUNDS must be an integer from 1 to 100.");
      }
      configuredReviewRoundLimit = reviewLimit;
      requireAcpNetworkRiskAcknowledgement();
    } catch (error) {
      return { status: "not_started", state, reason: error instanceof Error ? error.message : String(error) };
    }
    if (
      state.reasoning_effort !== configuredReasoningEffort ||
      state.executor_reasoning_effort !== configuredExecutorEffort ||
      state.reviewer_reasoning_effort !== configuredReviewerEffort ||
      state.permission_mode !== configuredPermissionMode ||
      state.review_round_limit !== configuredReviewRoundLimit
    ) {
      return { status: "not_started", state, reason: "Frozen run execution settings differ from the explicit headless settings." };
    }
  }
  try {
    supportedBackendForModel(executorModel);
    supportedBackendForModel(reviewerModel);
    await defaultIsolationProvider.preflight();
  } catch (error) {
    return { status: "not_started", state, reason: `[SANDBOX_UNAVAILABLE] ${error instanceof Error ? error.message : String(error)}` };
  }
  const effectiveStageTimeoutMs = stageTimeoutMs(profile);
  // Git/worktree provisioning must still have a bound when the whole run is unlimited.
  const operationTimeoutMs = effectiveStageTimeoutMs > 0 ? effectiveStageTimeoutMs : DEFAULT_STAGE_TIMEOUT_MS;
  state.executor_model = executorModel;
  state.reviewer_model = reviewerModel;
  if (configuredReasoningEffort) state.reasoning_effort = configuredReasoningEffort;
  if (configuredExecutorEffort) state.executor_reasoning_effort = configuredExecutorEffort;
  if (configuredReviewerEffort) state.reviewer_reasoning_effort = configuredReviewerEffort;
  state.permission_mode = configuredPermissionMode;
  state.review_round_limit = configuredReviewRoundLimit;
  state.stage_timeout_ms = effectiveStageTimeoutMs;

  const linked = linkedAbortSignal(options?.signal ?? ctx.signal, effectiveStageTimeoutMs);
  const active: ActiveRun = { controller: new AbortController(), startedAt: new Date().toISOString() };
  const relay = () => linked.controller.abort(active.controller.signal.reason ?? {
    kind: "session_abort",
    message: "Execution & Review was interrupted while stopping the run.",
  } satisfies StageBAbortReason);
  active.controller.signal.addEventListener("abort", relay, { once: true });
  trackActiveRun(runId, active);
  let harness: AgentPrismSessionPair | undefined;
  // Animated Stage B activity widget: spinner + real ACP stream liveness.
  const activity = new StageBActivityModel();
  activity.setRunId(runId);
  activity.setPlan({
    phase_ids: pkg.phases.map((entry) => entry.phase.id),
    phase_statuses: state.phases.map((phase) => phase.status),
    current_index: state.phases.findIndex((phase) => phase.status !== "completed"),
    review_round_limit: state.review_round_limit ?? DEFAULT_MAX_REVIEW_ROUNDS,
  });
  activity.setBudget(Date.now(), effectiveStageTimeoutMs);
  const budgetWarning = effectiveStageTimeoutMs > 0
    ? setTimeout(() => {
        void appendRunEvent(pkg.root, "stage_budget_warning", budgetWarningEvent(runId, effectiveStageTimeoutMs)).catch(() => undefined);
      }, Math.round(effectiveStageTimeoutMs * BUDGET_WARNING_RATIO))
    : undefined;
  budgetWarning?.unref();
  try {
    validateControlledEnvironmentPaths(state);
    const sourceGit = createPiGitOperations(pi, ctx.cwd);
    const worktreePath = state.worktree_path ?? expectedWorktreePath;
    const branchName = state.branch_name ?? expectedBranchName;
    const targetGit = createPiGitOperations(pi, worktreePath);
    const dedicated = await ensureDedicatedWorktree(sourceGit, {
      sourceCwd: ctx.cwd,
      runId,
      runtimeRoot: `.pi-plan-execute-auto/${runId}`,
      targetPath: worktreePath,
      branchName,
      targetGit,
      ...((state.worktree_path && state.branch_name) ? { existing: { path: state.worktree_path, branchName: state.branch_name } } : {}),
      signal: linked.signal,
      timeout: operationTimeoutMs,
    });
    state.branch_name = dedicated.branchName;
    state.worktree_path = dedicated.path;
    state.controlled_environment_paths = await provisionDedicatedEnvironment(
      ctx.cwd,
      dedicated.path,
      undefined,
      { signal: linked.signal, timeout: operationTimeoutMs },
    );
    await writeWorkflowState(pkg.root, state);

    const git = new GitWorkspace(targetGit, {
      cwd: dedicated.path,
      runtimeRoot: `.pi-plan-execute-auto/${runId}`,
      dedicatedBranch: dedicated.branchName,
      dedicatedWorktreePath: dedicated.path,
    });
    if (resumeRequested) {
      const eligibility = evaluateResumeEligibility(state, { allowOrphanedRunning: true });
      if (!eligibility.ok) return { status: "not_started", state, reason: `Resume refused: ${eligibility.reason}` };
      let resumeCode = eligibility.code;
      if (eligibility.repairRequired) {
        try {
          await repairResumeEvidence(pkg.root, state, git, eligibility.code, {
            signal: linked.signal,
            timeout: operationTimeoutMs,
          });
          resumeCode = REPAIR_VERIFIED_CODE;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return { status: "not_started", state, reason: `Repair verification failed: ${reason}` };
        }
      }
      try {
        await verifyResumeCheckpoint(pkg, state, git);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await appendRunEvent(pkg.root, "workflow_resume_rejected", {
          run_id: runId,
          code: resumeCode,
          current_phase: eligibility.currentPhase,
          reason,
          pause_reason: state.pause_reason ?? null,
        }).catch(() => undefined);
        return { status: "not_started", state, reason: `Resume checkpoint verification failed: ${reason}` };
      }
      await appendRunEvent(pkg.root, "workflow_resumed", {
        run_id: runId,
        from_status: state.status,
        resume_code: resumeCode,
        previous_pause_reason: state.pause_reason ?? null,
        current_phase: eligibility.currentPhase,
        review_rounds: state.phases.find((phase) => phase.phase_id === eligibility.currentPhase)?.review_rounds ?? 0,
        completed_phases: state.phases.filter((phase) => phase.status === "completed").length,
      }).catch(() => undefined);
    }
    // Some hosts (for example RPC mode) accept only string-array widgets and
    // ignore component factories; keep the previous static widget as fallback.
    let activityWidgetCreated = false;
    if (ctx.hasUI) {
      try {
        ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
          const widget = new StageBActivityWidget(tui, theme, activity);
          activityWidgetCreated = true;
          return widget;
        });
      } catch {
        activityWidgetCreated = false;
      }
    }
    const publishLiveEvent = (role: "executor" | "reviewer", event: string): void => {
      activity.startLive(runId, role, event);
      if (!activityWidgetCreated) showWidget(ctx, [`Execution & Review · ${runId}`, `${role} · ${event}`]);
    };
    const publishStatus = (event: StageBStatusEvent): void => {
      activity.applyStatus(event);
      const completed = phaseCompletedEntry(event, state);
      if (completed) pi.appendEntry(PHASE_ENTRY, completed);
      if (!activityWidgetCreated) {
        const progress = event.plan
          ? `${event.plan.phase_statuses.filter((status) => status === "completed").length}/${event.plan.phase_ids.length} phases · `
          : "";
        showWidget(ctx, [
          `Execution & Review · ${progress}${event.phase_id} · round ${event.round}`,
          ...(event.plan
            ? [formatPlanChecklist(event.plan, 160, { round: event.round, paused: Boolean(event.pause) })]
            : []),
          event.message,
        ]);
      }
    };
    const sessionPair = new AgentPrismSessionPair({
      cwd: dedicated.path,
      sourceRoot: ctx.cwd,
      goldenRoot: pkg.root,
      historyRootCommit: () => state.phases[0]?.base_commit_sha,
      executorModel,
      reviewerModel,
      ...(configuredReasoningEffort ? { reasoningEffort: configuredReasoningEffort } : {}),
      ...(configuredExecutorEffort ? { executorReasoningEffort: configuredExecutorEffort } : {}),
      ...(configuredReviewerEffort ? { reviewerReasoningEffort: configuredReviewerEffort } : {}),
      ...(profile ? { networkRiskApproved: true } : {}),
      ...(executorModel.startsWith("codex/")
        ? { executorMode: "agent" }
        : executorModel.startsWith("opencode/")
          ? { executorMode: "build" }
          : {}),
      permissionMode: configuredPermissionMode,
      runRoot: pkg.root,
      onPermissionChoice: async (role, request) => {
        if (!ctx.hasUI) return undefined;
        const tool = request.toolCall.title ?? request.toolCall.name ?? request.toolCall.toolCallId;
        const labels = request.options.map((option, index) => `${index + 1}. ${option.name} [${option.kind}]`);
        notify(
          ctx,
          `${role === "executor" ? "Executor" : "Reviewer"} requests permission for ${tool}. Choose exactly one option advertised by the active CLI.`,
          "warning",
        );
        const chosen = await ctx.ui.select(
          `${role === "executor" ? "Executor" : "Reviewer"} permission · ${tool}`,
          [...labels, "Cancel / deny"],
        );
        const index = labels.indexOf(chosen ?? "");
        return index >= 0 ? request.options[index]?.optionId : undefined;
      },
      onLiveEvent: (role, event) => {
        publishLiveEvent(role, event);
      },
    });
    harness = sessionPair;
    const controller = new StageBController({
      package: pkg,
      state,
      git,
      acceptanceRunner: makeAcceptanceRunner(
        dedicated.path,
        ctx.cwd,
        pkg.root,
        () => state.phases[0]?.base_commit_sha,
      ),
      harness: sessionPair,
      signal: linked.signal,
      acceptanceTimeoutMs: acceptanceTimeoutMs(),
      requireDedicatedWorktree: true,
      resumePaused: resumeRequested,
      saveState: (next) => writeWorkflowState(pkg.root, next),
      onStatus: (event) => {
        publishStatus(event);
        void appendRunEvent(pkg.root, "workflow_status", event as unknown as Record<string, unknown>).catch(() => undefined);
      },
    });
    // Registry cancellation has already been relayed into the signal consumed by ACP and commands.
    let result: StageBRunResult;
    try {
      result = await controller.run();
    } catch (error) {
      return persistAndEscalatePause(
        pi,
        ctx,
        pkg,
        state,
        createPauseRecord({
          code: "EXECUTION_UNHANDLED",
          stage: "unknown",
          summary: "Execution & Review stopped with an unhandled error.",
          ...(error instanceof Error ? { detail: error.message } : {}),
        }),
      );
    }
    if (result.status === "paused") {
      return persistAndEscalatePause(
        pi,
        ctx,
        pkg,
        result.state,
        result.pause ?? result.state.pause ?? createPauseRecord({
          code: "ABORTED",
          stage: "unknown",
          summary: result.reason ?? "Execution & Review paused.",
        }),
      );
    }
    presentRunState(ctx, result.state);
    pi.appendEntry(STATE_ENTRY, result.state);
    return result;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "SOURCE_WORKTREE_DIRTY" || error.code === "WORKTREE_PATH_EXISTS" || error.code === "HARNESS_STAGED_CHANGES") &&
      !state.worktree_path
    ) {
      const reason = error.message;
      await appendRunEvent(pkg.root, "start_blocked", { code: error.code, reason }).catch(() => undefined);
      showWidget(ctx, stateLines(state));
      return { status: "not_started", state, reason };
    }
    return persistAndEscalatePause(pi, ctx, pkg, state, createPauseRecord({
      code: "WORKTREE_SETUP",
      stage: "setup",
      summary: "Dedicated worktree/environment setup failed.",
      ...(error instanceof Error ? { detail: error.message } : {}),
    }));
  } finally {
    activity.stop();
    clearTimeout(budgetWarning);
    untrackActiveRun(runId);
    active.controller.abort();
    active.controller.signal.removeEventListener("abort", relay);
    linked.dispose();
    await harness?.close();
  }
}

function packageInput(params: FinalizeParams, reviewRoundLimit?: number): FinalizeInput {
  const manifest: Manifest = {
    version: params.manifest.version as 1,
    documents: params.manifest.documents ?? [],
    phases: params.manifest.phases as Manifest["phases"],
  };
  manifest.max_review_rounds = reviewRoundLimit ?? params.manifest.max_review_rounds ?? DEFAULT_MAX_REVIEW_ROUNDS;
  return {
    manifest,
    files: params.files,
    ...(params.approval ? { approval: params.approval } : {}),
    ...(params.executor_model ? { executor_model: params.executor_model } : {}),
    ...(params.reviewer_model ? { reviewer_model: params.reviewer_model } : {}),
  };
}

function errorDetails(error: unknown): { text: string; details: Record<string, unknown> } {
  if (error instanceof PackageInputError || error instanceof PackageValidationError) {
    return {
      text: `${error.message}\n${formatValidationIssues(error.issues)}`,
      details: { ok: false, errors: error.issues },
    };
  }
  const text = error instanceof Error ? error.message : String(error);
  return { text, details: { ok: false, error: text } };
}

export async function approvedSetup(
  cwd: string,
  hasUI: boolean,
  requested?: { executor_model?: string; reviewer_model?: string },
  agentDir?: string,
): Promise<{
  executorModel: string;
  reviewerModel: string;
  reasoningEffort?: ReasoningEffort;
  executorReasoningEffort?: ReasoningEffort;
  reviewerReasoningEffort?: ReasoningEffort;
  permissionMode: AgentPermissionMode;
  reviewRoundLimit: number;
  profile?: ProjectPluginProfile;
}> {
  const profile = await loadProjectPluginProfile(cwd, agentDir);
  if (profile) {
    if ((requested?.executor_model && requested.executor_model !== profile.executorModel) ||
      (requested?.reviewer_model && requested.reviewer_model !== profile.reviewerModel)) {
      throw new Error("Model-supplied ACP routes differ from the user's saved setup. Run /plan-execute setup if you want to change models.");
    }
    return {
      executorModel: profile.executorModel,
      reviewerModel: profile.reviewerModel,
      ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
      ...(profile.executorReasoningEffort ? { executorReasoningEffort: profile.executorReasoningEffort } : {}),
      ...(profile.reviewerReasoningEffort ? { reviewerReasoningEffort: profile.reviewerReasoningEffort } : {}),
      permissionMode: profile.permissionMode,
      reviewRoundLimit: profile.reviewRoundLimit,
      profile,
    };
  }
  if (hasUI) throw new Error("Run /plan-execute setup first to choose ACP models and approve this project's network risk.");
  const executorModel = process.env.PI_PLAN_EXECUTE_EXECUTOR_MODEL;
  const reviewerModel = process.env.PI_PLAN_EXECUTE_REVIEWER_MODEL;
  if (!executorModel || !reviewerModel || (requested?.executor_model && requested.executor_model !== executorModel) ||
    (requested?.reviewer_model && requested.reviewer_model !== reviewerModel)) {
    throw new Error("Headless automation requires explicit, matching PI_PLAN_EXECUTE_EXECUTOR_MODEL and PI_PLAN_EXECUTE_REVIEWER_MODEL.");
  }
  supportedBackendForModel(executorModel);
  supportedBackendForModel(reviewerModel);
  requireAcpNetworkRiskAcknowledgement();
  const reasoningEffort = selectStageBReasoningEffort(process.env.PI_PLAN_EXECUTE_REASONING_EFFORT);
  const executorReasoningEffort = selectStageBReasoningEffort(process.env.PI_PLAN_EXECUTE_EXECUTOR_REASONING_EFFORT);
  const reviewerReasoningEffort = selectStageBReasoningEffort(process.env.PI_PLAN_EXECUTE_REVIEWER_REASONING_EFFORT);
  if (reasoningEffort && (executorReasoningEffort || reviewerReasoningEffort)) {
    throw new Error("Headless reasoning effort must use either the legacy shared variable or the per-role variables, not both.");
  }
  const permissionMode = process.env.PI_PLAN_EXECUTE_PERMISSION_MODE ?? "autonomous";
  if (permissionMode !== "autonomous" && permissionMode !== "ask") {
    throw new Error("PI_PLAN_EXECUTE_PERMISSION_MODE must be autonomous or ask.");
  }
  const reviewRoundLimit = Number(process.env.PI_PLAN_EXECUTE_MAX_REVIEW_ROUNDS ?? DEFAULT_MAX_REVIEW_ROUNDS);
  if (!Number.isInteger(reviewRoundLimit) || reviewRoundLimit < 1 || reviewRoundLimit > 100) {
    throw new Error("PI_PLAN_EXECUTE_MAX_REVIEW_ROUNDS must be an integer from 1 to 100.");
  }
  return {
    executorModel,
    reviewerModel,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(executorReasoningEffort ? { executorReasoningEffort } : {}),
    ...(reviewerReasoningEffort ? { reviewerReasoningEffort } : {}),
    permissionMode,
    reviewRoundLimit,
  };
}

type DraftReviewResult =
  | StartResult
  | { status: "started"; state: WorkflowState }
  | { status: "awaiting_approval"; state: WorkflowState }
  | { status: "revision_requested"; state: WorkflowState }
  | { status: "cancelled"; state: WorkflowState };

async function reviewDraftAndStart(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  pkg: Awaited<ReturnType<typeof loadValidatedRun>>["package"],
  selection: Awaited<ReturnType<typeof approvedSetup>>,
  explicitStartCommand = false,
  options?: { detach?: boolean },
): Promise<DraftReviewResult> {
  const current = await readWorkflowState(pkg.root);
  if (!current || current.status !== "draft") {
    throw new Error(`Run ${basenameForPrompt(pkg.root)} is no longer an editable draft.`);
  }
  const readiness = () => executionReadinessPreflight(
    pi,
    ctx,
    current.run_id,
    selection.executorModel,
    selection.reviewerModel,
  );
  let decision = await chooseApproval(ctx, pkg, selection.profile, current.plan_revision ?? 1, readiness);
  if (decision.kind === "pending" && explicitStartCommand) {
    await readiness();
    decision = { kind: "approve-start" };
  }
  if (decision.kind === "pending") return { status: "awaiting_approval", state: current };
  if (decision.kind === "cancel") {
    const cancelled = await cancelRun(pkg, current.run_id);
    await appendRunEvent(pkg.root, "plan_cancelled", { plan_revision: current.plan_revision ?? 1 }).catch(() => undefined);
    return { status: "cancelled", state: cancelled };
  }
  if (decision.kind === "request-changes") {
    await requestPlanRevision(pi, ctx, pkg, decision.feedback);
    return { status: "revision_requested", state: current };
  }

  const frozen = await freezeRun(pkg, current.run_id, {
    reviewedPackageHash: pkg.package_hash,
    executorModel: selection.executorModel,
    reviewerModel: selection.reviewerModel,
    ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
    ...(selection.executorReasoningEffort ? { executorReasoningEffort: selection.executorReasoningEffort } : {}),
    ...(selection.reviewerReasoningEffort ? { reviewerReasoningEffort: selection.reviewerReasoningEffort } : {}),
    permissionMode: selection.permissionMode,
    reviewRoundLimit: selection.reviewRoundLimit,
  });
  await appendRunEvent(pkg.root, "plan_approved", {
    package_hash: pkg.package_hash,
    plan_revision: frozen.plan_revision ?? current.plan_revision ?? 1,
    executor_model: selection.executorModel,
    reviewer_model: selection.reviewerModel,
    executor_reasoning_effort: selection.executorReasoningEffort ?? selection.reasoningEffort ?? "backend-default",
    reviewer_reasoning_effort: selection.reviewerReasoningEffort ?? selection.reasoningEffort ?? "backend-default",
    review_round_limit: selection.reviewRoundLimit,
    permission_mode: selection.permissionMode,
  }).catch(() => undefined);
  await captureCurrentMainPiSession(ctx, pkg.root);
  showWidget(ctx, stateLines(frozen));
  pi.appendEntry(STATE_ENTRY, frozen);
  const launch = () => startStageB(pi, ctx, current.run_id, { ...(ctx.signal ? { signal: ctx.signal } : {}) });
  if (options?.detach) {
    startStageBInBackground({
      start: launch,
      notify: (message, type) => notify(ctx, message, type),
      notStarted: (reason) => `Execution has not started: ${reason ?? "unknown reason"}\nFix the prerequisite and run /plan-execute start ${current.run_id} again.`,
    });
    return { status: "started", state: frozen };
  }
  return launch();
}

async function handleFinalize(
  ctx: ExtensionContext,
  params: FinalizeParams,
): Promise<ReturnType<typeof textResult>> {
  if (params.approval === "cancel") return textResult("Plan finalization cancelled.", { status: "cancelled" });
  try {
    const selection = await approvedSetup(ctx.cwd, ctx.hasUI, params);
    const input = packageInput(params, selection.reviewRoundLimit);
    // Execution identity belongs to the plugin, never to Main Pi/model output.
    // The timestamp keeps the id sortable; 64 bits of cryptographic entropy make
    // same-second and concurrent finalizations independent.
    const runId = makeRunId();
    const written = await writeValidatedPackage(ctx.cwd, input, runId);
    const draft = createDraftState(written.package, runId);
    await writeWorkflowState(written.package.root, draft);
    await appendRunEvent(written.package.root, "plan_draft_created", {
      package_hash: written.package.package_hash,
      plan_revision: 1,
      phases: written.package.phases.map((phase) => phase.phase.id),
    });
    await captureCurrentMainPiSession(ctx, written.package.root);
    showWidget(ctx, ["Plan Review & Approval", `Run ${runId} · revision 1`, `${written.package.phases.length} phases · ready for review`]);
    if (ctx.hasUI) {
      pendingHumanReviews.add(runId);
      await appendRunEvent(written.package.root, "plan_review_queued", {
        package_hash: written.package.package_hash,
        plan_revision: 1,
        source: "finalize",
      }).catch(() => undefined);
    }
    return textResult(
      ctx.hasUI
        ? `Draft plan ${runId} is validated. Human Review & Approval will open after this Main Pi turn completes.`
        : `Draft plan ${runId} is validated and awaiting human approval. Run /plan-execute start ${runId} in an interactive Pi session to review it.`,
      { status: "awaiting_approval", run_id: runId, package_hash: written.package.package_hash },
    );
  } catch (error) {
    const details = errorDetails(error);
    notify(ctx, details.text, "error");
    return textResult(details.text, details.details);
  }
}

async function handleRevise(
  ctx: ExtensionContext,
  params: ReviseParams,
): Promise<ReturnType<typeof textResult>> {
  try {
    const loaded = await loadValidatedRun(ctx.cwd, params.run_id);
    if (loaded.state.status !== "draft") {
      throw new Error(`Run ${params.run_id} is already ${loaded.state.status}; approved/running plans cannot be rewritten.`);
    }
    if (loaded.package.package_hash !== params.previous_package_hash) {
      throw new Error("The draft changed since the human revision request; reload the latest plan before revising it.");
    }
    const selection = await approvedSetup(ctx.cwd, ctx.hasUI);
    const input = packageInput(params as unknown as FinalizeParams, selection.reviewRoundLimit);
    const previousHash = loaded.package.package_hash;
    const written = await replaceValidatedDraftPackage(ctx.cwd, input, params.run_id, previousHash);
    const nextState = await readWorkflowState(written.package.root);
    if (!nextState) throw new Error("Revised draft state could not be reloaded.");
    await appendRunEvent(written.package.root, "plan_revised", {
      previous_package_hash: previousHash,
      package_hash: written.package.package_hash,
      plan_revision: nextState.plan_revision ?? 2,
    });
    await captureCurrentMainPiSession(ctx, written.package.root);
    showWidget(ctx, [
      "Plan Review & Approval",
      `Run ${params.run_id} · revision ${nextState.plan_revision ?? 2}`,
      `${written.package.phases.length} phases · revision validated · awaiting human review`,
    ]);
    if (ctx.hasUI) {
      pendingHumanReviews.add(params.run_id);
      await appendRunEvent(written.package.root, "plan_review_queued", {
        package_hash: written.package.package_hash,
        plan_revision: nextState.plan_revision ?? 2,
        source: "revise",
      }).catch(() => undefined);
    }
    return textResult(
      ctx.hasUI
        ? `Revised plan ${params.run_id} is validated. Human Review & Approval will reopen after this Main Pi turn completes.`
        : `Revised plan ${params.run_id} is validated and awaiting human approval.`,
      {
        status: "awaiting_approval",
        run_id: params.run_id,
        package_hash: written.package.package_hash,
        plan_revision: nextState.plan_revision ?? 2,
      },
    );
  } catch (error) {
    const details = errorDetails(error);
    notify(ctx, details.text, "error");
    return textResult(details.text, details.details);
  }
}

async function presentQueuedHumanReview(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runId: string,
): Promise<void> {
  const loaded = await loadValidatedRun(ctx.cwd, runId);
  if (loaded.state.status !== "draft") {
    await appendRunEvent(loaded.package.root, "plan_review_skipped", {
      reason: `state is ${loaded.state.status}`,
    }).catch(() => undefined);
    return;
  }
  const selection = await approvedSetup(ctx.cwd, ctx.hasUI);
  const result = await reviewDraftAndStart(pi, ctx, loaded.package, selection);
  if (result.status === "revision_requested") {
    notify(ctx, "Plan changes sent back to Main Pi. The next revised draft will return to Review & Approval.", "info");
    return;
  }
  if (result.status === "awaiting_approval") {
    notify(ctx, `Run ${runId} is awaiting human approval.`, "warning");
    return;
  }
  if (result.status === "cancelled") {
    notify(ctx, `Plan ${runId} cancelled before execution.`, "info");
    return;
  }
  if (result.status === "not_started") {
    notify(ctx, `Plan approved, but execution has not started: ${result.reason}\nFix the prerequisite and run /plan-execute start ${runId}.`, "warning");
    return;
  }
  if (result.status === "paused") {
    // persistAndEscalatePause already emitted the authoritative pause warning.
    return;
  }
  notify(ctx, `Execution & Review ${result.status} for ${runId}.`, "info");
}

async function drainQueuedHumanReview(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;
  const runId = pendingHumanReviews.values().next().value as string | undefined;
  if (!runId) return;
  pendingHumanReviews.delete(runId);
  try {
    await presentQueuedHumanReview(pi, ctx, runId);
  } catch (error) {
    notify(ctx, `Could not open Plan Review & Approval for ${runId}: ${error instanceof Error ? error.message : String(error)}\nThe draft remains reviewable with /plan-execute start ${runId}.`, "error");
  }
}

async function commandFinalize(pi: ExtensionAPI, ctx: ExtensionCommandContext, directive?: string): Promise<void> {
  try {
    await approvedSetup(ctx.cwd, ctx.hasUI);
    pi.sendUserMessage(buildFinalizePrompt(directive), { expandPromptTemplates: false });
  } catch (error) {
    notify(ctx, error instanceof Error ? error.message : String(error), "warning");
  }
}

async function commandStart(pi: ExtensionAPI, ctx: ExtensionCommandContext, runId: string): Promise<void> {
  try {
    const loaded = await loadValidatedRun(ctx.cwd, runId);
    if (loaded.state.status === "paused") {
      notify(ctx, `Run ${runId} is paused. Use /plan-execute resume ${runId} to explicitly rebuild fresh ACP sessions from the persisted checkpoint.`, "warning");
      return;
    }
    let result: DraftReviewResult | StartResult;
    if (loaded.state.status === "draft") {
      const selection = await approvedSetup(ctx.cwd, ctx.hasUI);
      result = await reviewDraftAndStart(pi, ctx, loaded.package, selection, true, { detach: true });
    } else {
      result = { status: "started", state: loaded.state };
      startStageBInBackground({
        start: () => startStageB(pi, ctx, runId, { ...(ctx.signal ? { signal: ctx.signal } : {}) }),
        notify: (message, type) => notify(ctx, message, type),
        notStarted: (reason) => `Execution has not started: ${reason ?? "unknown reason"}\nFix the prerequisite and run /plan-execute start ${runId} again.`,
      });
    }

    if (result.status === "revision_requested") {
      notify(ctx, "Plan changes sent back to Main Pi. The revised draft will reopen Review & Approval.", "info");
      return;
    }
    if (result.status === "awaiting_approval") {
      notify(ctx, `Run ${runId} is still awaiting human approval.`, "warning");
      return;
    }
    if (result.status === "cancelled") {
      notify(ctx, `Run ${runId} was cancelled before execution.`, "info");
      return;
    }
    if (result.status === "started") {
      notify(ctx, `Execution & Review is running in the background for ${runId}. Stop with /plan-execute stop ${runId} or ${STOP_SHORTCUT_LABEL}.`, "info");
      return;
    }
    if (result.status === "not_started") {
      notify(ctx, `Execution has not started: ${result.reason}\nFix the prerequisite and run /plan-execute start ${runId} again.`, "warning");
      return;
    }
    if (result.status === "paused") {
      // commandStart never enters from a paused state; newly-paused execution is
      // already reported by persistAndEscalatePause.
      return;
    }
    notify(ctx, `Execution & Review ${result.status}.`, "info");
  } catch (error) {
    notify(ctx, error instanceof Error ? error.message : String(error), "error");
  }
}

async function commandResume(pi: ExtensionAPI, ctx: ExtensionCommandContext, runId: string): Promise<void> {
  try {
    const loaded = await loadValidatedRun(ctx.cwd, runId);
    const eligibility = evaluateResumeEligibility(loaded.state, { allowOrphanedRunning: true });
    if (!eligibility.ok) {
      notify(ctx, `Run ${runId} cannot be safely resumed: ${eligibility.reason}`, "warning");
      return;
    }
    if (eligibility.repairRequired) {
      await appendRunEvent(loaded.package.root, "workflow_repair_requested", {
        run_id: runId,
        code: eligibility.code,
        current_phase: eligibility.currentPhase,
        pause_reason: loaded.state.pause_reason ?? null,
      }).catch(() => undefined);
    }
    await appendRunEvent(loaded.package.root, "workflow_resume_requested", {
      run_id: runId,
      from_status: loaded.state.status,
      resume_code: eligibility.code,
      current_phase: eligibility.currentPhase,
      pause_reason: loaded.state.pause_reason ?? null,
    }).catch(() => undefined);
    notify(
      ctx,
      `Resuming ${runId} from persisted checkpoint at ${eligibility.currentPhase}.${eligibility.repairRequired ? ` Repair verification re-checks the ${eligibility.code} evidence before the run continues.` : ""} Completed phases will be re-verified and skipped; fresh Executor/Reviewer ACP sessions will be created for unfinished work. Stop with /plan-execute stop ${runId} or ${STOP_SHORTCUT_LABEL}.`,
      "info",
    );
    startStageBInBackground({
      start: () => startStageB(pi, ctx, runId, {
        resume: true,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      }),
      notify: (message, type) => notify(ctx, message, type),
      notStarted: (reason) => reason ?? "Resume did not start.",
      completed: (result) => `Execution & Review completed after resume · ${result.state.run_id}${result.state.branch_name ? ` · branch ${result.state.branch_name}` : ""}.`,
    });
  } catch (error) {
    notify(ctx, error instanceof Error ? error.message : String(error), "error");
  }
}

function latestSessionId(state: WorkflowState, role: "executor" | "reviewer"): string | undefined {
  const key = role === "executor" ? "executor_session_id" : "reviewer_session_id";
  for (const phase of [...state.phases].reverse()) {
    const session = phase[key];
    if (typeof session === "string" && session) return session;
  }
  return undefined;
}

async function showDiagnosticPreview(
  ctx: ExtensionCommandContext,
  title: string,
  absolutePath: string,
  displayPath: string,
): Promise<void> {
  try {
    const raw = await readFile(absolutePath, "utf8");
    const maxBytes = 96 * 1024;
    const preview = Buffer.byteLength(raw) <= maxBytes
      ? raw
      : `[Preview shows the last ${maxBytes / 1024} KiB; the complete transcript is in ${displayPath}.]\n\n${Buffer.from(raw).subarray(-maxBytes).toString("utf8")}`;
    if (ctx.hasUI) {
      await ctx.ui.confirm(title, `${preview}\n\nComplete file: ${displayPath}`);
    } else {
      notify(ctx, `Complete file: ${displayPath}`, "info");
    }
  } catch (error) {
    notify(ctx, `Transcript is not available yet: ${displayPath}\n${error instanceof Error ? error.message : String(error)}`, "warning");
  }
}

async function commandStatus(ctx: ExtensionCommandContext, runId: string): Promise<void> {
  try {
    const status = await readRunStatus(ctx.cwd, runId);
    if (!status) {
      notify(ctx, `Unknown workflow ${runId}.`, "warning");
      return;
    }
    const root = packageRoot(ctx.cwd, runId);
    const state = await readWorkflowState(root);
    const resume = state ? evaluateResumeEligibility(state, { allowOrphanedRunning: true }) : undefined;
    const eventDisplay = join(".pi-plan-execute-auto", runId, ".runtime", "events.jsonl");
    const executorSession = state ? latestSessionId(state, "executor") : undefined;
    const reviewerSession = state ? latestSessionId(state, "reviewer") : undefined;
    const executorRelative = executorSession ? agentSessionTranscriptRelativePath("executor", executorSession) : undefined;
    const reviewerRelative = reviewerSession ? agentSessionTranscriptRelativePath("reviewer", reviewerSession) : undefined;
    const executorDisplay = executorRelative ? join(".pi-plan-execute-auto", runId, executorRelative) : undefined;
    const reviewerDisplay = reviewerRelative ? join(".pi-plan-execute-auto", runId, reviewerRelative) : undefined;

    notify(
      ctx,
      [
        `Run ${status.run_id}: ${status.status} · ${status.completed_phases}/${status.total_phases} phases${status.current_phase ? ` · current ${status.current_phase}` : ""}`,
        ...(state?.status === "paused"
          ? [state.pause ? `Pause: ${formatPauseHeadline(state.pause, resume?.ok ? { resumable: true } : undefined)}` : `Pause: ${status.pause_reason ?? "reason unavailable"}`]
          : []),
        `Workflow timeline: ${eventDisplay}`,
        ...(state?.status === "paused" || state?.status === "running"
          ? [resume?.ok
              ? resume.repairRequired
                ? `Resume: /plan-execute resume ${runId} (repair verification, checkpoint ${resume.currentPhase})`
                : `Resume: /plan-execute resume ${runId} (checkpoint ${resume.currentPhase})`
              : `Resume: blocked · ${resume?.reason ?? "state unavailable"}`]
          : []),
        ...(executorDisplay ? [`Latest Executor transcript: ${executorDisplay}`] : []),
        ...(reviewerDisplay ? [`Latest Reviewer transcript: ${reviewerDisplay}`] : []),
      ].join("\n"),
      "info",
    );

    if (!ctx.hasUI) return;
    const choices = [
      ...(executorDisplay ? ["Preview latest Executor transcript"] : []),
      ...(reviewerDisplay ? ["Preview latest Reviewer transcript"] : []),
      "Preview workflow timeline",
      "Close",
    ];
    const choice = await ctx.ui.select("Run diagnostics", choices);
    if (choice === "Preview latest Executor transcript" && executorRelative && executorDisplay) {
      await showDiagnosticPreview(ctx, "Latest Executor transcript", join(root, executorRelative), executorDisplay);
    } else if (choice === "Preview latest Reviewer transcript" && reviewerRelative && reviewerDisplay) {
      await showDiagnosticPreview(ctx, "Latest Reviewer transcript", join(root, reviewerRelative), reviewerDisplay);
    } else if (choice === "Preview workflow timeline") {
      await showDiagnosticPreview(ctx, "Workflow timeline", join(root, ".runtime", "events.jsonl"), eventDisplay);
    }
  } catch (error) {
    notify(ctx, error instanceof Error ? error.message : String(error), "error");
  }
}

async function commandStop(ctx: ExtensionCommandContext, runId: string): Promise<void> {
  if (!requestRunStop(runId, humanStopReason())) {
    notify(ctx, `Run ${runId} has no active Execution & Review session.`, "warning");
    return;
  }
  notify(ctx, `Stop requested for ${runId}; the workflow will pause without committing.`, "info");
}

export default function planExecuteAuto(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "plan_execute_finalize",
    label: "Create Draft Plan",
    description: "Write and structurally validate the current Main Pi planning context as a phased draft plan package.",
    promptSnippet: "Create a validated phased draft plan for human review",
    promptGuidelines: [
      "Use plan_execute_finalize only after the human explicitly invokes /plan-execute; it must contain at least one ordered phase.",
      "Do not invent, request, or provide a run_id. The plugin exclusively allocates the execution identity after validation.",
      "Each phase needs an independent spec file, acceptance YAML contract, and required plugin-owned completion commit.",
      "Do not approve/freeze the package or implement project code; the plugin owns the human revision/approval loop.",
      "After a successful finalize, keep the Main Pi handoff brief and do not restate the draft or ask for approval in chat.",
    ],
    parameters: FINALIZE_SCHEMA,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return handleFinalize(ctx, params);
    },
  });

  pi.registerTool({
    name: "plan_execute_revise",
    label: "Revise Draft Plan",
    description: "Atomically replace an existing draft plan after explicit human revision feedback, then reopen human review.",
    promptSnippet: "Regenerate the complete draft plan from human revision feedback",
    promptGuidelines: [
      "Use only for a draft run after the plugin sends a plan-execute-revision-request.",
      "Pass the exact run_id and previous_package_hash from that request.",
      "Regenerate the COMPLETE manifest and complete set of draft plan files; do not send a partial patch.",
      "Do not implement project code or approve the revised plan on the human's behalf.",
      "After a successful revision, keep the Main Pi handoff brief and let the plugin UI reopen review.",
    ],
    parameters: REVISE_SCHEMA,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return handleRevise(ctx, params);
    },
  });

  pi.registerCommand("plan-execute", {
    description: "Create/review a phased plan, optionally with an inline directive, or control its Execution & Review run",
    handler: async (args, ctx) => {
      const command = parsePlanExecuteCommand(args);
      if (command.kind === "finalize") return commandFinalize(pi, ctx, command.directive);
      if (command.kind === "setup") return commandSetup(ctx);
      if (command.kind === "settings") return commandSettings(ctx, command.runId);
      if (command.kind === "start") return commandStart(pi, ctx, command.runId);
      if (command.kind === "resume") return commandResume(pi, ctx, command.runId);
      if (command.kind === "stop") return commandStop(ctx, command.runId);
      if (command.kind === "status") return commandStatus(ctx, command.runId);
      notify(
        ctx,
        "Usage: /plan-execute [自然语言指令] | finalize [指令] | setup | settings [run-id] | start <run-id> | resume <run-id> | stop <run-id> | status <run-id>",
        "info",
      );
    },
  });

  // Emergency stop that works even while Pi's input loop is busy with a typed
  // start/resume command. Extension shortcuts are handled by the editor key
  // handler, not by the prompt queue.
  pi.registerShortcut(STOP_SHORTCUT, {
    description: "Stop the active plan-execute Execution & Review run",
    handler: (ctx) => {
      const stopped = stopAllActiveRuns(humanStopReason());
      notify(
        ctx,
        stopped.length > 0
          ? `Stop requested for ${stopped.join(", ")}; the workflow will pause without committing.`
          : "No active plan-execute Execution & Review run to stop.",
        stopped.length > 0 ? "info" : "warning",
      );
    },
  });

  pi.registerEntryRenderer(PHASE_ENTRY, (entry, _options, theme) => {
    const data = entry.data as Partial<{ phase_index: number; phase_total: number; phase_id: string; commit: string | null }>;
    const commit = typeof data.commit === "string" && data.commit ? ` · ${data.commit.slice(0, 8)}` : "";
    return new Text(
      theme.fg("success", `✓ Phase ${data.phase_index ?? "?"}/${data.phase_total ?? "?"} ${data.phase_id ?? "unknown"} committed${commit}`),
      0,
      0,
    );
  });

  pi.registerEntryRenderer(STATE_ENTRY, (entry, _options, theme) => {
    const data = entry.data as Partial<WorkflowState>;
    const status = data.status ?? "unknown";
    const runId = data.run_id ?? "unknown";
    const pause = status === "paused" ? data.pause : undefined;
    const label = pause
      ? `${status} · ${pause.code}${pause.resumable ? " (resumable)" : " (needs repair)"}`
      : status;
    const color = status === "completed" ? "success" : status === "paused" ? (pause && !pause.resumable ? "error" : "warning") : "accent";
    return new Text(theme.fg(color, `plan-execute ${runId}: ${label}`), 0, 0);
  });

  pi.on("session_start", (_event, ctx) => {
    const latest = [...ctx.sessionManager.getBranch()]
      .reverse()
      .find((entry) => entry.type === "custom" && entry.customType === STATE_ENTRY);
    if (latest && latest.type === "custom") {
      const state = latest.data as WorkflowState;
      // Completed/cancelled runs must not resurrect a pinned widget after a reload or restart.
      if (state && typeof state.run_id === "string" && (state.status === "paused" || state.status === "running")) {
        showWidget(ctx, stateLines(state));
      }
    }
  });

  // Human review must not run inside turn_end. Pi awaits turn_end boundary
  // handlers before the agent run can settle, so awaiting Review -> Stage B here
  // can hold the Main Pi final response behind a long Executor/Reviewer run.
  // agent_settled means the Main Pi run is fully finished; defer one event-loop
  // tick so the UI can commit the settled state before opening blocking review UI.
  pi.on("agent_settled", (_event, ctx) => {
    setTimeout(() => {
      void drainQueuedHumanReview(pi, ctx);
    }, 0);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    pendingHumanReviews.clear();
    clearWidget(ctx);
    const stopped = stopAllActiveRuns({ kind: "session_abort", message: "Pi session is shutting down." });
    if (stopped.length > 0) {
      // Pi awaits this handler, so give the in-flight pause persistence a short,
      // bounded chance to land. Without it a hard quit can leave the run marked
      // running for the next-start reconciliation instead of a clean pause.
      const deadline = Date.now() + 2_000;
      while (activeRunIds().length > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  });
}
