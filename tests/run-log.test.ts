import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_MAIN_PI_SESSION_BYTES, agentSessionTranscriptRelativePath, appendAgentSessionEvent, appendRunEvent, captureMainPiSession, summarizeAgentPrompt, summarizeAgentTurn } from "../src/run-log.js";

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

test("concurrent run event writes remain valid JSONL and preserve every event", async () => {
  const root = await mkdtemp(join(tmpdir(), "peac-run-log-concurrent-"));
  try {
    await Promise.all(Array.from({ length: 250 }, (_, index) =>
      appendRunEvent(root, "concurrent_fixture", { index, payload: "x".repeat(256) })));
    const lines = (await readFile(join(root, ".runtime", "events.jsonl"), "utf8")).trim().split("\n");
    assert.equal(lines.length, 250);
    const parsed = lines.map((line) => JSON.parse(line) as { type: string; index: number });
    assert.ok(parsed.every((entry) => entry.type === "concurrent_fixture"));
    assert.deepEqual(parsed.map((entry) => entry.index).sort((a, b) => a - b), Array.from({ length: 250 }, (_, index) => index));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Main Pi session capture keeps only a bounded recent diagnostic snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "peac-main-session-bounded-"));
  try {
    const entries = Array.from({ length: 500 }, (_, index) => ({
      type: "message",
      id: `entry-${index}`,
      message: {
        role: index % 2 === 0 ? "assistant" : "user",
        content: [{
          type: "text",
          text: `ENTRY-${index}-${"x".repeat(20_000)}`,
        }],
      },
    }));
    await captureMainPiSession(root, entries);
    const raw = await readFile(join(root, ".runtime", "main-pi-session.json"), "utf8");
    const snapshot = JSON.parse(raw) as {
      source_entry_count: number;
      retained_entry_count: number;
      truncated: boolean;
      entries: unknown[];
    };
    assert.ok(Buffer.byteLength(raw, "utf8") <= MAX_MAIN_PI_SESSION_BYTES);
    assert.equal(snapshot.source_entry_count, 500);
    assert.equal(snapshot.retained_entry_count, snapshot.entries.length);
    assert.ok(snapshot.retained_entry_count > 0);
    assert.ok(snapshot.retained_entry_count <= 120);
    assert.equal(snapshot.truncated, true);
    assert.match(raw, /ENTRY-499-/);
    assert.doesNotMatch(raw, /ENTRY-0-/);
    assert.match(raw, /diagnostic string truncated/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent prompt diagnostics keep a digest and bounded head/tail instead of the full prompt", () => {
  const prompt = `HEAD-${"x".repeat(4_000)}-TAIL`;
  const summary = summarizeAgentPrompt(prompt);
  assert.equal(summary.prompt_bytes, Buffer.byteLength(prompt, "utf8"));
  assert.equal((summary.prompt_sha256 as string).length, 64);
  assert.ok((summary.prompt_head as string).startsWith("HEAD-"));
  assert.ok((summary.prompt_head as string).length < prompt.length);
  assert.ok((summary.prompt_tail as string).endsWith("-TAIL"));
  assert.ok(!JSON.stringify(summary).includes("x".repeat(3_000)), "full prompt body must not be stored");
});

test("agent turn diagnostics bound the text and replace the structured report with a digest", () => {
  const text = "t".repeat(30_000);
  const structured = { phase_id: "phase-01", round: 2, verdict: "REWORK", findings: [{ evidence: "e".repeat(5_000) }] };
  const summary = summarizeAgentTurn(text, structured);
  assert.equal(summary.text_bytes, 30_000);
  assert.match(summary.text as string, /audit text truncated; 30000 bytes total/);
  assert.ok((summary.text as string).length < 30_000);
  assert.equal(summary.structured_phase_id, "phase-01");
  assert.equal(summary.structured_round, 2);
  assert.equal(summary.structured_verdict, "REWORK");
  assert.equal(typeof summary.structured_sha256, "string");
  assert.ok(!JSON.stringify(summary).includes("e".repeat(1_000)), "structured report body must not be duplicated");
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
