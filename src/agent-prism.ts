import {
  AcpAgent,
  selectPermissionOption,
  toStrictJsonSchema,
  type AcpAgentTurn,
  type RequestPermissionRequest,
} from "@automatalabs/workflows";
import { Type, type TSchema } from "typebox";
import type {
  AgentPermissionMode,
  ExecutionReport,
  HarnessPair,
  ReasoningEffort,
  ReviewReport,
} from "./types.js";
import {
  MAX_FINDINGS,
  MAX_FINDING_ID_LENGTH,
  MAX_REPORT_LIST_ITEMS,
  MAX_REPORT_STRING_LENGTH,
} from "./reports.js";
import { defaultIsolationProvider } from "./isolation-provider.js";
import type { SandboxedBackend } from "./sandbox.js";

const EXECUTION_SCHEMA = Type.Object({
  phase_id: Type.String({ maxLength: MAX_FINDING_ID_LENGTH }),
  round: Type.Integer({ minimum: 1 }),
  base_commit: Type.String({ maxLength: MAX_FINDING_ID_LENGTH }),
  status: Type.Union([Type.Literal("complete"), Type.Literal("blocked"), Type.Literal("failed")]),
  summary: Type.String({ maxLength: MAX_REPORT_STRING_LENGTH }),
  changed_files: Type.Array(Type.String({ maxLength: MAX_REPORT_STRING_LENGTH }), { maxItems: MAX_REPORT_LIST_ITEMS }),
  self_tests: Type.Array(
    Type.Object({
      id: Type.String({ maxLength: MAX_FINDING_ID_LENGTH }),
      command: Type.String({ maxLength: MAX_REPORT_STRING_LENGTH }),
      status: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("skipped")]),
      output: Type.Optional(Type.String({ maxLength: MAX_REPORT_STRING_LENGTH })),
    }),
    { maxItems: MAX_REPORT_LIST_ITEMS },
  ),
  resolved_findings: Type.Array(Type.String({ maxLength: MAX_FINDING_ID_LENGTH }), { maxItems: MAX_REPORT_LIST_ITEMS }),
  known_issues: Type.Array(Type.String({ maxLength: MAX_REPORT_STRING_LENGTH }), { maxItems: MAX_REPORT_LIST_ITEMS }),
});

const REVIEW_SCHEMA = Type.Object({
  phase_id: Type.String({ maxLength: MAX_FINDING_ID_LENGTH }),
  round: Type.Integer({ minimum: 1 }),
  base_commit: Type.String(),
  verdict: Type.Union([Type.Literal("PASS"), Type.Literal("REWORK")]),
  summary: Type.String({ maxLength: MAX_REPORT_STRING_LENGTH }),
  findings: Type.Array(
    Type.Object({
      id: Type.String({ minLength: 1, maxLength: MAX_FINDING_ID_LENGTH }),
      severity: Type.String({ maxLength: MAX_REPORT_STRING_LENGTH }),
      summary: Type.String({ maxLength: MAX_REPORT_STRING_LENGTH }),
      evidence: Type.String({ maxLength: MAX_REPORT_STRING_LENGTH }),
      blocking: Type.Boolean(),
    }),
    { maxItems: MAX_FINDINGS },
  ),
  evidence: Type.Array(Type.String({ maxLength: MAX_REPORT_STRING_LENGTH }), { maxItems: MAX_REPORT_LIST_ITEMS }),
  acceptance_assessment: Type.String({ maxLength: MAX_REPORT_STRING_LENGTH }),
  out_of_scope_changes: Type.Array(Type.String({ maxLength: MAX_REPORT_STRING_LENGTH }), { maxItems: MAX_REPORT_LIST_ITEMS }),
});

export function schemaForBackend(schema: TSchema, backendId: string): TSchema {
  // A custom backend shadows built-in `codex`, so it also shadows CodexBackend.promptMeta's
  // OpenAI strict normalization. Keep the client-side schema strict-compatible too; report
  // limits that strict JSON Schema cannot express are rechecked by StageBController.
  return backendId === "codex" ? toStrictJsonSchema(schema) as TSchema : schema;
}

function parseTurn(turn: { structured?: unknown; text: string }): unknown {
  if (turn.structured !== undefined) return turn.structured;
  const text = turn.text.trim();
  const withoutFence = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(withoutFence) as unknown;
  } catch {
    return undefined;
  }
}

function invalidStructuredTurn(role: "executor" | "reviewer", turn: AcpAgentTurn): Error {
  return new Error(`${role} ACP turn did not yield a structured report (stop=${turn.stopReason}, attempts=${turn.structuredAttempts ?? 0}, text_bytes=${Buffer.byteLength(turn.text)}, structured_error=${turn.structuredError?.slice(0, 300) ?? "none"}).`);
}

function selectedPermission(request: RequestPermissionRequest, allow: boolean): ReturnType<typeof selectPermissionOption> {
  const wanted = request.options.find((option) =>
    allow ? option.kind === "allow_once" : option.kind === "reject_once" || option.kind === "reject_always",
  );
  return wanted ? selectPermissionOption(request, wanted.optionId) : { outcome: { outcome: "cancelled" } };
}

function reviewerPermission(request: RequestPermissionRequest): ReturnType<typeof selectPermissionOption> {
  // Codex requests permission even for read-only Git commands. The verified OS
  // read-only mount is the boundary; grant one tool call, never a persistent grant.
  return selectedPermission(request, true);
}

function executorPermission(request: RequestPermissionRequest): ReturnType<typeof selectPermissionOption> {
  // Allow one tool call only after the OS mount probe passed. The worktree is the
  // only persistent writable project root; Git metadata remains read-only.
  return selectedPermission(request, true);
}

export function requireAcpNetworkRiskAcknowledgement(approvedProjectProfile = false): void {
  if (!approvedProjectProfile && process.env.PI_PLAN_EXECUTE_ACCEPT_ACP_NETWORK_RISK !== "1") {
    throw new Error(
      "Execution & Review uses the selected Agent CLIs with their normal network access. " +
      "Headless mode requires PI_PLAN_EXECUTE_ACCEPT_ACP_NETWORK_RISK=1 to explicitly acknowledge that behavior.",
    );
  }
}

async function requireReasoningEffort(agent: AcpAgent, effort: ReasoningEffort): Promise<void> {
  const option = agent.configOptions.find((entry) =>
    (entry.id === "reasoning_effort" || entry.category === "thought_level" || entry.id === "variant") &&
    entry.type === "select" && entry.options.some((choice) =>
      "value" in choice ? choice.value === effort : choice.options.some((item) => item.value === effort),
    ),
  );
  if (!option) {
    throw new Error(`ACP backend ${agent.backendId} did not advertise a ${effort} reasoning option for ${agent.model ?? "default model"}.`);
  }
  await agent.setConfigOptions({ [option.id]: effort });
  const selected = agent.configOptions.find((entry) => entry.id === option.id);
  if (selected?.currentValue !== effort) {
    throw new Error(`ACP backend ${agent.backendId} did not confirm ${option.id}=${effort} after setting it.`);
  }
}

export interface AgentPrismSessionPairOptions {
  cwd: string;
  sourceRoot: string;
  goldenRoot: string;
  reviewerCwd?: string;
  executorModel?: string;
  reviewerModel?: string;
  executorMode?: string;
  reviewerMode?: string;
  schemaRetries?: number;
  reasoningEffort?: ReasoningEffort;
  /** Verified user-owned project profile consent; headless runs may use the explicit env fallback. */
  networkRiskApproved?: boolean;
  permissionMode?: AgentPermissionMode;
  onPermissionChoice?: (
    role: "executor" | "reviewer",
    request: RequestPermissionRequest,
  ) => Promise<string | undefined>;
  onLiveEvent?: (role: "executor" | "reviewer", event: string) => void;
}

/**
 * AgentPrism lower-level session adapter. The executor remains open across rework rounds;
 * each reviewer round is fresh and runs inside an OS-enforced read-only filesystem sandbox.
 * ACP mode labels and permission requests are not treated as filesystem security boundaries.
 */
export class AgentPrismSessionPair implements HarnessPair {
  private readonly options: AgentPrismSessionPairOptions;
  private executor: AcpAgent | undefined;
  private reviewer: AcpAgent | undefined;
  private executorSandbox: SandboxedBackend | undefined;
  private executorBaseCommit: string | undefined;

  constructor(options: AgentPrismSessionPairOptions) {
    this.options = options;
  }

  private async closeExecutorSession(): Promise<void> {
    const agent = this.executor;
    const sandbox = this.executorSandbox;
    this.executor = undefined;
    this.executorSandbox = undefined;
    this.executorBaseCommit = undefined;
    try {
      await agent?.close({ keep: true });
    } finally {
      await sandbox?.cleanup();
    }
  }

  private permissionResolver(role: "executor" | "reviewer") {
    return async (request: RequestPermissionRequest) => {
      if ((this.options.permissionMode ?? "autonomous") === "autonomous") {
        return role === "executor" ? executorPermission(request) : reviewerPermission(request);
      }
      const optionId = await this.options.onPermissionChoice?.(role, request);
      return optionId ? selectPermissionOption(request, optionId) : { outcome: { outcome: "cancelled" as const } };
    };
  }

  private async getExecutor(signal: AbortSignal | undefined, phaseBaseCommit: string): Promise<AcpAgent> {
    requireAcpNetworkRiskAcknowledgement(this.options.networkRiskApproved);
    if (this.executor && this.executorBaseCommit !== phaseBaseCommit) await this.closeExecutorSession();
    if (!this.executor) {
      const model = this.options.executorModel;
      const sandboxOptions = {
        role: "executor" as const,
        model: model ?? "",
        cwd: this.options.cwd,
        sourceRoot: this.options.sourceRoot,
        goldenRoot: this.options.goldenRoot,
        includeProviderCredentials: true,
        ...(signal ? { signal } : {}),
      };
      const sandbox = await defaultIsolationProvider.createBackend(sandboxOptions);
      let agent: AcpAgent | undefined;
      try {
        await defaultIsolationProvider.verifyBoundary(sandboxOptions);
        agent = new AcpAgent({
          cwd: this.options.cwd,
          ...(model ? { model } : {}),
          ...(this.options.executorMode ? { mode: this.options.executorMode } : {}),
          backends: { [sandbox.backendId]: sandbox.config },
          label: "pi-plan-execute-auto/executor",
          schema: schemaForBackend(EXECUTION_SCHEMA, sandbox.backendId),
          schemaRetries: this.options.schemaRetries ?? 2,
          permissions: { defaultOutcome: "deny" },
          ...(signal ? { signal } : {}),
          onPermissionRequest: this.permissionResolver("executor"),
          retainHistory: true,
        });
        await agent.ready();
        if (this.options.reasoningEffort) await requireReasoningEffort(agent, this.options.reasoningEffort);
        if (this.options.executorMode && agent.modes?.currentModeId !== this.options.executorMode) {
          throw new Error(`Executor backend ${agent.backendId} did not enter the required ${this.options.executorMode} mode.`);
        }
        await sandbox.scrubCredentials();
        this.executor = agent;
        this.executorSandbox = sandbox;
        this.executorBaseCommit = phaseBaseCommit;
      } catch (error) {
        await agent?.close({ keep: true }).catch(() => undefined);
        await sandbox.cleanup();
        throw error;
      }
    }
    return this.executor;
  }

  private async streamPrompt(
    agent: AcpAgent,
    role: "executor" | "reviewer",
    prompt: string,
    options?: { signal?: AbortSignal },
  ): Promise<AcpAgentTurn> {
    let turn: AcpAgentTurn | undefined;
    for await (const event of agent.stream(prompt, options)) {
      try {
        this.options.onLiveEvent?.(role, event.type);
      } catch {
        // Activity projection is observational and cannot change the harness turn.
      }
      if (event.type === "turn") turn = event.turn;
    }
    if (!turn) throw new Error(`${role} ACP stream ended without a terminal turn.`);
    return turn;
  }

  async execute(
    prompt: string,
    _round: number,
    options?: { signal?: AbortSignal; phaseBaseCommit?: string },
  ): Promise<ExecutionReport> {
    const phaseBaseCommit = options?.phaseBaseCommit ?? prompt.match(/^phase_base_commit:\s*((?:[0-9a-f]{40}|[0-9a-f]{64}))\s*$/mu)?.[1];
    if (!phaseBaseCommit || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(phaseBaseCommit)) {
      throw new Error("Executor prompt is missing a valid full phase base commit.");
    }
    const executor = await this.getExecutor(options?.signal, phaseBaseCommit);
    const turn = await this.streamPrompt(
      executor,
      "executor",
      prompt,
      options?.signal ? { signal: options.signal } : undefined,
    );
    const value = parseTurn(turn);
    if (value === undefined) throw invalidStructuredTurn("executor", turn);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return {
        ...(value as ExecutionReport),
        ...(executor.sessionId ? { executor_session_id: executor.sessionId } : {}),
      };
    }
    return value as ExecutionReport;
  }

  async rework(
    prompt: string,
    _round: number,
    options?: { signal?: AbortSignal; phaseBaseCommit?: string },
  ): Promise<ExecutionReport> {
    // Same AcpAgent instance: REWORK is a new turn in the original executor session.
    return this.execute(prompt, _round, options);
  }

  async review(prompt: string, _round: number, options?: { signal?: AbortSignal }): Promise<ReviewReport> {
    requireAcpNetworkRiskAcknowledgement(this.options.networkRiskApproved);
    const cwd = this.options.reviewerCwd ?? this.options.cwd;
    const model = this.options.reviewerModel;
    const sandboxOptions = {
      role: "reviewer" as const,
      model: model ?? "",
      cwd,
      sourceRoot: this.options.sourceRoot,
      goldenRoot: this.options.goldenRoot,
      includeProviderCredentials: true,
      ...(options?.signal ? { signal: options.signal } : {}),
    };
    const sandbox = await defaultIsolationProvider.createBackend(sandboxOptions);
    let reviewer: AcpAgent | undefined;
    this.reviewer = undefined;
    try {
      await defaultIsolationProvider.verifyBoundary(sandboxOptions);
      // codex-acp's "read-only" mode actually requests workspaceWrite and runs a
      // second bubblewrap that must mkdir .agents under the OS-read-only worktree.
      // That inner sandbox fails before even read-only Git commands can run. Use
      // the adapter's no-inner-sandbox mode ONLY after verifying our own trusted
      // bubblewrap read-only mount; ACP permissions are never the write boundary.
      const reviewerMode = this.options.reviewerMode ?? (sandbox.backendId === "codex" ? "agent-full-access" : undefined);
      reviewer = new AcpAgent({
        cwd,
        ...(model ? { model } : {}),
        ...(reviewerMode ? { mode: reviewerMode } : {}),
        backends: { [sandbox.backendId]: sandbox.config },
        label: "pi-plan-execute-auto/reviewer",
        schema: schemaForBackend(REVIEW_SCHEMA, sandbox.backendId),
        schemaRetries: this.options.schemaRetries ?? 2,
        // The OS read-only mount is the security boundary; each permission request
        // receives only a one-shot grant, never a persistent allow_always grant.
        permissions: { defaultOutcome: "deny" },
        ...(options?.signal ? { signal: options.signal } : {}),
        onPermissionRequest: this.permissionResolver("reviewer"),
        retainHistory: false,
      });
      this.reviewer = reviewer;
      await reviewer.ready();
      if (this.options.reasoningEffort) await requireReasoningEffort(reviewer, this.options.reasoningEffort);
      if (reviewerMode && reviewer.modes?.currentModeId !== reviewerMode) {
        throw new Error(`Reviewer backend ${reviewer.backendId} did not enter the configured ${reviewerMode} mode.`);
      }
      await sandbox.scrubCredentials();
      const turn = await this.streamPrompt(reviewer, "reviewer", prompt, options);
      const value = parseTurn(turn);
      if (value === undefined) throw invalidStructuredTurn("reviewer", turn);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return {
          ...(value as ReviewReport),
          ...(reviewer.sessionId ? { reviewer_session_id: reviewer.sessionId } : {}),
        };
      }
      return value as ReviewReport;
    } finally {
      this.reviewer = undefined;
      try {
        await reviewer?.close({ keep: true });
      } finally {
        await sandbox.cleanup();
      }
    }
  }

  async close(): Promise<void> {
    const executor = this.executor;
    const reviewer = this.reviewer;
    const sandbox = this.executorSandbox;
    this.executor = undefined;
    this.reviewer = undefined;
    this.executorSandbox = undefined;
    this.executorBaseCommit = undefined;
    try {
      await reviewer?.close({ keep: true });
    } finally {
      try {
        await executor?.close({ keep: true });
      } finally {
        await sandbox?.cleanup();
      }
    }
  }
}

export { EXECUTION_SCHEMA, REVIEW_SCHEMA };
