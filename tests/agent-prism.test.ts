import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentPrismSessionPair, REVIEW_SCHEMA, requireAcpNetworkRiskAcknowledgement, schemaForBackend } from "../src/agent-prism.js";
import { supportedBackendForModel } from "../src/sandbox.js";

test("custom Codex route receives the built-in adapter's strict output schema", () => {
  const original = REVIEW_SCHEMA as Record<string, any>;
  const strict = schemaForBackend(REVIEW_SCHEMA, "codex") as Record<string, any>;
  assert.equal(original.additionalProperties, undefined);
  assert.equal(strict.additionalProperties, false);
  assert.equal(strict.properties.summary.maxLength, undefined);
  assert.equal(strict.properties.findings.items.additionalProperties, false);
  assert.equal(strict.properties.findings.items.properties.id.maxLength, undefined);
  assert.equal(strict.properties.findings.maxItems, undefined);
  assert.deepEqual(schemaForBackend(REVIEW_SCHEMA, "opencode"), REVIEW_SCHEMA);
});

test("unrestricted ACP tool network requires explicit non-sensitive repository risk acceptance", () => {
  const previous = process.env.PI_PLAN_EXECUTE_ACCEPT_ACP_NETWORK_RISK;
  try {
    delete process.env.PI_PLAN_EXECUTE_ACCEPT_ACP_NETWORK_RISK;
    assert.throws(requireAcpNetworkRiskAcknowledgement, /disabled by default/);
    process.env.PI_PLAN_EXECUTE_ACCEPT_ACP_NETWORK_RISK = "0";
    assert.throws(requireAcpNetworkRiskAcknowledgement, /disabled by default/);
    process.env.PI_PLAN_EXECUTE_ACCEPT_ACP_NETWORK_RISK = "1";
    assert.doesNotThrow(requireAcpNetworkRiskAcknowledgement);
  } finally {
    if (previous === undefined) delete process.env.PI_PLAN_EXECUTE_ACCEPT_ACP_NETWORK_RISK;
    else process.env.PI_PLAN_EXECUTE_ACCEPT_ACP_NETWORK_RISK = previous;
  }
});

test("live ACP session calls fail closed before starting either actor without network acknowledgement", async () => {
  const previous = process.env.PI_PLAN_EXECUTE_ACCEPT_ACP_NETWORK_RISK;
  delete process.env.PI_PLAN_EXECUTE_ACCEPT_ACP_NETWORK_RISK;
  try {
    const pair = new AgentPrismSessionPair({
      cwd: process.cwd(), sourceRoot: process.cwd(), goldenRoot: `${process.cwd()}/docs`,
      executorModel: "codex/mock", reviewerModel: "codex/mock",
    });
    await assert.rejects(pair.execute("probe", 1, { phaseBaseCommit: "a".repeat(40) }), /disabled by default/);
    await assert.rejects(pair.review("probe", 1), /disabled by default/);
  } finally {
    if (previous === undefined) delete process.env.PI_PLAN_EXECUTE_ACCEPT_ACP_NETWORK_RISK;
    else process.env.PI_PLAN_EXECUTE_ACCEPT_ACP_NETWORK_RISK = previous;
  }
});

test("only explicitly sandboxed ACP backends and model routes are accepted", () => {
  assert.equal(supportedBackendForModel("codex/gpt-5.6-sol"), "codex");
  assert.equal(supportedBackendForModel("opencode/opencode/big-pickle"), "opencode");
  assert.equal(supportedBackendForModel("claude/sonnet"), "claude");
  assert.equal(supportedBackendForModel("pi/openai-codex/gpt-6-luna"), "pi");
  assert.throws(() => supportedBackendForModel("custom-agent/model"), /not allowlisted/);
  assert.throws(() => supportedBackendForModel(undefined), /explicit claude|codex|opencode|pi/);
  assert.throws(() => supportedBackendForModel("codex/"), /incomplete/);
});
