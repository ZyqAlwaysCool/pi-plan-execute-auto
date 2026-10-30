import type { AcpAgent } from "@automatalabs/workflows";
import type { ReasoningEffort } from "./types.js";
import type { CodexRuntimeInfo } from "./sandbox.js";

export type ConfigurableAgent = Pick<AcpAgent,
  "ready" | "backendId" | "model" | "modes" | "configOptions" | "setModel" | "setMode" | "setConfigOptions">;

export interface AgentConfiguration {
  role: "executor" | "reviewer" | "catalog";
  model?: string | undefined;
  mode?: string | undefined;
  effort?: ReasoningEffort | undefined;
  runtime?: CodexRuntimeInfo | undefined;
}

function selectValues(option: ConfigurableAgent["configOptions"][number]): string[] {
  return option.type === "select"
    ? option.options.flatMap((choice) => "value" in choice ? [choice.value] : choice.options.map((item) => item.value))
    : [];
}

function catalog(values: string[]): string {
  return values.slice(0, 40).join(", ") + (values.length > 40 ? ` … (${values.length} total)` : "") || "(none advertised)";
}

export class AcpConfigurationError extends Error {
  constructor(
    readonly configuration: AgentConfiguration,
    readonly operation: string,
    detail: string,
  ) {
    const runtime = configuration.runtime;
    super([
      `${configuration.role} ACP initialization failed at ${operation}: ${detail}`,
      `Requested model: ${configuration.model ?? "backend default"}; mode: ${configuration.mode ?? "backend default"}; reasoning: ${configuration.effort ?? "backend default"}.`,
      ...(runtime ? [
        `Actual Codex CLI: ${runtime.cli_path} (${runtime.cli_version}; ${runtime.cli_source}). ACP adapter: ${runtime.adapter_version}.`,
        ...(runtime.path_candidates.length > 1
          ? [`Multiple Codex installs on the Pi process PATH (priority order): ${runtime.path_candidates.join(", ")}.`]
          : []),
        "Check the Pi process PATH, not only your interactive terminal. Update/remove stale Codex installs and restart Pi; the plugin never substitutes another model or selects the newest CLI automatically.",
      ] : []),
    ].join("\n"));
    this.name = "AcpConfigurationError";
  }
}

/**
 * Open on the backend's default model, inspect its authoritative catalog, then select the EXACT
 * approved model/mode/effort. Passing the model to the constructor instead would let the SDK send
 * session/set_config_option(model) before we can diagnose an unadvertised model (generic -32602).
 * Used by both start/resume preflight and actual sessions; no prompt/model turn is sent here.
 */
export async function configureAcpAgent(
  agent: ConfigurableAgent,
  config: AgentConfiguration,
  onOperation?: (operation: string) => void,
): Promise<void> {
  let operation = "session/new";
  const step = (value: string): void => { operation = value; onOperation?.(value); };
  try {
    step("session/new");
    await agent.ready();
    if (config.model) {
      const prefix = `${agent.backendId}/`;
      if (!config.model.startsWith(prefix)) throw new Error(`Route must start with ${prefix}.`);
      const id = config.model.slice(prefix.length);
      const option = agent.configOptions.find((entry) => entry.id === "model");
      const values = option ? selectValues(option) : [];
      step("model catalog validation");
      if (!values.includes(id)) {
        throw new Error(`Model ${JSON.stringify(id)} is not advertised by this runtime. Available model IDs: ${catalog(values)}.`);
      }
      step(`session/set_config_option(model=${id})`);
      await agent.setModel(config.model);
      const selected = agent.configOptions.find((entry) => entry.id === "model");
      if (selected?.currentValue !== id) throw new Error(`Backend did not confirm model=${id}.`);
    }
    if (config.mode) {
      step(`session/set_mode(${config.mode})`);
      const modes = agent.modes?.availableModes.map((mode) => mode.id) ?? [];
      if (!modes.includes(config.mode)) throw new Error(`Mode is not advertised. Available modes: ${catalog(modes)}.`);
      await agent.setMode(config.mode);
      if (agent.modes?.currentModeId !== config.mode) throw new Error(`Backend did not confirm mode=${config.mode}.`);
    }
    if (config.effort) {
      step(`session/set_config_option(reasoning=${config.effort})`);
      const option = agent.configOptions.find((entry) =>
        (entry.id === "reasoning_effort" || entry.category === "thought_level" || entry.id === "variant") &&
        selectValues(entry).includes(config.effort!),
      );
      if (!option) throw new Error(`Backend did not advertise ${config.effort} reasoning for ${config.model ?? agent.model}.`);
      await agent.setConfigOptions({ [option.id]: config.effort });
      if (agent.configOptions.find((entry) => entry.id === option.id)?.currentValue !== config.effort) {
        throw new Error(`Backend did not confirm ${option.id}=${config.effort}.`);
      }
    }
  } catch (error) {
    throw new AcpConfigurationError(config, operation, error instanceof Error ? error.message : String(error));
  }
}
