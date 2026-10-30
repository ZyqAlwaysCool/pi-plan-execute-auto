import { test } from "node:test";
import assert from "node:assert/strict";
import { configureAcpAgent, type ConfigurableAgent, type AgentConfiguration } from "../src/acp-configuration.js";

function fixture(models: string[] = ["gpt-6.1-sol"]) {
  const calls: string[] = [];
  let currentMode = "agent";
  let selectedModel = "codex";
  let options: ConfigurableAgent["configOptions"] = [
    { id: "model", name: "Model", type: "select", currentValue: "default-model", options: models.map((value) => ({ name: value, value })) },
    { id: "reasoning_effort", name: "Effort", category: "thought_level", type: "select", currentValue: "medium", options: ["medium", "high"].map((value) => ({ name: value, value })) },
  ];
  const agent: ConfigurableAgent = {
    backendId: "codex",
    get model() { return selectedModel; },
    get configOptions() { return options; },
    get modes() { return { currentModeId: currentMode, availableModes: ["agent", "agent-full-access"].map((id) => ({ id, name: id })) }; },
    async ready() { calls.push("ready"); },
    async setModel(model) {
      calls.push(`model:${model}`); selectedModel = model;
      options = options.map((o) => o.id === "model" && o.type === "select" ? { ...o, currentValue: model.slice("codex/".length) } : o);
    },
    async setMode(mode) { calls.push(`mode:${mode}`); currentMode = mode; },
    async setConfigOptions(values) {
      calls.push(`config:${JSON.stringify(values)}`);
      options = options.map((o) => o.id in values && o.type === "select" ? { ...o, currentValue: values[o.id] as string } : o);
    },
  };
  return { agent, calls };
}
const config: AgentConfiguration = {
  role: "reviewer", model: "codex/gpt-6.1-sol", mode: "agent-full-access", effort: "high",
  runtime: {
    adapter_path: "/plugin/codex-acp/index.js", adapter_version: "2.9.0",
    cli_source: "host", cli_path: "/old/vendor/bin/codex", cli_version: "codex-cli 0.147.0",
    path_candidates: ["/old/bin/codex.js", "/new/bin/codex.js"],
  },
};

test("unknown model is rejected before sending selection; error names runtime, catalog and PATH", async () => {
  const { agent, calls } = fixture(["gpt-6-sol"]);
  await assert.rejects(configureAcpAgent(agent, config), (error: Error) => {
    assert.match(error.message, /model catalog validation/);
    assert.match(error.message, /gpt-6\.1-sol.*not advertised/);
    assert.match(error.message, /Available model IDs: gpt-6-sol/);
    assert.match(error.message, /\/old\/vendor\/bin\/codex.*0\.147\.0/);
    assert.match(error.message, /Multiple Codex installs.*\/old\/bin\/codex.js, \/new\/bin\/codex.js/);
    assert.match(error.message, /never substitutes another model/);
    return true;
  });
  assert.deepEqual(calls, ["ready"]);
});

test("approved model, mode and effort are selected exactly and in catalog-dependent order", async () => {
  const { agent, calls } = fixture();
  await configureAcpAgent(agent, config);
  assert.deepEqual(calls, ["ready", "model:codex/gpt-6.1-sol", "mode:agent-full-access", 'config:{"reasoning_effort":"high"}']);
  assert.equal(agent.model, config.model);
});

test("grouped model catalogs and backend-prefixed model IDs are not rewritten", async () => {
  const { agent, calls } = fixture();
  const grouped = { ...agent, configOptions: [
    { id: "model", name: "Model", type: "select" as const, currentValue: "provider/model", options: [
      { name: "Provider", group: "provider", options: [{ name: "Model", value: "provider/model" }] },
    ] },
  ] };
  await configureAcpAgent(grouped, { role: "executor", model: "codex/provider/model" });
  assert.deepEqual(calls, ["ready", "model:codex/provider/model"]);
});

test("backend default catalog discovery sends no model or mode choice", async () => {
  const { agent, calls } = fixture();
  await configureAcpAgent(agent, { role: "catalog" });
  assert.deepEqual(calls, ["ready"]);
});

test("backend rejection retains the exact operation instead of only Invalid params", async () => {
  const { agent } = fixture();
  agent.setModel = async () => { throw new Error("Invalid params"); };
  await assert.rejects(configureAcpAgent(agent, config), /session\/set_config_option\(model=gpt-6\.1-sol\): Invalid params/);
});

test("unsupported mode and effort fail explicitly without downgrading", async () => {
  const { agent, calls } = fixture();
  await assert.rejects(configureAcpAgent(agent, { ...config, mode: "missing" }), /Mode is not advertised.*agent-full-access/);
  assert.deepEqual(calls, ["ready", "model:codex/gpt-6.1-sol"]);
  const other = fixture();
  await assert.rejects(configureAcpAgent(other.agent, { ...config, effort: "max" }), /did not advertise max reasoning/);
  assert.ok(!other.calls.some((c) => c.startsWith("config:")));
});

test("configuration must be confirmed by the backend, not just acknowledged", async () => {
  const { agent } = fixture();
  agent.setModel = async () => {};
  await assert.rejects(configureAcpAgent(agent, config), /did not confirm model/);
});

test("initialization failures identify session/new even before a session ID exists", async () => {
  const { agent } = fixture();
  agent.ready = async () => { throw new Error("workspace routing discovery unauthorized (401)"); };
  await assert.rejects(configureAcpAgent(agent, config), /session\/new: workspace routing discovery unauthorized \(401\)/);
});
