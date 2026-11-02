import { test } from "node:test";
import assert from "node:assert/strict";
import { collectAdvertisedEfforts } from "../src/reasoning-efforts.js";
import { orderReasoningEfforts } from "../src/types.js";

/** Real config-option shapes observed from the four supported ACP servers. */
function select(id: string, category: string | null, values: string[]) {
  return { id, name: id, category, type: "select" as const, currentValue: values[0]!, options: values.map((value) => ({ name: value, value })) };
}

test("every supported backend's reasoning option is discovered by category, not by id", () => {
  const codex = [select("reasoning_effort", "thought_level", ["low", "medium", "high", "xhigh", "max"])];
  const claude = [select("effort", "thought_level", ["default", "low", "medium", "high", "xhigh", "max"])];
  const opencode = [select("effort", "thought_level", ["high", "max", "non-think", "default"])];
  const pi = [select("thinkingLevel", "thought_level", ["off", "minimal", "low", "medium", "high", "xhigh", "max"])];
  assert.deepEqual(collectAdvertisedEfforts(codex), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(collectAdvertisedEfforts(claude), ["default", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(collectAdvertisedEfforts(opencode), ["default", "high", "max", "non-think"]);
  assert.deepEqual(collectAdvertisedEfforts(pi), ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
});

test("grouped options, duplicates and unknown labels are handled", () => {
  const grouped = [{
    id: "effort", name: "Effort", category: "thought_level", type: "select" as const, currentValue: "high",
    options: [
      { name: "Standard", group: "standard", options: [{ name: "High", value: "high" }, { name: "Xhigh", value: "xhigh" }] },
      { name: "Max", value: "max" },
    ],
  }] as unknown as Parameters<typeof collectAdvertisedEfforts>[0];
  assert.deepEqual(collectAdvertisedEfforts(grouped), ["high", "xhigh", "max"]);
  assert.deepEqual(collectAdvertisedEfforts([select("effort", "thought_level", ["HIGH", "high", ""])]), ["high"]);
});

test("non-reasoning options are ignored", () => {
  const options = [
    { id: "fast-mode", name: "Fast", category: "model_config", type: "boolean" as const, currentValue: false },
    { id: "collaboration_mode", name: "Collaboration", category: "collaboration_mode", type: "select" as const, currentValue: "default", options: [{ name: "default", value: "default" }, { name: "plan", value: "plan" }] },
    select("model", "model", ["gpt-6.1-sol"]),
  ];
  assert.deepEqual(collectAdvertisedEfforts(options), []);
});

test("sentinel levels sort before real reasoning depth", () => {
  assert.deepEqual(orderReasoningEfforts(["max", "off", "high", "default", "minimal"]), ["off", "default", "minimal", "high", "max"]);
});
