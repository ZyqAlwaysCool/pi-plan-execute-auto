import { createHash } from "node:crypto";
import { execFile as callback } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import assert from "node:assert/strict";
import { approvedSetup, frozenProfileMatches, runSetupWizard } from "../extensions/index.js";
import type { WorkflowState } from "../src/types.js";
import { inspectClaudeNativeSandbox, loadProjectPluginProfile, normalizeSelectedModel, parseOpenCodeModels, parsePiModels, saveProjectPluginProfile } from "../src/plugin-config.js";

const execFile = promisify(callback);
async function fixture(): Promise<{ root: string; project: string; agentDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "peac-setup-test-"));
  const project = join(root, "repository");
  const agentDir = join(root, "pi-agent");
  await mkdir(project);
  await mkdir(agentDir);
  await execFile("git", ["init", "-q", project]);
  return { root, project, agentDir };
}

test("CLI catalog candidates remain explicit and are not silently substituted", () => {
  assert.deepEqual(parseOpenCodeModels("deepseek-local/deepseek-flash\ninvalid\ndeepseek-local/deepseek-flash\nopencode/big-pickle\n"), [
    "opencode/deepseek-local/deepseek-flash", "opencode/opencode/big-pickle",
  ]);
  assert.equal(normalizeSelectedModel("codex", "gpt-6-luna"), "codex/gpt-6-luna");
  assert.equal(normalizeSelectedModel("claude", "opus[1m]"), "claude/opus[1m]");
  assert.equal(normalizeSelectedModel("pi", "openai-codex/gpt-5.5"), "pi/openai-codex/gpt-5.5");
  assert.deepEqual(parsePiModels("provider model context\nopenai-codex gpt-5.5 200K\nopenai-codex gpt-5.5 200K\n"), ["pi/openai-codex/gpt-5.5"]);
  assert.equal(normalizeSelectedModel("opencode", "opencode/deepseek-local/deepseek-flash"), "opencode/deepseek-local/deepseek-flash");
  assert.throws(() => normalizeSelectedModel("opencode", "gpt-6-luna"), /Invalid/);
  assert.throws(() => normalizeSelectedModel("codex", "gpt-6-luna; touch escape"), /Invalid/);
});

test("Claude native sandbox preflight only requires socat when the user's own Claude configuration enables it", async () => {
  const { root, project } = await fixture();
  const config = join(root, "claude-config");
  const projectClaude = join(project, ".claude");
  try {
    await mkdir(config);
    await writeFile(join(config, "settings.json"), JSON.stringify({ sandbox: { enabled: true } }));
    const enabled = await inspectClaudeNativeSandbox(project, { CLAUDE_CONFIG_DIR: config, PATH: "" });
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.socat, undefined);
    assert.match(enabled.sources.join("\n"), /sandbox\.enabled=true/);

    await mkdir(projectClaude);
    await writeFile(join(projectClaude, "settings.local.json"), JSON.stringify({ sandbox: { enabled: false } }));
    const disabledByProject = await inspectClaudeNativeSandbox(project, { CLAUDE_CONFIG_DIR: config, PATH: "" });
    assert.equal(disabledByProject.enabled, false);

    const forcedByUserEnv = await inspectClaudeNativeSandbox(project, {
      CLAUDE_CONFIG_DIR: config, PATH: "", CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    });
    assert.equal(forcedByUserEnv.enabled, true);
    assert.match(forcedByUserEnv.sources.join("\n"), /SUBPROCESS_ENV_SCRUB/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("per-repository human setup stores no secrets and overrides model-supplied routes", async () => {
  const { root, project, agentDir } = await fixture();
  try {
    assert.equal(await loadProjectPluginProfile(project, agentDir), undefined);
    await assert.rejects(approvedSetup(project, true, undefined, agentDir), /\/plan-execute setup/);
    const saved = await saveProjectPluginProfile(project, {
      executorModel: "opencode/deepseek-local/deepseek-flash",
      reviewerModel: "codex/gpt-6-luna",
      reasoningEffort: "high",
    }, agentDir);
    assert.ok(saved.networkRiskApprovedAt);
    const files = await readdir(join(agentDir, "plan-execute-auto", "profiles"));
    assert.deepEqual(files, [`${createHash("sha256").update(resolve(project)).digest("hex")}.json`]);
    const path = join(agentDir, "plan-execute-auto", "profiles", files[0]!);
    assert.equal((await lstat(path)).mode & 0o077, 0);
    assert.doesNotMatch(await readFile(path, "utf8"), /auth\.json|apiKey|temporary-provider-key/);
    assert.deepEqual(await loadProjectPluginProfile(project, agentDir), saved);
    const cached = join(project, ".pi-plan-execute-auto", "config.json");
    const local = await readFile(cached, "utf8");
    assert.doesNotMatch(local, /networkRiskApprovedAt|apiKey|auth.json/);
    assert.equal(JSON.parse(local).executorModel, saved.executorModel);
    await writeFile(cached, local.replace(saved.executorModel, "pi/openai-codex/gpt-5.5"));
    await assert.rejects(loadProjectPluginProfile(project, agentDir), /differs from the human-approved selection/);
    await writeFile(cached, local);
    const frozen = {
      executor_model: saved.executorModel,
      reviewer_model: saved.reviewerModel,
      reasoning_effort: "high",
      permission_mode: saved.permissionMode,
      review_round_limit: saved.reviewRoundLimit,
    } as WorkflowState;
    assert.equal(frozenProfileMatches(frozen, saved), true);
    assert.equal(frozenProfileMatches(frozen, saved, "opencode/opencode/big-pickle"), false);
    const missingEffort = { ...frozen };
    delete missingEffort.reasoning_effort;
    assert.equal(frozenProfileMatches(missingEffort, saved), false);
    assert.equal((await approvedSetup(project, true, undefined, agentDir)).reasoningEffort, "high");
    await assert.rejects(approvedSetup(project, true, { executor_model: "opencode/opencode/big-pickle" }, agentDir), /Model-supplied ACP routes differ/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive wizard records only a separate human network consent and confirmed selections", async () => {
  const { root, project, agentDir } = await fixture();
  const clis = [
    { backend: "opencode" as const, executable: "/usr/bin/opencode", version: "OpenCode fixture", models: ["opencode/deepseek-local/deepseek-flash"] },
    { backend: "codex" as const, executable: "/usr/bin/codex", version: "Codex fixture", models: [] },
  ];
  let consent = false;
  let confirmations = 0;
  let codexProbes = 0;
  let cliProbes = 0;
  let manualInputs = 0;
  let connectivityChecks = 0;
  const warnings: string[] = [];
  const progress: Array<string | undefined> = [];
  const discoverCodex = async () => { codexProbes += 1; return ["codex/gpt-6-luna"]; };
  const discoverClis = async () => { cliProbes += 1; return clis; };
  const discoverEfforts = async () => ["low", "medium", "high"] as Array<"low" | "medium" | "high" | "max">;
  const ctx = {
    cwd: project,
    hasUI: true,
    ui: {
      notify(message: string, level: string) { if (level === "warning") warnings.push(message); },
      setStatus(_key: string, value: string | undefined) { progress.push(value); },
      async select(title: string, choices: string[]) {
        if (title.includes("model (candidates")) return choices[0];
        if (title.includes(": reasoning effort")) return choices[2];
        if (title.startsWith("Executor:")) return choices[0];
        if (title.startsWith("Reviewer:")) return choices[1];
        if (title.startsWith("Maximum review rounds")) return choices[1];
        if (title.startsWith("Agent permission handling")) return choices[0];
        throw new Error(`Unexpected selection: ${title}`);
      },
      async input() { manualInputs += 1; return "gpt-6-luna"; },
      async confirm(title: string, message: string) {
        confirmations += 1;
        if (title.includes("discovery")) assert.match(message, /mounts no project files/);
        else if (title.includes("live Agent CLI connectivity")) assert.match(message, /may incur provider charges/);
        else { assert.match(title, /Agent CLI network access/); assert.match(message, /normal network access|normal standalone CLI session/); }
        return consent;
      },
    },
  } as unknown as Parameters<typeof runSetupWizard>[0];
  try {
    assert.equal(await runSetupWizard(ctx, discoverClis, agentDir, discoverCodex, discoverEfforts), undefined);
    assert.equal(codexProbes, 0);
    assert.equal(cliProbes, 0); // No CLI or ACP process is launched before risk consent.
    assert.equal(await loadProjectPluginProfile(project, agentDir), undefined);
    consent = true;
    const configured = await runSetupWizard(
      ctx,
      discoverClis,
      agentDir,
      discoverCodex,
      discoverEfforts,
      async () => { connectivityChecks += 1; },
    );
    assert.equal(confirmations, 4);
    assert.equal(cliProbes, 1);
    assert.equal(codexProbes, 1);
    assert.equal(manualInputs, 0);
    assert.equal(connectivityChecks, 2);
    assert.ok(progress.some((message) => message?.includes("loading codex ACP models")));
    assert.ok(progress.some((message) => message?.includes("Checking codex/gpt-6-luna")));
    assert.equal(progress.at(-1), undefined);
    assert.equal(configured?.executorModel, "opencode/deepseek-local/deepseek-flash");
    assert.equal(configured?.reviewerModel, "codex/gpt-6-luna");
    assert.equal(configured?.executorReasoningEffort, "high");
    assert.equal(configured?.reviewerReasoningEffort, "high");
    assert.equal(configured?.reviewRoundLimit, 5);
    assert.equal(configured?.permissionMode, "autonomous");
    assert.deepEqual(await loadProjectPluginProfile(project, agentDir), configured);
    const fallback = await runSetupWizard(
      ctx,
      clis,
      agentDir,
      async () => { throw new Error("ACP catalog unavailable"); },
      discoverEfforts,
      async () => { connectivityChecks += 1; },
    );
    assert.equal(fallback?.reviewerModel, "codex/gpt-6-luna");
    assert.equal(manualInputs, 1);
    assert.match(warnings.join("\n"), /ACP catalog unavailable.*Enter an exact model ID manually/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("all four backend routes share one wizard; reasoning is chosen independently per role", async () => {
  const { root, project, agentDir } = await fixture();
  let smokeApprovals = 0;
  let checkedModels = 0;
  const ctx = {
    cwd: project, hasUI: true, ui: {
      notify() {},
      async confirm(title: string, message: string) {
        if (title.includes("live Agent CLI connectivity")) { smokeApprovals += 1; assert.match(message, /may incur provider charges/); }
        return true;
      },
      async select(title: string, choices: string[]) {
        if (title.startsWith("Executor: choose")) return choices[0];
        if (title.startsWith("Reviewer: choose")) return choices[1];
        if (title.includes("claude model")) { assert.deepEqual(choices.slice(0, 1), ["claude/sonnet"]); return choices[0]; }
        if (title.includes("pi model")) { assert.deepEqual(choices.slice(0, 1), ["pi/openai-codex/gpt-5.5"]); return choices[0]; }
        if (title.startsWith("Executor: reasoning effort")) { assert.deepEqual(choices, ["low", "medium", "high", "max", "backend default", "Cancel"]); return "max"; }
        if (title.startsWith("Reviewer: reasoning effort")) { assert.deepEqual(choices, ["low", "medium", "high", "backend default", "Cancel"]); return "medium"; }
        if (title.startsWith("Maximum review rounds")) return choices[1];
        if (title.startsWith("Agent permission handling")) return choices[1];
        throw new Error(`Unexpected choice: ${title}`);
      },
      async input() { throw new Error("Model catalogs must be selectable without typing IDs"); },
    },
  } as unknown as Parameters<typeof runSetupWizard>[0];
  try {
    const profile = await runSetupWizard(ctx, [
      { backend: "claude", version: "2.1.196", executable: "/bin/claude", models: [] },
      { backend: "pi", version: "0.87.1", executable: "/bin/pi", models: ["pi/openai-codex/gpt-5.5", "pi/openai-codex/gpt-6-luna"] },
    ], agentDir, async (_, backend) => backend === "pi" ? ["pi/openai-codex/gpt-5.5"] : ["claude/sonnet"],
    async (_, backend) => backend === "pi" ? ["low", "medium", "high"] : ["low", "medium", "high", "max"],
    async (_root, model, effort) => { checkedModels += 1; assert.equal(effort, model === "claude/sonnet" ? "max" : "medium"); },
    async () => ({ enabled: false, sources: [] }));
    assert.equal(smokeApprovals, 1);
    assert.equal(checkedModels, 2);
    assert.equal(profile?.executorModel, "claude/sonnet");
    assert.equal(profile?.reviewerModel, "pi/openai-codex/gpt-5.5");
    assert.equal(profile?.executorReasoningEffort, "max");
    assert.equal(profile?.reviewerReasoningEffort, "medium");
    assert.equal(profile?.reasoningEffort, undefined);
    assert.equal(profile?.reviewRoundLimit, 5);
    assert.equal(profile?.permissionMode, "ask");
    assert.equal(JSON.parse(await readFile(join(project, ".pi-plan-execute-auto", "config.json"), "utf8")).reviewerReasoningEffort, "medium");
    assert.deepEqual(await loadProjectPluginProfile(project, agentDir), profile);
    const frozen = {
      executor_model: profile?.executorModel, reviewer_model: profile?.reviewerModel,
      executor_reasoning_effort: "max", reviewer_reasoning_effort: "medium",
      permission_mode: "ask", review_round_limit: 5,
    } as WorkflowState;
    assert.equal(frozenProfileMatches(frozen, profile!), true);
    assert.equal(frozenProfileMatches({ ...frozen, reviewer_reasoning_effort: "high" }, profile!), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("setup shows a live progress indicator during ACP catalog discovery and clears it on failure", async () => {
  const { root, project, agentDir } = await fixture();
  const statuses: Array<string | undefined> = [];
  let release!: (models: string[]) => void;
  const catalog = new Promise<string[]>((resolve) => { release = resolve; });
  const ctx = {
    cwd: project, hasUI: true, mode: "tui", ui: {
      setStatus(_key: string, value: string | undefined) { statuses.push(value); },
      notify() {},
      async confirm() { return true; },
      async select(title: string, options: string[]) {
        if (title === "Executor: choose local coding CLI") return options[0];
        if (title.includes("model (candidates")) return options[0];
        throw new Error(`Unexpected selection ${title}`);
      },
    },
  } as unknown as Parameters<typeof runSetupWizard>[0];
  try {
    const task = runSetupWizard(ctx, [
      { backend: "codex", executable: "/bin/codex", version: "fixture", models: [] },
    ], agentDir, async () => catalog, async () => { throw new Error("effort discovery failed"); });
    await new Promise((resolve) => setTimeout(resolve, 280));
    assert.ok(statuses.length >= 2, "spinner should update while catalog is pending");
    assert.match(statuses[0] ?? "", /loading codex ACP models/);
    assert.notEqual(statuses[0], statuses[1]);
    release(["codex/gpt-6-luna"]);
    await assert.rejects(task, /effort discovery failed/);
    assert.equal(statuses.at(-1), undefined);
    assert.equal(await loadProjectPluginProfile(project, agentDir), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("declined live Agent CLI connectivity preflight stores no project or consent file", async () => {
  const { root, project, agentDir } = await fixture();
  const ctx = {
    cwd: project, hasUI: true, ui: {
      notify() {},
      async confirm(title: string) { return !title.includes("live Agent CLI connectivity"); },
      async select(title: string, choices: string[]) {
        if (title.includes("model (candidates")) return choices[0];
        if (title.includes(": reasoning effort")) return "medium";
        if (title.startsWith("Maximum review rounds")) return choices[0];
        if (title.startsWith("Agent permission handling")) return choices[0];
        return choices[0];
      },
      async input() { throw new Error("Unexpected manual input"); },
    },
  } as unknown as Parameters<typeof runSetupWizard>[0];
  try {
    assert.equal(await runSetupWizard(ctx, [
      { backend: "pi", executable: "/bin/pi", version: "fixture", models: ["pi/openai-codex/gpt-5.5"] },
    ], agentDir, async () => ["pi/openai-codex/gpt-5.5"], async () => ["low", "medium", "high"],
    async () => { throw new Error("No model request should start without separate human approval"); }), undefined);
    assert.equal(await loadProjectPluginProfile(project, agentDir), undefined);
    await assert.rejects(readFile(join(project, ".pi-plan-execute-auto", "config.json")), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("replaced Git repository invalidates saved project network consent", async () => {
  const { root, project, agentDir } = await fixture();
  try {
    await saveProjectPluginProfile(project, {
      executorModel: "opencode/deepseek-local/deepseek-flash", reviewerModel: "codex/gpt-6-luna",
    }, agentDir);
    await rename(join(project, ".git"), join(project, ".git-backup"));
    await mkdir(join(project, ".git"));
    await assert.rejects(loadProjectPluginProfile(project, agentDir), /different Git repository/);
    const refreshed = await saveProjectPluginProfile(project, {
      executorModel: "opencode/deepseek-local/deepseek-flash", reviewerModel: "codex/gpt-6-luna",
    }, agentDir);
    assert.deepEqual(await loadProjectPluginProfile(project, agentDir), refreshed);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("profile loader rejects a symlink even when its target is valid JSON", async () => {
  const { root, project, agentDir } = await fixture();
  try {
    await saveProjectPluginProfile(project, {
      executorModel: "opencode/deepseek-local/deepseek-flash", reviewerModel: "codex/gpt-6-luna",
    }, agentDir);
    const dir = join(agentDir, "plan-execute-auto", "profiles");
    const [name] = await readdir(dir);
    assert.ok(name);
    const path = join(dir, name);
    const backup = join(root, "backup.json");
    await rename(path, backup);
    await symlink(backup, path);
    await assert.rejects(loadProjectPluginProfile(project, agentDir), /unsafe plan-execute configuration/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the project cache cannot be redirected by a symlink or grant network consent", async () => {
  const { root, project, agentDir } = await fixture();
  try {
    await saveProjectPluginProfile(project, { executorModel: "codex/gpt-6-luna", reviewerModel: "opencode/deepseek-local/deepseek-flash", reasoningEffort: "medium" }, agentDir);
    const cache = join(project, ".pi-plan-execute-auto", "config.json");
    const saved = join(root, "saved-cache.json");
    await rename(cache, saved);
    await symlink(saved, cache);
    await assert.rejects(loadProjectPluginProfile(project, agentDir), /Unsafe project configuration cache/);
    await rm(cache);
    await rename(saved, cache);
    assert.equal((await loadProjectPluginProfile(project, agentDir))?.reasoningEffort, "medium");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("headless fallback remains explicit, not a hidden default", async () => {
  const { root, project, agentDir } = await fixture();
  const keys = [
    "PI_PLAN_EXECUTE_EXECUTOR_MODEL",
    "PI_PLAN_EXECUTE_REVIEWER_MODEL",
    "PI_PLAN_EXECUTE_REASONING_EFFORT",
    "PI_PLAN_EXECUTE_EXECUTOR_REASONING_EFFORT",
    "PI_PLAN_EXECUTE_REVIEWER_REASONING_EFFORT",
    "PI_PLAN_EXECUTE_PERMISSION_MODE",
    "PI_PLAN_EXECUTE_MAX_REVIEW_ROUNDS",
    "PI_PLAN_EXECUTE_ACCEPT_ACP_NETWORK_RISK",
  ] as const;
  const before = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) delete process.env[key];
    await assert.rejects(approvedSetup(project, false, undefined, agentDir), /Headless automation requires/);
    process.env.PI_PLAN_EXECUTE_EXECUTOR_MODEL = "opencode/deepseek-local/deepseek-flash";
    process.env.PI_PLAN_EXECUTE_REVIEWER_MODEL = "codex/gpt-6-luna";
    process.env.PI_PLAN_EXECUTE_REASONING_EFFORT = "high";
    await assert.rejects(approvedSetup(project, false, undefined, agentDir), /normal network access/);
    process.env.PI_PLAN_EXECUTE_ACCEPT_ACP_NETWORK_RISK = "1";
    assert.deepEqual(await approvedSetup(project, false, undefined, agentDir), {
      executorModel: "opencode/deepseek-local/deepseek-flash",
      reviewerModel: "codex/gpt-6-luna",
      reasoningEffort: "high",
      permissionMode: "autonomous",
      reviewRoundLimit: 5,
    });
    delete process.env.PI_PLAN_EXECUTE_REASONING_EFFORT;
    process.env.PI_PLAN_EXECUTE_EXECUTOR_REASONING_EFFORT = "medium";
    process.env.PI_PLAN_EXECUTE_REVIEWER_REASONING_EFFORT = "high";
    assert.deepEqual(await approvedSetup(project, false, undefined, agentDir), {
      executorModel: "opencode/deepseek-local/deepseek-flash",
      reviewerModel: "codex/gpt-6-luna",
      executorReasoningEffort: "medium",
      reviewerReasoningEffort: "high",
      permissionMode: "autonomous", reviewRoundLimit: 5,
    });
    process.env.PI_PLAN_EXECUTE_REASONING_EFFORT = "high";
    await assert.rejects(approvedSetup(project, false, undefined, agentDir), /either the legacy shared variable or the per-role variables/);
  } finally {
    keys.forEach((key, index) => {
      if (before[index] === undefined) delete process.env[key];
      else process.env[key] = before[index];
    });
    await rm(root, { recursive: true, force: true });
  }
});
