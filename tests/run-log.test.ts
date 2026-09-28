import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentSessionTranscriptRelativePath, appendAgentSessionEvent, appendRunEvent, captureMainPiSession } from "../src/run-log.js";

test("agent session diagnostics are split into safe per-session transcript files", async () => {
  const root = await mkdtemp(join(tmpdir(), "peac-session-log-"));
  try {
    const relative = await appendAgentSessionEvent(
      root,
      "executor",
      "session/with:unsafe chars",
      "agent_prompt",
      { prompt: "implement fixture" },
    );
    assert.equal(relative, agentSessionTranscriptRelativePath("executor", "session/with:unsafe chars"));
    assert.match(relative, /^\.runtime\/sessions\/executor\/session_with_unsafe_chars\.jsonl$/);
    const contents = await readFile(join(root, relative), "utf8");
    assert.match(contents, /agent_prompt/);
    assert.match(contents, /implement fixture/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run diagnostics redact known host credential values and credential-shaped fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "peac-run-log-"));
  const previous = process.env.ANTHROPIC_AUTH_TOKEN;
  try {
    process.env.ANTHROPIC_AUTH_TOKEN = "fixture-super-secret-token-value";
    await appendRunEvent(root, "fixture", {
      ANTHROPIC_AUTH_TOKEN: "fixture-super-secret-token-value",
      text: "Authorization: Bearer fixture-super-secret-token-value",
      nested: { api_key: "another-sensitive-value" },
    });
    await captureMainPiSession(root, [{
      text: "host token fixture-super-secret-token-value must not survive",
    }]);
    const events = await readFile(join(root, ".runtime", "events.jsonl"), "utf8");
    const session = await readFile(join(root, ".runtime", "main-pi-session.json"), "utf8");
    assert.doesNotMatch(events, /fixture-super-secret-token-value|another-sensitive-value/);
    assert.doesNotMatch(session, /fixture-super-secret-token-value/);
    assert.match(events, /REDACTED/);
    assert.match(session, /REDACTED/);
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = previous;
    await rm(root, { recursive: true, force: true });
  }
});
