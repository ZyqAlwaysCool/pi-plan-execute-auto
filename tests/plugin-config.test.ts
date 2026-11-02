import { createHash } from "node:crypto";
import { execFile as callback } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import assert from "node:assert/strict";
import { approvedSetup, chooseExistingSetupAction, frozenProfileMatches, frozenProfileMismatch, runSetupWizard, stageTimeoutMs } from "../extensions/index.js";
import type { WorkflowState } from "../src/types.js";
import { inspectClaudeNativeSandbox, loadProjectPluginProfile, normalizeSelectedModel, parseOpenCodeModels, parsePiModels, saveProjectPluginProfile, type ProjectPluginProfile } from "../src/plugin-config.js";

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
    assert.deepEqual(files, [`${createHash("sha256").update(await realpath(project)).digest("hex")}.json`]);
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
    assert.deepEqual(frozenProfileMismatch(frozen, saved), []);
    assert.equal(frozenProfileMatches(frozen, saved, "opencode/opencode/big-pickle"), false);
    assert.deepEqual(frozenProfileMismatch(frozen, saved, "opencode/opencode/big-pickle"), [
      "requested executor model: opencode/opencode/big-pickle ≠ setup opencode/deepseek-local/deepseek-flash",
    ]);
    const differentTimeout = { ...saved, stageTimeoutMs: 5 * 60 * 1000 } as ProjectPluginProfile;
    assert.equal(frozenProfileMatches(frozen, differentTimeout), true);
    assert.deepEqual(frozenProfileMismatch(frozen, differentTimeout), []);
    const missingEffort = { ...frozen };
    delete missingEffort.reasoning_effort;
    assert.equal(frozenProfileMatches(missingEffort, saved), false);
    assert.deepEqual(frozenProfileMismatch(missingEffort, saved), [
      "shared reasoning effort: run (unset) ≠ setup high",
    ]);
    assert.equal((await approvedSetup(project, true, undefined, agentDir)).reasoningEffort, "high");
    await assert.rejects(approvedSetup(project, true, { executor_model: "opencode/opencode/big-pickle" }, agentDir), /Model-supplied ACP routes differ/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("existing setup can be kept without discovery or provider calls", async () => {
  const { root, project, agentDir } = await fixture();
  const notices: string[] = [];
  let checks = 0;
  try {
    const profile = await saveProjectPluginProfile(project, {
      executorModel: "opencode/deepseek-local/deepseek-flash",
      reviewerModel: "codex/gpt-6-luna",
      executorReasoningEffort: "high",
      reviewerReasoningEffort: "medium",
      permissionMode: "autonomous",
      reviewRoundLimit: 5,
    }, agentDir);
    const ctx = {
      cwd: project,
      hasUI: true,
      ui: {
        notify(message: string) { notices.push(message); },
        async select(title: string, choices: string[]) {
          assert.equal(title, "Plan Execute Setup");
          assert.deepEqual(choices, [
            "Keep current setup",
            "Run health check — optional, may incur provider charges",
            "Reconfigure",
            "Cancel",
          ]);
          return "Keep current setup";
        },
        async confirm() { throw new Error("Keep must not request confirmation"); },
      },
    } as unknown as Parameters<typeof chooseExistingSetupAction>[0];
    assert.equal(await chooseExistingSetupAction(ctx, profile, async () => { checks += 1; }), "keep");
    assert.equal(checks, 0);
    assert.match(notices.join("\n"), /Current project setup/);
    assert.match(notices.join("\n"), /No CLI discovery, model probe, or provider call was run/);
    assert.deepEqual(await loadProjectPluginProfile(project, agentDir), profile);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("existing setup health check is optional and never rewrites the saved profile", async () => {
  const { root, project, agentDir } = await fixture();
  try {
    const profile = await saveProjectPluginProfile(project, {
      executorModel: "pi/openai-codex/gpt-5.5",
      reviewerModel: "pi/openai-codex/gpt-5.5",
      executorReasoningEffort: "high",
      reviewerReasoningEffort: "high",
      permissionMode: "ask",
      reviewRoundLimit: 8,
    }, agentDir);
    const protectedBefore = JSON.stringify(profile);
    let checks = 0;
    const notices: string[] = [];
    const ctx = {
      cwd: project,
      hasUI: true,
      ui: {
        notify(message: string) { notices.push(message); },
        async select() { return "Run health check — optional, may incur provider charges"; },
        async confirm(title: string, message: string) {
          assert.match(title, /health check for current setup/i);
          assert.match(message, /may incur provider charges/);
          assert.match(message, /saved project setup will not be changed/i);
          return true;
        },
        setStatus() {},
      },
    } as unknown as Parameters<typeof chooseExistingSetupAction>[0];
    assert.equal(await chooseExistingSetupAction(ctx, profile, async (_root, model, effort) => {
      checks += 1;
      assert.equal(model, "pi/openai-codex/gpt-5.5");
      assert.equal(effort, "high");
    }), "keep");
    assert.equal(checks, 1, "identical Executor/Reviewer routes should be checked once");
    assert.match(notices.join("\n"), /Health check passed/);
    assert.equal(JSON.stringify(await loadProjectPluginProfile(project, agentDir)), protectedBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed health check leaves the existing setup untouched", async () => {
  const { root, project, agentDir } = await fixture();
  try {
    const profile = await saveProjectPluginProfile(project, {
      executorModel: "codex/gpt-6-luna",
      reviewerModel: "opencode/deepseek-local/deepseek-flash",
      executorReasoningEffort: "high",
      reviewerReasoningEffort: "medium",
    }, agentDir);
    const before = JSON.stringify(profile);
    const ctx = {
      cwd: project,
      hasUI: true,
      ui: {
        notify() {},
        async select() { return "Run health check — optional, may incur provider charges"; },
        async confirm() { return true; },
        setStatus() {},
      },
    } as unknown as Parameters<typeof chooseExistingSetupAction>[0];
    await assert.rejects(
      chooseExistingSetupAction(ctx, profile, async () => { throw new Error("fixture provider unavailable"); }),
      /fixture provider unavailable/,
    );
    assert.equal(JSON.stringify(await loadProjectPluginProfile(project, agentDir)), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reconfigure warns that existing approved runs keep frozen settings", async () => {
  const { root, project, agentDir } = await fixture();
  let warning = "";
  try {
    const profile = await saveProjectPluginProfile(project, {
      executorModel: "opencode/deepseek-local/deepseek-flash",
      reviewerModel: "codex/gpt-6-luna",
    }, agentDir);
    const ctx = {
      cwd: project,
      hasUI: true,
      ui: {
        notify() {},
        async select() { return "Reconfigure"; },
        async confirm(title: string, message: string) {
          assert.equal(title, "Reconfigure this project?");
          warning = message;
          return true;
        },
      },
    } as unknown as Parameters<typeof chooseExistingSetupAction>[0];
    assert.equal(await chooseExistingSetupAction(ctx, profile), "reconfigure");
    assert.match(warning, /future plans\/runs/);
    assert.match(warning, /Existing approved runs keep the settings frozen/);
    assert.match(warning, /will not silently switch agents/);
    assert.match(warning, /execution timeout is an operational policy/);
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
        if (title.startsWith("Execution timeout")) return choices[2];
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
    assert.equal(configured?.stageTimeoutMs, 30 * 60 * 1000);
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

test("live connectivity health check can be skipped without cancelling setup", async () => {
  const { root, project, agentDir } = await fixture();
  let checks = 0;
  const notices: string[] = [];
  const ctx = {
    cwd: project,
    hasUI: true,
    ui: {
      notify(message: string) { notices.push(message); },
      async confirm(title: string) {
        if (title.includes("live Agent CLI connectivity")) return false;
        return true;
      },
      async select(title: string, choices: string[]) {
        if (title.startsWith("Executor: choose")) return choices[0];
        if (title.startsWith("Reviewer: choose")) return choices[1];
        if (title.includes("model (candidates")) return choices[0];
        if (title.includes(": reasoning effort")) return "high";
        if (title.startsWith("Maximum review rounds")) return choices[1];
        if (title.startsWith("Execution timeout")) return choices[1];
        if (title.startsWith("Agent permission handling")) return choices[0];
        throw new Error(`Unexpected selection: ${title}`);
      },
      async input() { throw new Error("manual model input not expected"); },
    },
  } as unknown as Parameters<typeof runSetupWizard>[0];
  try {
    const profile = await runSetupWizard(
      ctx,
      [
        { backend: "opencode", executable: "/bin/opencode", version: "OpenCode fixture", models: ["opencode/deepseek-local/deepseek-flash"] },
        { backend: "codex", executable: "/bin/codex", version: "Codex fixture", models: ["codex/gpt-6-luna"] },
      ],
      agentDir,
      async (_root, backend) => backend === "opencode"
        ? ["opencode/deepseek-local/deepseek-flash"]
        : ["codex/gpt-6-luna"],
      async () => ["low", "medium", "high"],
      async () => { checks += 1; },
    );
    assert.ok(profile);
    assert.equal(checks, 0);
    assert.equal(profile?.executorModel, "opencode/deepseek-local/deepseek-flash");
    assert.equal(profile?.reviewerModel, "codex/gpt-6-luna");
    assert.match(notices.join("\n"), /connectivity checks skipped/i);
    assert.deepEqual(await loadProjectPluginProfile(project, agentDir), profile);
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
        if (title.startsWith("Execution timeout")) return choices[4];
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
    assert.equal(profile?.stageTimeoutMs, 0);
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

test("declined live Agent CLI connectivity check skips provider call and still saves setup", async () => {
  const { root, project, agentDir } = await fixture();
  let providerCalls = 0;
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
    const configured = await runSetupWizard(ctx, [
      { backend: "pi", executable: "/bin/pi", version: "fixture", models: ["pi/openai-codex/gpt-5.5"] },
    ], agentDir, async () => ["pi/openai-codex/gpt-5.5"], async () => ["low", "medium", "high"],
    async () => { providerCalls += 1; });
    assert.ok(configured);
    assert.equal(providerCalls, 0);
    assert.deepEqual(await loadProjectPluginProfile(project, agentDir), configured);
    assert.equal(JSON.parse(await readFile(join(project, ".pi-plan-execute-auto", "config.json"), "utf8")).executorModel, configured?.executorModel);
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

test("the setup wizard supports a validated custom timeout and an explicit no-timeout run", async () => {
  const { root, project, agentDir } = await fixture();
  let timeoutChoice = "Custom…";
  const inputValues = ["not-a-number", "45"];
  const inputs: string[] = [];
  const warnings: string[] = [];
  const ctx = {
    cwd: project, hasUI: true, ui: {
      notify(message: string, level?: string) { if (level === "warning") warnings.push(message); },
      setStatus() {},
      async select(title: string, choices: string[]) {
        if (title.includes("model (candidates")) return choices[0];
        if (title.includes(": reasoning effort")) return "medium";
        if (title.startsWith("Executor:")) return choices[0];
        if (title.startsWith("Reviewer:")) return choices[0];
        if (title.startsWith("Maximum review rounds")) return choices[0];
        if (title.startsWith("Execution timeout")) return timeoutChoice;
        if (title.startsWith("Agent permission handling")) return choices[0];
        throw new Error(`Unexpected selection: ${title}`);
      },
      async input(title: string) { inputs.push(title); return inputValues.shift(); },
      async confirm(title: string) { return !title.includes("live Agent CLI connectivity"); },
    },
  } as unknown as Parameters<typeof runSetupWizard>[0];
  const clis = [{ backend: "pi" as const, executable: "/bin/pi", version: "fixture", models: ["pi/openai-codex/gpt-5.5"] }];
  try {
    const custom = await runSetupWizard(ctx, clis, agentDir,
      async () => ["pi/openai-codex/gpt-5.5"], async () => ["low", "medium", "high"], async () => {});
    assert.equal(custom?.stageTimeoutMs, 45 * 60 * 1000);
    assert.equal(inputs.length, 2);
    assert.match(warnings.join("\n"), /whole number of minutes/);

    timeoutChoice = "No timeout — run until it finishes";
    const unlimited = await runSetupWizard(ctx, clis, agentDir,
      async () => ["pi/openai-codex/gpt-5.5"], async () => ["low", "medium", "high"], async () => {});
    assert.equal(unlimited?.stageTimeoutMs, 0);
    assert.equal(JSON.parse(await readFile(join(project, ".pi-plan-execute-auto", "config.json"), "utf8")).stageTimeoutMs, 0);

    timeoutChoice = "5 minutes";
    const short = await runSetupWizard(ctx, clis, agentDir,
      async () => ["pi/openai-codex/gpt-5.5"], async () => ["low", "medium", "high"], async () => {});
    assert.equal(short?.stageTimeoutMs, 5 * 60 * 1000);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("saved execution timeouts are validated and covered by the human-approved cache and profile", async () => {
  const { root, project, agentDir } = await fixture();
  const models = { executorModel: "codex/gpt-6-luna", reviewerModel: "opencode/deepseek-local/deepseek-flash" };
  try {
    await assert.rejects(saveProjectPluginProfile(project, { ...models, stageTimeoutMs: 30_000 }, agentDir), /Execution timeout/);
    await assert.rejects(saveProjectPluginProfile(project, { ...models, stageTimeoutMs: 86_400_001 }, agentDir), /Execution timeout/);
    const saved = await saveProjectPluginProfile(project, { ...models, stageTimeoutMs: 45 * 60 * 1000 }, agentDir);
    assert.equal(saved.stageTimeoutMs, 45 * 60 * 1000);
    const cache = join(project, ".pi-plan-execute-auto", "config.json");
    const cached = JSON.parse(await readFile(cache, "utf8"));
    assert.equal(cached.stageTimeoutMs, 45 * 60 * 1000);
    cached.stageTimeoutMs = 5 * 60 * 1000;
    await writeFile(cache, `${JSON.stringify(cached, null, 2)}\n`);
    await assert.rejects(loadProjectPluginProfile(project, agentDir), /differs from the human-approved selection/);

    await saveProjectPluginProfile(project, { ...models, stageTimeoutMs: 45 * 60 * 1000 }, agentDir);
    const profileDir = join(agentDir, "plan-execute-auto", "profiles");
    const [profileFile] = await readdir(profileDir);
    const profilePath = join(profileDir, profileFile!);
    const profile = JSON.parse(await readFile(profilePath, "utf8"));
    profile.stageTimeoutMs = 60;
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
    await assert.rejects(loadProjectPluginProfile(project, agentDir), /invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("stage timeout resolution prefers the approved profile and the explicit headless env fallback", () => {
  const profile = { stageTimeoutMs: 15 * 60 * 1000 } as ProjectPluginProfile;
  assert.equal(stageTimeoutMs(profile, {} as NodeJS.ProcessEnv), 15 * 60 * 1000);
  assert.equal(stageTimeoutMs(profile, { PI_PLAN_EXECUTE_STAGE_B_TIMEOUT_MS: "60000" } as NodeJS.ProcessEnv), 15 * 60 * 1000);
  assert.equal(stageTimeoutMs(undefined, { PI_PLAN_EXECUTE_STAGE_B_TIMEOUT_MS: "60000" } as NodeJS.ProcessEnv), 60_000);
  assert.equal(stageTimeoutMs(undefined, { PI_PLAN_EXECUTE_STAGE_B_TIMEOUT_MS: "none" } as NodeJS.ProcessEnv), 0);
  assert.equal(stageTimeoutMs(undefined, { PI_PLAN_EXECUTE_STAGE_B_TIMEOUT_MS: "0" } as NodeJS.ProcessEnv), 0);
  assert.equal(stageTimeoutMs(undefined, { PI_PLAN_EXECUTE_STAGE_B_TIMEOUT_MS: "-5" } as NodeJS.ProcessEnv), 30 * 60 * 1000);
  assert.equal(stageTimeoutMs(undefined, { PI_PLAN_EXECUTE_STAGE_B_TIMEOUT_MS: "12" } as NodeJS.ProcessEnv), 30 * 60 * 1000);
  assert.equal(stageTimeoutMs(undefined, {} as NodeJS.ProcessEnv), 30 * 60 * 1000);
  assert.equal(stageTimeoutMs({ stageTimeoutMs: 0 } as ProjectPluginProfile, { PI_PLAN_EXECUTE_STAGE_B_TIMEOUT_MS: "60000" } as NodeJS.ProcessEnv), 0);
});

test("deeper backend reasoning labels survive profile save, reload and headless selection", async () => {
  const { root, project, agentDir } = await fixture();
  const keys = ["PI_PLAN_EXECUTE_EXECUTOR_MODEL", "PI_PLAN_EXECUTE_REVIEWER_MODEL",
    "PI_PLAN_EXECUTE_EXECUTOR_REASONING_EFFORT", "PI_PLAN_EXECUTE_REVIEWER_REASONING_EFFORT",
    "PI_PLAN_EXECUTE_ACCEPT_ACP_NETWORK_RISK"] as const;
  const before = keys.map((key) => process.env[key]);
  try {
    await saveProjectPluginProfile(project, {
      executorModel: "pi/openai-codex/gpt-6.1-terra", reviewerModel: "codex/gpt-6.1-sol",
      executorReasoningEffort: "xhigh", reviewerReasoningEffort: "ultra",
    }, agentDir);
    const loaded = await loadProjectPluginProfile(project, agentDir);
    assert.equal(loaded?.executorReasoningEffort, "xhigh");
    assert.equal(loaded?.reviewerReasoningEffort, "ultra");
    for (const key of keys) delete process.env[key];
    process.env.PI_PLAN_EXECUTE_EXECUTOR_MODEL = "pi/openai-codex/gpt-6.1-terra";
    process.env.PI_PLAN_EXECUTE_REVIEWER_MODEL = "codex/gpt-6.1-sol";
    process.env.PI_PLAN_EXECUTE_EXECUTOR_REASONING_EFFORT = "xhigh";
    process.env.PI_PLAN_EXECUTE_REVIEWER_REASONING_EFFORT = "ultra";
    process.env.PI_PLAN_EXECUTE_ACCEPT_ACP_NETWORK_RISK = "1";
    const selection = await approvedSetup(project, false, undefined, agentDir);
    assert.equal(selection?.executorReasoningEffort, "xhigh");
    assert.equal(selection?.reviewerReasoningEffort, "ultra");
    assert.equal(selection?.profile?.reviewerReasoningEffort, "ultra");
  } finally {
    keys.forEach((key, index) => { if (before[index] === undefined) delete process.env[key]; else process.env[key] = before[index]; });
    await rm(root, { recursive: true, force: true });
  }
});

test("a malformed persisted reasoning label is still rejected on load", async () => {
  const { root, project, agentDir } = await fixture();
  try {
    await saveProjectPluginProfile(project, { executorModel: "codex/gpt-6-luna", reviewerModel: "codex/gpt-6-luna", reviewerReasoningEffort: "xhigh" }, agentDir);
    const profiles = join(agentDir, "plan-execute-auto", "profiles");
    const [profileFile] = await readdir(profiles);
    const path = join(profiles, profileFile!);
    const saved = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    saved.reviewerReasoningEffort = "X HIGH";
    await writeFile(path, `${JSON.stringify(saved)}\n`);
    await assert.rejects(loadProjectPluginProfile(project, agentDir), /invalid|unsafe plan-execute configuration/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});
