import { execFile as execFileCallback } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import {
  formatPackageSummary,
  formatValidationIssues,
  PackageInputError,
  PackageValidationError,
  readWorkflowState,
  validatePackageDirectory,
  writeValidatedPackage,
  writeWorkflowState,
} from "../src/package-validator.js";
import {
  cancelRun,
  createDraftState,
  formatStatus,
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
  loadProjectPluginProfile,
  normalizeSelectedModel,
  probeAcpConfiguration,
  probeAcpModels,
  verifyAcpModelCall,
  removeProjectPluginProfile,
  saveProjectPluginProfile,
  type AcpBackend,
  type DetectedCli,
  type ProjectPluginProfile,
} from "../src/plugin-config.js";
import { defaultIsolationProvider } from "../src/isolation-provider.js";
import { supportedBackendForModel } from "../src/sandbox.js";
import { ensureSetupRepository } from "../src/setup-repository.js";
import { StageBController } from "../src/stage-b.js";
import { DEFAULT_MAX_REVIEW_ROUNDS } from "../src/types.js";
import type {
  AcceptanceCommandRunner,
  AgentPermissionMode,
  FinalizeInput,
  Manifest,
  ReasoningEffort,
  StageBRunResult,
  WorkflowState,
} from "../src/types.js";

const execFile = promisify(execFileCallback);
const WIDGET_KEY = "pi-plan-execute-auto";
const STATE_ENTRY = "plan-execute-state";
const ESCALATION_MESSAGE = "plan-execute-escalation";
const DEFAULT_STAGE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_ACCEPTANCE_TIMEOUT_MS = 120 * 1000;
const REVIEW_ROUND_CHOICES = [3, 5, 8, 12, 20] as const;

function validateControlledEnvironmentPaths(state: WorkflowState): void {
  const paths = state.controlled_environment_paths ?? [];
  if (paths.some((path) => !CONTROLLED_ENVIRONMENT_PATHS.some((allowed) => allowed === path))) {
    throw new Error("Workflow contains an unapproved provisioned environment path.");
  }
}

const FINALIZE_PROMPT = [
  "The user explicitly invoked /plan-execute finalize.",
  "Use the complete current conversation and repository investigation context to call plan_execute_finalize.",
  "Create a Golden Document Package with at least one ordered phase. Every phase needs its own spec, acceptance YAML contract, and required completion commit.",
  "Do not implement code or approve/freeze the package on the user's behalf. The plugin will validate the package and ask the human for approval.",
  "Do not supply executor_model or reviewer_model: only the human's /plan-execute setup selection owns the ACP routing.",
].join("\n");

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
  run_id: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  manifest: MANIFEST_SCHEMA,
  files: Type.Array(FILE_SCHEMA),
  // Human approval is collected only by native UI or an explicit human command.
  approval: Type.Optional(Type.Union([Type.Literal("ask"), Type.Literal("cancel")])),
  executor_model: Type.Optional(Type.String({ minLength: 1 })),
  reviewer_model: Type.Optional(Type.String({ minLength: 1 })),
});

type FinalizeParams = Static<typeof FINALIZE_SCHEMA>;

interface ActiveRun {
  controller: AbortController;
  startedAt: string;
}

const activeRuns = new Map<string, ActiveRun>();

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

function stateLines(state: WorkflowState): string[] {
  const completed = state.phases.filter((phase) => phase.status === "completed").length;
  const current = state.phases.find((phase) => phase.status !== "completed");
  return [
    `Execution & Review · ${state.status}`,
    `Run ${state.run_id} · ${completed}/${state.phases.length} phases`,
    current ? `Current ${current.phase_id} · round ${current.review_rounds}` : "All phases complete",
    ...(state.branch_name ? [`Branch ${state.branch_name}`] : []),
    ...(state.worktree_path ? [`Worktree ${state.worktree_path}`] : []),
    ...(state.pause_reason ? [state.pause_reason] : []),
  ];
}

function compactReason(reason: string | undefined): string {
  if (!reason) return "";
  return reason.length <= 2000 ? reason : `${reason.slice(0, 2000)}…`;
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message, type);
}

async function packageReviewText(pkg: Awaited<ReturnType<typeof loadValidatedRun>>["package"]): Promise<string> {
  const chunks = [
    "# Frozen Golden Document Package Review",
    `Root: ${pkg.root}`,
    `Golden hash: ${pkg.package_hash}`,
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

async function chooseApproval(
  ctx: ExtensionContext,
  pkg: Awaited<ReturnType<typeof loadValidatedRun>>["package"],
  profile?: ProjectPluginProfile,
): Promise<"approve-start" | "cancel" | "pending"> {
  if (!ctx.hasUI) return "pending";
  const summary = `${formatPackageSummary(pkg)}${profile ? `\nExecutor: ${profile.executorModel}\nReviewer: ${profile.reviewerModel}\nReasoning: ${profile.reasoningEffort ?? "backend default"}\nReview loop limit: ${profile.reviewRoundLimit} round(s) per phase\nAgent permissions: ${profile.permissionMode === "autonomous" ? "Autonomous" : "Ask me"}\nAgent/tool network: normal CLI access` : ""}`;
  for (;;) {
    const choice = await ctx.ui.select("Plan Review & Approval", ["Review Plan Package", "Approve & Start", "Cancel"]);
    if (choice === "Approve & Start") return "approve-start";
    if (choice === "Cancel" || !choice) return "cancel";
    const review = await packageReviewText(pkg);
    await ctx.ui.editor("Review phased execution & acceptance plan (read-only)", review);
    notify(ctx, summary, "info");
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
      const liveCatalog = await acpCatalog("pi");
      candidates = candidates.filter((candidate) => liveCatalog.includes(candidate));
      if (candidates.length === 0) candidates = liveCatalog;
    } catch (error) {
      notify(ctx, `Isolated Pi ACP model discovery failed: ${error instanceof Error ? error.message : String(error)}. CLI candidates alone are not proof of ACP availability.`, "warning");
      candidates = [];
    }
  }
  if (candidates.length === 0 && selected.backend !== "pi") {
    try { candidates = await acpCatalog(selected.backend); }
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

export async function runSetupWizard(
  ctx: ExtensionCommandContext,
  clis: DetectedCli[] | (() => Promise<DetectedCli[]>),
  agentDir?: string,
  discoverModels: (projectRoot: string, backend: AcpBackend) => Promise<string[]> = probeAcpModels,
  discoverEfforts: (projectRoot: string, backend: AcpBackend, model: string) => Promise<ReasoningEffort[]> = async (root, backend, model) =>
    (await probeAcpConfiguration(root, backend, model)).efforts,
  verifyConnectivity: (projectRoot: string, model: string, effort?: ReasoningEffort) => Promise<void> = verifyAcpModelCall,
): Promise<ProjectPluginProfile | undefined> {
  if (!ctx.hasUI) throw new Error("Setup requires Pi's interactive UI (or RPC dialogs).");
  const preConsent = await ctx.ui.confirm(
    "Allow model discovery network risk?",
    "CLI model discovery may access the host network. ACP catalog fallbacks for Claude, Codex, OpenCode and Pi use a temporary sandboxed read-only session. " +
    "ACP servers still share the host network namespace. Do not proceed for sensitive repositories. " +
    "Catalog discovery mounts no project files and submits no model turn. Selecting a backend without completed live tests will require a separate billable connectivity confirmation.",
  );
  if (!preConsent) return undefined;
  const detected = typeof clis === "function" ? await clis() : clis;
  if (detected.length === 0) throw new Error("No working Claude, Codex, OpenCode or Pi CLI was found on PATH. Install and authenticate a supported harness before setup.");
  const catalogs = new Map<AcpBackend, Promise<string[]>>();
  const catalog = (backend: AcpBackend) => {
    let pending = catalogs.get(backend);
    if (!pending) { pending = discoverModels(ctx.cwd, backend); catalogs.set(backend, pending); }
    return pending;
  };
  const executorModel = await chooseConfiguredModel(ctx, "Executor", detected, catalog);
  if (!executorModel) return undefined;
  const reviewerModel = await chooseConfiguredModel(ctx, "Reviewer", detected, catalog);
  if (!reviewerModel) return undefined;
  const executorEffortsPromise = discoverEfforts(ctx.cwd, supportedBackendForModel(executorModel), executorModel);
  const reviewerEffortsPromise = executorModel === reviewerModel ? executorEffortsPromise
    : discoverEfforts(ctx.cwd, supportedBackendForModel(reviewerModel), reviewerModel);
  const [executorEfforts, reviewerEfforts] = await Promise.all([executorEffortsPromise, reviewerEffortsPromise]);
  const available = (["low", "medium", "high", "max"] as const).filter((effort) => executorEfforts.includes(effort) && reviewerEfforts.includes(effort));
  const effortChoice = await ctx.ui.select("ACP reasoning effort (shared by both selected models)", [...available, "backend default", "Cancel"]);
  if (!effortChoice || effortChoice === "Cancel") return undefined;
  const reasoningEffort = effortChoice === "backend default" ? undefined : selectStageBReasoningEffort(effortChoice);

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
  const autonomousLabel = "Autonomous — automatically approve one-time agent tool permission requests";
  const askLabel = "Ask me — pause and show each agent permission request in Pi";
  const permissionChoice = await ctx.ui.select("Agent permission handling during Execution & Review", [autonomousLabel, askLabel, "Cancel"]);
  if (!permissionChoice || permissionChoice === "Cancel") return undefined;
  const permissionMode: AgentPermissionMode = permissionChoice === askLabel ? "ask" : "autonomous";

  const needsLiveCheck = [...new Set([executorModel, reviewerModel])].filter((route) =>
    supportedBackendForModel(route) === "claude" || supportedBackendForModel(route) === "pi");
  if (needsLiveCheck.length) {
    const allowCalls = await ctx.ui.confirm(
      "Run billable Claude/Pi ACP connectivity checks?",
      `Selected models: ${needsLiveCheck.join(", ")}. Each check sends a small prompt to the real provider from an isolated disposable repository, ` +
      "after removing startup credential files. It may incur charges and still uses the host network. " +
      "A failed check will NOT be replaced with another model or silently ignored. No project files are mounted.",
    );
    if (!allowCalls) return undefined;
    for (const route of needsLiveCheck) await verifyConnectivity(ctx.cwd, route, reasoningEffort);
  }
  const consent = await ctx.ui.confirm(
    "Enable ACP networking for this project?",
    `Executor: ${executorModel}\nReviewer: ${reviewerModel}\nReasoning: ${reasoningEffort ?? "backend default"}\nReview loop limit: ${reviewRoundLimit}\nPermission mode: ${permissionMode}\n\n` +
    "The selected Agent CLIs and their tools keep normal network access, matching a normal standalone CLI session. " +
    "The plugin still isolates the dedicated worktree and unrelated host files; this confirmation does not approve or start execution.",
  );
  if (!consent) return undefined;
  return saveProjectPluginProfile(ctx.cwd, {
    executorModel,
    reviewerModel,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    permissionMode,
    reviewRoundLimit,
  }, agentDir);
}

async function commandSetup(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    notify(ctx, "Setup requires Pi's interactive UI (or RPC dialogs). For headless automation use the documented explicit environment fallback.", "warning");
    return;
  }
  try {
    if (!await ensureSetupRepository(ctx.cwd, ctx.ui)) return;
    const isolation = await defaultIsolationProvider.preflight();
    notify(
      ctx,
      `Environment preflight\n✓ Isolation: ${isolation.provider}\n✓ bubblewrap: ${isolation.bubblewrap}\n✓ Linux user namespaces available\n✓ Agent/tool network: normal host networking\n✓ Extra socat dependency: not required`,
      "info",
    );
    const saved = await runSetupWizard(ctx, discoverAcpClis);
    notify(ctx, saved
      ? `Project configured: ${saved.executorModel} → ${saved.reviewerModel}; reasoning ${saved.reasoningEffort ?? "backend default"}; review limit ${saved.reviewRoundLimit}; permissions ${saved.permissionMode}. Run /plan-execute when the plan is ready for human review.`
      : "Setup cancelled; no model selection or network consent was saved.", saved ? "info" : "warning");
    if (saved) {
      try {
        await execFile("git", ["check-ignore", "-q", ".pi-plan-execute-auto/config.json"], { cwd: ctx.cwd, timeout: 10_000 });
      } catch {
        notify(ctx, "Before approving execution, ignore .pi-plan-execute-auto/ via a reviewed .gitignore commit; plugin config/runtime files must not dirty the source worktree.", "warning");
      }
    }
  } catch (error) {
    notify(ctx, error instanceof Error ? error.message : String(error), "error");
  }
}

async function commandConfig(ctx: ExtensionCommandContext): Promise<void> {
  try {
    const profile = await loadProjectPluginProfile(ctx.cwd);
    notify(ctx, profile
      ? `Executor: ${profile.executorModel}\nReviewer: ${profile.reviewerModel}\nReasoning: ${profile.reasoningEffort ?? "backend default"}\nReview loop limit: ${profile.reviewRoundLimit}\nPermissions: ${profile.permissionMode}\nNetwork consent: ${profile.networkRiskApprovedAt}`
      : "No project configuration. Use /plan-execute setup.", profile ? "info" : "warning");
  } catch (error) {
    notify(ctx, error instanceof Error ? error.message : String(error), "error");
  }
}

async function commandResetConfig(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI || !await ctx.ui.confirm("Forget plan-execute setup?", "This removes project ACP model selection and network consent. Existing Golden Packages and commits are not removed.")) return;
  try {
    await removeProjectPluginProfile(ctx.cwd);
    notify(ctx, "Project configuration removed. Run /plan-execute setup before starting a new run.", "info");
  } catch (error) {
    notify(ctx, error instanceof Error ? error.message : String(error), "error");
  }
}

function makeAcceptanceRunner(cwd: string, sourceRoot: string, goldenRoot: string): AcceptanceCommandRunner {
  return {
    async run(command, options) {
      return defaultIsolationProvider.runAcceptanceCommand({
        cwd,
        sourceRoot,
        goldenRoot,
        command,
        ...(options?.signal ? { signal: options.signal } : {}),
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

export function frozenProfileMatches(
  state: WorkflowState,
  profile: ProjectPluginProfile,
  executorOverride?: string,
  reviewerOverride?: string,
): boolean {
  return state.executor_model === profile.executorModel &&
    state.reviewer_model === profile.reviewerModel &&
    state.reasoning_effort === profile.reasoningEffort &&
    state.permission_mode === profile.permissionMode &&
    state.review_round_limit === profile.reviewRoundLimit &&
    (!executorOverride || executorOverride === profile.executorModel) &&
    (!reviewerOverride || reviewerOverride === profile.reviewerModel);
}

function stageTimeoutMs(): number {
  const parsed = Number(process.env.PI_PLAN_EXECUTE_STAGE_B_TIMEOUT_MS ?? DEFAULT_STAGE_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STAGE_TIMEOUT_MS;
}

function acceptanceTimeoutMs(): number {
  const parsed = Number(process.env.PI_PLAN_EXECUTE_ACCEPTANCE_TIMEOUT_MS ?? DEFAULT_ACCEPTANCE_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ACCEPTANCE_TIMEOUT_MS;
}

function linkedAbortSignal(external: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; controller: AbortController; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Execution & Review timeout after ${timeoutMs}ms.`)), timeoutMs);
  const abort = () => controller.abort(external?.reason ?? new Error("Execution & Review cancelled."));
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

function restartPause(state: WorkflowState): string {
  const current = state.phases.find((phase) => phase.status !== "completed");
  state.status = "paused";
  state.pause_reason = "[PROCESS_RESTART] A persisted running workflow cannot safely resume its AgentPrism executor session; start a new approved run after Main Pi review.";
  if (current) {
    current.status = "paused";
    current.last_error = state.pause_reason;
  }
  return state.pause_reason;
}

function escalationDetails(state: WorkflowState, reason: string | undefined): Record<string, unknown> {
  const phase = state.phases.find((entry) => entry.status !== "completed");
  return {
    run_id: state.run_id,
    reason,
    phase_id: phase?.phase_id,
    base_commit_sha: phase?.base_commit_sha,
    review_rounds: phase?.review_rounds,
    unresolved_findings: phase?.unresolved_findings ?? [],
    executor_session_id: phase?.executor_session_id,
    reviewer_session_id: phase?.reviewer_session_id,
    execution_report_paths: phase?.execution_report_paths ?? [],
    review_report_paths: phase?.review_report_paths ?? [],
    acceptance_results: phase?.acceptance_results ?? [],
    branch_name: state.branch_name,
    worktree_path: state.worktree_path,
  };
}

function escalationSummary(details: Record<string, unknown>): string {
  const findings = Array.isArray(details.unresolved_findings)
    ? details.unresolved_findings.map((finding) => (finding as { id?: string }).id ?? "unknown").join(", ") || "none"
    : "none";
  const acceptanceFailures = Array.isArray(details.acceptance_results)
    ? details.acceptance_results
        .filter((result) => (result as { required?: boolean; passed?: boolean }).required && !(result as { passed?: boolean }).passed)
        .map((result) => (result as { id?: string }).id ?? "unknown")
        .join(", ") || "none"
    : "none";
  return [
    `pi-plan-execute-auto paused run ${String(details.run_id)}.`,
    compactReason(typeof details.reason === "string" ? details.reason : undefined),
    `Phase: ${String(details.phase_id ?? "none")} · round ${String(details.review_rounds ?? 0)}`,
    `Executor session: ${String(details.executor_session_id ?? "unknown")}`,
    `Reviewer session: ${String(details.reviewer_session_id ?? "unknown")}`,
    `Review reports: ${Array.isArray(details.review_report_paths) ? details.review_report_paths.join(", ") || "none" : "none"}`,
    `Execution reports: ${Array.isArray(details.execution_report_paths) ? details.execution_report_paths.join(", ") || "none" : "none"}`,
    `Unresolved findings: ${findings}`,
    `Acceptance failures: ${acceptanceFailures}`,
    "Inspect the persisted reports and decide the next step with the human.",
  ].filter(Boolean).join("\n");
}

async function persistAndEscalatePause(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  pkg: Awaited<ReturnType<typeof loadValidatedRun>>["package"],
  state: WorkflowState,
  reason: string,
): Promise<StageBRunResult> {
  state.status = "paused";
  state.pause_reason = reason;
  const current = state.phases.find((phase) => phase.status !== "completed");
  if (current) {
    current.status = "paused";
    current.last_error = reason;
  }
  await writeWorkflowState(pkg.root, state);
  const details = escalationDetails(state, reason);
  const summary = escalationSummary(details);
  showWidget(ctx, stateLines(state));
  pi.appendEntry(STATE_ENTRY, state);
  pi.appendEntry(ESCALATION_MESSAGE, details);
  try {
    await pi.sendMessage(
      { customType: ESCALATION_MESSAGE, content: summary, display: false, details },
      { deliverAs: "followUp", triggerTurn: true },
    );
  } catch (error) {
    notify(ctx, `Execution & Review paused, but Main Pi escalation failed: ${String(error)}`, "error");
  }
  return { status: "paused", state, reason };
}

export async function reconcilePersistedCompletions(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  pkg: Awaited<ReturnType<typeof loadValidatedRun>>["package"],
  state: WorkflowState,
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
  return persistAndEscalatePause(
    pi,
    ctx,
    pkg,
    state,
    "[PROCESS_RESTART_RECONCILED] Immutable completion evidence was reconciled, but the next phase cannot safely resume without its original AgentPrism session.",
  );
}

async function startStageB(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runId: string,
  options?: {
    executorModel?: string;
    reviewerModel?: string;
    signal?: AbortSignal;
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
          `[STARTUP_EVIDENCE] ${error instanceof Error ? error.message : String(error)}`,
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
      "[WORKTREE_IDENTITY_MISMATCH] Persisted dedicated worktree identity is not the run-scoped plugin identity.",
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
        `[COMPLETION_GIT_EVIDENCE] ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (state.status === "paused") {
    return state.pause_reason
      ? { status: "paused", state, reason: state.pause_reason }
      : { status: "paused", state, reason: "Run is paused." };
  }
  if (state.status === "running") {
    if (activeRuns.has(runId)) return { status: "not_started", state, reason: `Run ${runId} is already active.` };
    try {
      const reconciled = await reconcilePersistedCompletions(pi, ctx, pkg, state);
      if (reconciled) return reconciled;
    } catch (error) {
      return persistAndEscalatePause(pi, ctx, pkg, state, `[PROCESS_RESTART_EVIDENCE] ${error instanceof Error ? error.message : String(error)}`);
    }
    return persistAndEscalatePause(pi, ctx, pkg, state, restartPause(state));
  }
  if (
    state.status === "frozen" &&
    state.phases.some((phase) => phase.status === "running" || phase.review_rounds > 0 || Boolean(phase.executor_session_id))
  ) {
    return persistAndEscalatePause(pi, ctx, pkg, state, restartPause(state));
  }
  if (state.status !== "frozen") {
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
  let configuredPermissionMode: AgentPermissionMode;
  let configuredReviewRoundLimit: number;
  if (profile) {
    if (!frozenProfileMatches(state, profile, options?.executorModel, options?.reviewerModel)) {
      return { status: "not_started", state, reason: "Frozen run settings differ from the human-approved project setup; use a new run or restore the approved setup." };
    }
    executorModel = profile.executorModel;
    reviewerModel = profile.reviewerModel;
    configuredReasoningEffort = profile.reasoningEffort;
    configuredPermissionMode = profile.permissionMode;
    configuredReviewRoundLimit = profile.reviewRoundLimit;
  } else {
    if (ctx.hasUI) return { status: "not_started", state, reason: "Run /plan-execute setup to select and approve both ACP models for this project." };
    const envExecutor = process.env.PI_PLAN_EXECUTE_EXECUTOR_MODEL;
    const envReviewer = process.env.PI_PLAN_EXECUTE_REVIEWER_MODEL;
    if (!envExecutor || !envReviewer) {
      return { status: "not_started", state, reason: "Headless Stage B requires explicit PI_PLAN_EXECUTE_EXECUTOR_MODEL and PI_PLAN_EXECUTE_REVIEWER_MODEL." };
    }
    if ((state.executor_model && state.executor_model !== envExecutor) || (state.reviewer_model && state.reviewer_model !== envReviewer) ||
      (options?.executorModel && options.executorModel !== envExecutor) || (options?.reviewerModel && options.reviewerModel !== envReviewer)) {
      return { status: "not_started", state, reason: "Frozen run models do not match the explicit headless model selection." };
    }
    executorModel = envExecutor;
    reviewerModel = envReviewer;
    try {
      configuredReasoningEffort = selectStageBReasoningEffort(process.env.PI_PLAN_EXECUTE_REASONING_EFFORT);
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
  state.executor_model = executorModel;
  state.reviewer_model = reviewerModel;
  if (configuredReasoningEffort) state.reasoning_effort = configuredReasoningEffort;
  state.permission_mode = configuredPermissionMode;
  state.review_round_limit = configuredReviewRoundLimit;

  const linked = linkedAbortSignal(options?.signal ?? ctx.signal, stageTimeoutMs());
  const active: ActiveRun = { controller: new AbortController(), startedAt: new Date().toISOString() };
  const relay = () => linked.controller.abort(active.controller.signal.reason ?? new Error("Stage B stopped by human."));
  active.controller.signal.addEventListener("abort", relay, { once: true });
  activeRuns.set(runId, active);
  let harness: AgentPrismSessionPair | undefined;
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
      timeout: stageTimeoutMs(),
    });
    state.branch_name = dedicated.branchName;
    state.worktree_path = dedicated.path;
    state.controlled_environment_paths = await provisionDedicatedEnvironment(
      ctx.cwd,
      dedicated.path,
      undefined,
      { signal: linked.signal, timeout: stageTimeoutMs() },
    );
    await writeWorkflowState(pkg.root, state);

    const git = new GitWorkspace(targetGit, {
      cwd: dedicated.path,
      runtimeRoot: `.pi-plan-execute-auto/${runId}`,
      dedicatedBranch: dedicated.branchName,
      dedicatedWorktreePath: dedicated.path,
    });
    const sessionPair = new AgentPrismSessionPair({
      cwd: dedicated.path,
      sourceRoot: ctx.cwd,
      goldenRoot: pkg.root,
      executorModel,
      reviewerModel,
      ...(configuredReasoningEffort ? { reasoningEffort: configuredReasoningEffort } : {}),
      ...(profile ? { networkRiskApproved: true } : {}),
      permissionMode: configuredPermissionMode,
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
        showWidget(ctx, [`Execution & Review · ${runId}`, `${role} · ${event}`, `Branch ${dedicated.branchName}`]);
      },
    });
    harness = sessionPair;
    const controller = new StageBController({
      package: pkg,
      state,
      git,
      acceptanceRunner: makeAcceptanceRunner(dedicated.path, ctx.cwd, pkg.root),
      harness: sessionPair,
      signal: linked.signal,
      acceptanceTimeoutMs: acceptanceTimeoutMs(),
      requireDedicatedWorktree: true,
      saveState: (next) => writeWorkflowState(pkg.root, next),
      onStatus: (event) => {
        showWidget(ctx, [
          `Execution & Review · ${event.phase_id} · round ${event.round}`,
          `Executor ${event.executor_status} · Reviewer ${event.reviewer_status}`,
          `Branch ${dedicated.branchName}`,
          event.message,
        ]);
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
        `[EXECUTION_UNHANDLED] ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (result.status === "paused") {
      return persistAndEscalatePause(pi, ctx, pkg, result.state, result.reason ?? result.state.pause_reason ?? "Execution & Review paused.");
    }
    showWidget(ctx, stateLines(result.state));
    pi.appendEntry(STATE_ENTRY, result.state);
    return result;
  } catch (error) {
    return persistAndEscalatePause(pi, ctx, pkg, state, `[WORKTREE_SETUP] ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    activeRuns.delete(runId);
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
    ...(params.run_id ? { run_id: params.run_id } : {}),
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
    permissionMode,
    reviewRoundLimit,
  };
}

async function handleFinalize(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  params: FinalizeParams,
): Promise<ReturnType<typeof textResult>> {
  if (params.approval === "cancel") return textResult("Finalization cancelled before writing a package.", { status: "cancelled" });
  try {
    const selection = await approvedSetup(ctx.cwd, ctx.hasUI, params);
    const input = packageInput(params, selection.reviewRoundLimit);
    const runId = input.run_id ?? `run-${Date.now().toString(36)}`;
    const written = await writeValidatedPackage(ctx.cwd, input, runId);
    const draft = createDraftState(written.package, runId);
    await writeWorkflowState(written.package.root, draft);
    showWidget(ctx, ["Plan Review & Approval", "✓ Documents written", "✓ Manifest valid", `✓ ${written.package.phases.length} phases found`, `✓ Review limit ${selection.reviewRoundLimit} per phase`, "○ Human approval pending"]);
    const approval = await chooseApproval(ctx, written.package, selection.profile);
    if (approval === "pending") {
      return textResult(
        `${formatPackageSummary(written.package)}\n\nHuman approval is required. Use the TUI approval action or /plan-execute approve ${runId} start.`,
        { status: "awaiting_approval", run_id: runId, package_dir: written.package.root, package_hash: written.package.package_hash },
      );
    }
    if (approval === "cancel") {
      const cancelled = await cancelRun(written.package, runId);
      showWidget(ctx, ["Plan Review & Approval", "Cancelled", `Run ${runId}`]);
      return textResult(`Package ${runId} was cancelled; it was not frozen.`, { status: cancelled.status, run_id: runId });
    }
    const frozen = await freezeRun(written.package, runId, {
      reviewedPackageHash: written.package.package_hash,
      executorModel: selection.executorModel,
      reviewerModel: selection.reviewerModel,
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
      permissionMode: selection.permissionMode,
      reviewRoundLimit: selection.reviewRoundLimit,
    });
    showWidget(ctx, stateLines(frozen));
    // The human's Approve & Start choice is the sole authority; model parameters cannot suppress it.
    if (!approvalStartsStageB(approval)) throw new Error("Unexpected approval decision.");
    const started = await startStageB(pi, ctx, runId, {
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (started.status === "not_started") {
      return textResult(`Plan approved, but Execution & Review could not start: ${started.reason}`, { status: "paused", run_id: runId, state: started.state });
    }
    return textResult(`Plan approved. Execution & Review: ${started.status}.`, { status: started.status, run_id: runId, state: started.state });
  } catch (error) {
    const details = errorDetails(error);
    notify(ctx, details.text, "error");
    return textResult(details.text, details.details);
  }
}

async function commandFinalize(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  try {
    await approvedSetup(ctx.cwd, ctx.hasUI);
    pi.sendUserMessage(FINALIZE_PROMPT, { expandPromptTemplates: false });
  } catch (error) {
    notify(ctx, error instanceof Error ? error.message : String(error), "warning");
  }
}

async function commandValidate(ctx: ExtensionCommandContext, runId: string): Promise<void> {
  try {
    const root = packageRoot(ctx.cwd, runId);
    const result = await validatePackageDirectory(root);
    if (!result.ok || !result.package) {
      notify(ctx, `Package validation failed for ${runId}:\n${formatValidationIssues(result.errors)}`, "error");
      return;
    }
    notify(ctx, formatPackageSummary(result.package), "info");
  } catch (error) {
    notify(ctx, error instanceof Error ? error.message : String(error), "error");
  }
}

async function commandApprove(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  runId: string,
  start: boolean,
): Promise<void> {
  try {
    const loaded = await loadValidatedRun(ctx.cwd, runId);
    if (loaded.state.status !== "draft") {
      notify(ctx, `Run ${runId} is already ${loaded.state.status}; approval is not available.`, "warning");
      return;
    }
    const selection = await approvedSetup(ctx.cwd, ctx.hasUI);
    const review = `${await packageReviewText(loaded.package)}\n\nExecutor: ${selection.executorModel}\nReviewer: ${selection.reviewerModel}\nReasoning: ${selection.reasoningEffort ?? "backend default"}\nReview loop limit: ${selection.reviewRoundLimit}\nPermissions: ${selection.permissionMode}`;
    const ok = !ctx.hasUI || await ctx.ui.confirm("Freeze Golden Document Package", review);
    if (!ok) {
      notify(ctx, "Approval cancelled; package remains unfrozen.", "info");
      return;
    }
    const state = await freezeRun(loaded.package, runId, {
      reviewedPackageHash: loaded.package.package_hash,
      executorModel: selection.executorModel,
      reviewerModel: selection.reviewerModel,
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
      permissionMode: selection.permissionMode,
      reviewRoundLimit: selection.reviewRoundLimit,
    });
    pi.appendEntry(STATE_ENTRY, state);
    showWidget(ctx, stateLines(state));
    if (!start) {
      notify(ctx, `Run ${runId} plan approved. Execution & Review has not started.`, "info");
      return;
    }
    const result = await startStageB(pi, ctx, runId, { ...(ctx.signal ? { signal: ctx.signal } : {}) });
    notify(ctx, result.status === "not_started" ? result.reason : `Execution & Review ${result.status}.`, result.status === "paused" || result.status === "not_started" ? "warning" : "info");
  } catch (error) {
    notify(ctx, error instanceof Error ? error.message : String(error), "error");
  }
}

async function commandStop(ctx: ExtensionCommandContext, runId: string): Promise<void> {
  const active = activeRuns.get(runId);
  if (!active) {
    notify(ctx, `Run ${runId} has no active Execution & Review session.`, "warning");
    return;
  }
  active.controller.abort(new Error("Execution & Review stopped by human."));
  notify(ctx, `Stop requested for ${runId}; the workflow will pause without committing.`, "info");
}

export default function planExecuteAuto(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "plan_execute_finalize",
    label: "Finalize Phased Plan",
    description: "Write and structurally validate the current Main Pi planning context as a phased Golden Document Package.",
    promptSnippet: "Finalize a human-approved plan into a validated phased document package",
    promptGuidelines: [
      "Use plan_execute_finalize only after the human explicitly says the plan is ready; it must contain at least one ordered phase.",
      "Each phase in plan_execute_finalize needs an independent spec file, acceptance YAML contract, and required plugin-owned completion commit.",
      "Do not mark plan_execute_finalize approved or frozen on the human's behalf; the plugin collects human approval in native Pi UI.",
    ],
    parameters: FINALIZE_SCHEMA,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return handleFinalize(pi, ctx, params);
    },
  });

  pi.registerCommand("plan-execute", {
    description: "Set up ACP models or run a human-approved phased plan-execute workflow",
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const action = tokens[0] ?? "finalize";
      if (action === "setup") return commandSetup(ctx);
      if (action === "config") return commandConfig(ctx);
      if (action === "reset-config") return commandResetConfig(ctx);
      if (action === "finalize") return commandFinalize(pi, ctx);
      if (action === "validate" && tokens[1]) return commandValidate(ctx, tokens[1]);
      if (action === "approve" && tokens[1]) return commandApprove(pi, ctx, tokens[1], tokens[2] === "start");
      if (action === "stop" && tokens[1]) return commandStop(ctx, tokens[1]);
      if (action === "start" && tokens[1]) {
        try {
          const result = await startStageB(pi, ctx, tokens[1], { ...(ctx.signal ? { signal: ctx.signal } : {}) });
          notify(ctx, result.status === "not_started" ? result.reason : `Execution & Review ${result.status}.`, result.status === "paused" || result.status === "not_started" ? "warning" : "info");
        } catch (error) {
          notify(ctx, error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      if (action === "status" && tokens[1]) {
        try {
          const status = await readRunStatus(ctx.cwd, tokens[1]);
          notify(ctx, status ? formatStatus(status) : `Unknown workflow ${tokens[1]}.`, status ? "info" : "warning");
        } catch (error) {
          notify(ctx, error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      notify(ctx, "Usage: /plan-execute [finalize] | setup | config | reset-config | validate <run-id> | approve <run-id> [start] | start <run-id> | stop <run-id> | status <run-id>", "info");
    },
  });

  pi.registerEntryRenderer(STATE_ENTRY, (entry, _options, theme) => {
    const data = entry.data as Partial<WorkflowState>;
    const status = data.status ?? "unknown";
    const runId = data.run_id ?? "unknown";
    return new Text(theme.fg(status === "completed" ? "success" : status === "paused" ? "warning" : "accent", `plan-execute ${runId}: ${status}`), 0, 0);
  });

  pi.registerMessageRenderer(ESCALATION_MESSAGE, (message, _options, theme) => {
    const content = typeof message.content === "string" ? message.content : "Execution & Review needs attention (see details).";
    return new Text(theme.fg("warning", content), 0, 0);
  });

  pi.on("session_start", (_event, ctx) => {
    const latest = [...ctx.sessionManager.getBranch()]
      .reverse()
      .find((entry) => entry.type === "custom" && entry.customType === STATE_ENTRY);
    if (latest && latest.type === "custom") {
      const state = latest.data as WorkflowState;
      if (state && typeof state.run_id === "string") showWidget(ctx, stateLines(state));
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearWidget(ctx);
  });
}
