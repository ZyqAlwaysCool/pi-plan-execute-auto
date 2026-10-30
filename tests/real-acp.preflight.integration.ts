// No model turns; explicit opt-in because native CLI initialization uses host networking/auth.
import { execFile as callback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentPrismSessionPair } from "../src/agent-prism.js";
import { findBubblewrap } from "../src/sandbox.js";

// npm run prepends node_modules/.bin (including a transitive bundled codex). Tests may explicitly
// retain the caller's PATH to reproduce the Pi process instead; production never rewrites PATH.
if (process.env.PI_PLAN_EXECUTE_ACP_TEST_PATH) process.env.PATH = process.env.PI_PLAN_EXECUTE_ACP_TEST_PATH;
const git = promisify(callback);
const executorModel = process.env.PI_PLAN_EXECUTE_ACP_TEST_EXECUTOR_MODEL;
const reviewerModel = process.env.PI_PLAN_EXECUTE_ACP_TEST_REVIEWER_MODEL;
if (!executorModel || !reviewerModel?.startsWith("codex/") || process.env.PI_PLAN_EXECUTE_ACCEPT_ACP_NETWORK_RISK !== "1") {
  throw new Error("Explicit network consent and PI_PLAN_EXECUTE_ACP_TEST_EXECUTOR_MODEL / PI_PLAN_EXECUTE_ACP_TEST_REVIEWER_MODEL=codex/<model> are required. No model prompt is sent.");
}
findBubblewrap();

async function fixture(run: (cwd: string, sourceRoot: string, goldenRoot: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(dirname(process.cwd()), ".peac-config-preflight-"));
  const sourceRoot = join(root, "source");
  const cwd = join(root, "worktree");
  const goldenRoot = join(sourceRoot, ".pi-plan-execute-auto", "preflight");
  try {
    await mkdir(goldenRoot, { recursive: true });
    for (const args of [["init", "-q", sourceRoot], ["-C", sourceRoot, "config", "user.name", "Probe"], ["-C", sourceRoot, "config", "user.email", "probe@example.invalid"]]) await git("git", args);
    await writeFile(join(sourceRoot, "sample.txt"), "configuration probe only\n");
    await writeFile(join(sourceRoot, ".gitignore"), ".pi-plan-execute-auto/\n");
    for (const args of [["-C", sourceRoot, "add", "."], ["-C", sourceRoot, "commit", "-qm", "fixture"], ["-C", sourceRoot, "worktree", "add", "-q", "--detach", cwd]]) await git("git", args);
    await run(cwd, sourceRoot, goldenRoot);
    assert.equal((await git("git", ["-C", cwd, "status", "--porcelain"])).stdout, "");
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("both real role configurations pass before any model turn and record actual Codex identity", { timeout: 200_000 }, async () => {
  await fixture(async (cwd, sourceRoot, goldenRoot) => {
    const pair = new AgentPrismSessionPair({ cwd, sourceRoot, goldenRoot, runRoot: goldenRoot,
      executorModel: executorModel!, reviewerModel: reviewerModel!, reasoningEffort: "high" });
    try {
      await pair.preflight({ signal: AbortSignal.timeout(180_000) });
      const events = (await readFile(join(goldenRoot, ".runtime/events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.deepEqual(events.filter((e) => e.type === "agent_configuration_verified").map((e) => e.role), ["reviewer", "executor"]);
      const selected = events.find((e) => e.type === "agent_runtime_selected" && e.role === "reviewer");
      assert.ok(selected?.runtime.cli_path);
      assert.notEqual(selected?.runtime.cli_version, "unknown");
      assert.equal(selected?.purpose, "preflight");
    } finally { await pair.close(); }
  });
});

test("an unavailable real Codex model fails with the catalog and runtime rather than Invalid params", { timeout: 110_000 }, async () => {
  await fixture(async (cwd, sourceRoot, goldenRoot) => {
    const pair = new AgentPrismSessionPair({ cwd, sourceRoot, goldenRoot, runRoot: goldenRoot,
      executorModel: executorModel!, reviewerModel: "codex/__peac_nonexistent_model__", reasoningEffort: "high" });
    try {
      await assert.rejects(pair.preflight(), (error: Error) => {
        assert.match(error.message, /model catalog validation/);
        assert.match(error.message, /Available model IDs/);
        assert.match(error.message, /Actual Codex CLI/);
        return true;
      });
      const events = await readFile(join(goldenRoot, ".runtime/events.jsonl"), "utf8");
      assert.match(events, /agent_setup_failed/);
      assert.doesNotMatch(events, /"type":"agent_configuration_verified"/);
    } finally { await pair.close(); }
  });
});
