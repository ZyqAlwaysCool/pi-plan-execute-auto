import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants, realpathSync, statSync, accessSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { AcpAgent } from "@automatalabs/workflows";
import { createSandboxedBackend, supportedBackendForModel, verifySandboxBoundary } from "./sandbox.js";
import type { ReasoningEffort } from "./types.js";

const execFile = promisify(execFileCallback);
const MAX_PROFILE_BYTES = 16 * 1024;
const MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,180}$/u;

export type AcpBackend = "claude" | "codex" | "opencode" | "pi";
export interface ProjectPluginProfile {
  version: 1;
  projectRoot: string;
  gitEntry: string;
  executorModel: string;
  reviewerModel: string;
  reasoningEffort?: ReasoningEffort;
  /** Digest of the project-local, untrusted preference cache approved by the human. */
  configSha256: string;
  networkRiskApprovedAt: string;
}

export interface DetectedCli {
  backend: AcpBackend;
  executable: string;
  version: string;
  models: string[];
}

function regularObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeSelectedModel(backend: AcpBackend, model: string): string {
  const trimmed = model.trim();
  const prefixed = trimmed.startsWith(`${backend}/`);
  const id = prefixed && ((backend !== "opencode" && backend !== "pi") || trimmed.slice(backend.length + 1).includes("/"))
    ? trimmed.slice(backend.length + 1)
    : trimmed;
  if (!MODEL_PATTERN.test(id) || ((backend === "opencode" || backend === "pi") && !id.includes("/"))) {
    throw new Error(`Invalid ${backend} model ID. Use the exact backend model ID, such as provider/model-id or gpt-6-luna.`);
  }
  const route = `${backend}/${id}`;
  supportedBackendForModel(route);
  return route;
}

export function parseOpenCodeModels(text: string): string[] {
  const models = new Set<string>();
  for (const line of text.split(/\r?\n/u)) {
    const id = line.trim();
    if (!id || id.length > 180 || !/^[a-zA-Z0-9][\w.-]*\/[\w./-]+$/u.test(id)) continue;
    models.add(normalizeSelectedModel("opencode", `opencode/${id}`));
    if (models.size > 1000) throw new Error("OpenCode model catalog is unexpectedly large.");
  }
  return [...models].sort();
}

function onPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    try {
      const executable = realpathSync(join(dir, name));
      const stat = statSync(executable);
      if (stat.isFile() && accessSync(executable, fsConstants.X_OK) === undefined) return executable;
    } catch {
      // A missing or inaccessible PATH entry is not a detected CLI.
    }
  }
  return undefined;
}

/** Listing candidates is not verification: the selected model is still checked by live sandboxed ACP. */
export async function discoverAcpClis(): Promise<DetectedCli[]> {
  const results: DetectedCli[] = [];
  for (const backend of ["claude", "codex", "opencode", "pi"] as const) {
    const executable = onPath(backend);
    if (!executable) continue;
    try {
      const version = await execFile(executable, ["--version"], { timeout: 10_000, maxBuffer: 16 * 1024 });
      const reported = version.stdout.trim().split(/\r?\n/u)[0]?.slice(0, 120) ?? backend;
      let models: string[] = [];
      if (backend === "opencode") {
        const list = await execFile(executable, ["models"], { timeout: 30_000, maxBuffer: 256 * 1024 });
        models = parseOpenCodeModels(list.stdout);
      } else if (backend === "pi") {
        const list = await execFile(executable, ["--list-models"], {
          timeout: 30_000, maxBuffer: 512 * 1024, env: { ...process.env, PI_OFFLINE: "1" },
        });
        models = parsePiModels(list.stdout);
      }
      results.push({ backend, executable, version: reported, models });
    } catch {
      // Don't offer a CLI that fails to initialize. Never silently substitute another backend.
    }
  }
  return results;
}

export function parsePiModels(text: string): string[] {
  const models = new Set<string>();
  for (const line of text.split(/\r?\n/u).slice(1)) {
    const [provider, model] = line.trim().split(/\s+/u);
    if (!provider || !model) continue;
    try { models.add(normalizeSelectedModel("pi", `${provider}/${model}`)); } catch { /* Ignore non-model rows. */ }
    if (models.size > 1000) throw new Error("Pi model catalog is unexpectedly large.");
  }
  return [...models].sort();
}

/** No model turn or project mount. Catalog/effort are verified again at actual Stage B start. */
export async function probeAcpConfiguration(
  projectRoot: string, backend: AcpBackend, selectedModel?: string,
  connectivityCheck?: { reasoningEffort?: ReasoningEffort },
): Promise<{ models: string[]; efforts: ReasoningEffort[] }> {
  const root = await mkdtemp(join(dirname(resolve(projectRoot)), `.pi-plan-execute-${backend}-catalog-`));
  const sourceRoot = join(root, "source");
  const cwd = join(root, "worktree");
  const goldenRoot = join(sourceRoot, ".pi-plan-execute-auto", "catalog");
  let sandbox: Awaited<ReturnType<typeof createSandboxedBackend>> | undefined;
  let agent: AcpAgent | undefined;
  try {
    await mkdir(goldenRoot, { recursive: true });
    const git = async (args: string[]) => {
      await execFile("git", args, { timeout: 10_000, maxBuffer: 16 * 1024 });
    };
    await git(["init", "-q", sourceRoot]);
    await git(["-C", sourceRoot, "config", "user.name", "Catalog Probe"]);
    await git(["-C", sourceRoot, "config", "user.email", "probe@example.invalid"]);
    await writeFile(join(sourceRoot, ".gitignore"), ".pi-plan-execute-auto/\n");
    await writeFile(join(sourceRoot, "probe.txt"), "Model catalog only. No user project files.\n");
    await git(["-C", sourceRoot, "add", "."]);
    await git(["-C", sourceRoot, "commit", "-qm", "isolated catalog fixture"]);
    await git(["-C", sourceRoot, "worktree", "add", "-q", "--detach", cwd]);
    const options = { role: "reviewer" as const, model: selectedModel ?? `${backend}/catalog`, cwd, sourceRoot, goldenRoot, includeProviderCredentials: true };
    sandbox = await createSandboxedBackend(options);
    await verifySandboxBoundary(options);
    // A backend-only route selects the ACP server without guessing a model ID.
    agent = new AcpAgent({
      cwd, model: selectedModel ?? backend,
      ...(backend === "codex" ? { mode: "read-only" } : backend === "pi" ? {} : { mode: "plan" }),
      backends: { [backend]: sandbox.config }, permissions: { defaultOutcome: "deny" },
    });
    await agent.ready();
    const model = agent.configOptions.find((entry) => entry.id === "model" && entry.type === "select");
    const ids = new Set<string>();
    if (model?.type === "select") {
      for (const choice of model.options) {
        const leaves = "value" in choice ? [choice] : choice.options;
        for (const leaf of leaves) {
          try { ids.add(normalizeSelectedModel(backend, leaf.value)); } catch { /* Ignore non-routable labels. */ }
          if (ids.size > 1000) throw new Error(`${backend} ACP model catalog is unexpectedly large.`);
        }
      }
    }
    const efforts = new Set<ReasoningEffort>();
    for (const option of agent.configOptions) {
      if (option.type !== "select" || (option.id !== "reasoning_effort" && option.category !== "thought_level" && option.id !== "variant")) continue;
      for (const choice of option.options) {
        const leaves = "value" in choice ? [choice] : choice.options;
        for (const leaf of leaves) {
          if (leaf.value === "low" || leaf.value === "medium" || leaf.value === "high" || leaf.value === "max") efforts.add(leaf.value);
        }
      }
    }
    if (connectivityCheck?.reasoningEffort) {
      const effort = connectivityCheck.reasoningEffort;
      const option = agent.configOptions.find((entry) => entry.type === "select" &&
        (entry.id === "reasoning_effort" || entry.category === "thought_level" || entry.id === "variant") &&
        entry.options.some((choice) => "value" in choice ? choice.value === effort : choice.options.some((item) => item.value === effort)));
      if (!option) throw new Error(`${backend} ACP did not advertise ${effort} reasoning for ${selectedModel}.`);
      await agent.setConfigOptions({ [option.id]: effort });
      if (agent.configOptions.find((entry) => entry.id === option.id)?.currentValue !== effort) {
        throw new Error(`${backend} ACP did not confirm ${effort} reasoning for ${selectedModel}.`);
      }
    }
    await sandbox.scrubCredentials();
    if (connectivityCheck) {
      if (!selectedModel) throw new Error("A selected model is required for an ACP provider call.");
      const response = await agent.prompt("Connectivity probe only: reply READY. Do not call tools or edit files.", { signal: AbortSignal.timeout(90_000) });
      if (!response.text.trim()) throw new Error(`${backend} ACP connectivity probe returned no model response.`);
    }
    return { models: [...ids].sort(), efforts: [...efforts] };
  } finally {
    await agent?.close({ keep: true }).catch(() => {});
    try { await sandbox?.cleanup(); } finally { await rm(root, { recursive: true, force: true }); }
  }
}

export async function probeAcpModels(projectRoot: string, backend: AcpBackend): Promise<string[]> {
  return (await probeAcpConfiguration(projectRoot, backend)).models;
}

/** Explicitly approved billable connectivity check for backends without completed real turn tests. */
export async function verifyAcpModelCall(
  projectRoot: string, model: string, reasoningEffort?: ReasoningEffort,
): Promise<void> {
  await probeAcpConfiguration(projectRoot, supportedBackendForModel(model), model,
    reasoningEffort ? { reasoningEffort } : {});
}

export async function probeCodexAcpModels(projectRoot: string): Promise<string[]> {
  return probeAcpModels(projectRoot, "codex");
}

async function projectIdentity(cwd: string): Promise<{ projectRoot: string; gitEntry: string }> {
  const projectRoot = await realpath(cwd);
  const git = join(projectRoot, ".git");
  const file = await lstat(git).catch(() => {
    throw new Error("Plugin setup requires a Git repository root containing a real .git directory or worktree pointer.");
  });
  if (file.isSymbolicLink() || (!file.isDirectory() && !file.isFile())) {
    throw new Error("Plugin setup refuses an unexpected .git entry.");
  }
  return { projectRoot, gitEntry: `${file.dev}:${file.ino}` };
}

function profilePath(projectRoot: string, agentDir: string): string {
  const id = createHash("sha256").update(projectRoot).digest("hex");
  return join(resolve(agentDir), "plan-execute-auto", "profiles", `${id}.json`);
}

function validateProfile(value: unknown, identity: { projectRoot: string; gitEntry: string }): ProjectPluginProfile {
  if (!regularObject(value) || value.version !== 1 || value.projectRoot !== identity.projectRoot || value.gitEntry !== identity.gitEntry ||
    typeof value.executorModel !== "string" || typeof value.reviewerModel !== "string" ||
    typeof value.networkRiskApprovedAt !== "string" || !Number.isFinite(Date.parse(value.networkRiskApprovedAt)) ||
    typeof value.configSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.configSha256) ||
    (value.reasoningEffort !== undefined && !["low", "medium", "high", "max"].includes(value.reasoningEffort as string))) {
    throw new Error("Saved plan-execute configuration is invalid or belongs to a different Git repository. Run /plan-execute setup again.");
  }
  supportedBackendForModel(value.executorModel);
  supportedBackendForModel(value.reviewerModel);
  if (value.executorModel !== normalizeSelectedModel(supportedBackendForModel(value.executorModel), value.executorModel) ||
    value.reviewerModel !== normalizeSelectedModel(supportedBackendForModel(value.reviewerModel), value.reviewerModel)) {
    throw new Error("Saved plan-execute model routes are not canonical. Run /plan-execute setup again.");
  }
  return value as unknown as ProjectPluginProfile;
}

function cachePath(projectRoot: string): string {
  return join(projectRoot, ".pi-plan-execute-auto", "config.json");
}

function approvedCache(profile: ProjectPluginProfile): Record<string, unknown> {
  return {
    version: 1, projectRoot: profile.projectRoot, gitEntry: profile.gitEntry,
    executorModel: profile.executorModel, reviewerModel: profile.reviewerModel,
    ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
  };
}

function cacheHash(cache: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(cache)).digest("hex");
}

async function readApprovedCache(profile: ProjectPluginProfile): Promise<void> {
  const path = cachePath(profile.projectRoot);
  const directory = await lstat(dirname(path)).catch(() => undefined);
  if (!directory?.isDirectory() || directory.isSymbolicLink()) {
    throw new Error("Unsafe project configuration cache directory. Run /plan-execute setup again.");
  }
  let file;
  try { file = await lstat(path); } catch {
    throw new Error("Project configuration cache is missing. Run /plan-execute setup to approve its current contents.");
  }
  if (!file.isFile() || file.isSymbolicLink() || file.size > MAX_PROFILE_BYTES) {
    throw new Error("Unsafe project configuration cache. Run /plan-execute setup again.");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, "utf8")); } catch {
    throw new Error("Unreadable project configuration cache. Run /plan-execute setup again.");
  }
  const expected = approvedCache(profile);
  if (!regularObject(parsed) || Object.keys(parsed).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([key, value]) => parsed[key] !== value) || cacheHash(expected) !== profile.configSha256) {
    throw new Error("Project configuration differs from the human-approved selection. Run /plan-execute setup to reapprove it.");
  }
}

export async function loadProjectPluginProfile(cwd: string, agentDir = getAgentDir()): Promise<ProjectPluginProfile | undefined> {
  const identity = await projectIdentity(cwd);
  const path = profilePath(identity.projectRoot, agentDir);
  let file;
  try {
    file = await lstat(path);
  } catch (error) {
    if (regularObject(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  if (!file.isFile() || file.isSymbolicLink() || file.size > MAX_PROFILE_BYTES || (file.mode & 0o077) !== 0) {
    throw new Error("Refusing unsafe plan-execute configuration file. Run /plan-execute setup again.");
  }
  const data = await readFile(path, "utf8");
  if (Buffer.byteLength(data) > MAX_PROFILE_BYTES) throw new Error("Saved plan-execute configuration exceeds its size limit.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new Error("Saved plan-execute configuration is not JSON. Run /plan-execute setup again.");
  }
  const profile = validateProfile(parsed, identity);
  await readApprovedCache(profile);
  return profile;
}

/** Project cache is model-editable; only the protected user-owned digest and network consent authorize it. */
export async function saveProjectPluginProfile(
  cwd: string,
  selected: Pick<ProjectPluginProfile, "executorModel" | "reviewerModel" | "reasoningEffort">,
  agentDir = getAgentDir(),
): Promise<ProjectPluginProfile> {
  const identity = await projectIdentity(cwd);
  const approved = {
    version: 1, ...identity,
    executorModel: selected.executorModel,
    reviewerModel: selected.reviewerModel,
    ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}),
  };
  const profile: ProjectPluginProfile = validateProfile({
    ...approved, configSha256: cacheHash(approved), networkRiskApprovedAt: new Date().toISOString(),
  }, identity);
  const cacheDir = join(identity.projectRoot, ".pi-plan-execute-auto");
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const cacheDirectory = await lstat(cacheDir);
  if (!cacheDirectory.isDirectory() || cacheDirectory.isSymbolicLink()) {
    throw new Error("Refusing unsafe project configuration directory.");
  }
  const cacheTmp = join(cacheDir, `.config-${randomUUID()}.tmp`);
  try {
    await writeFile(cacheTmp, `${JSON.stringify(approved, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(cacheTmp, cachePath(identity.projectRoot));
  } finally { await rm(cacheTmp, { force: true }); }
  const path = profilePath(identity.projectRoot, agentDir);
  const dir = join(resolve(agentDir), "plan-execute-auto", "profiles");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const parent = await lstat(dir);
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0) {
    throw new Error("Refusing unsafe plan-execute profile directory permissions.");
  }
  const temporary = join(dir, `.profile-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(profile, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return profile;
}

export async function removeProjectPluginProfile(cwd: string, agentDir = getAgentDir()): Promise<void> {
  const identity = await projectIdentity(cwd);
  await rm(profilePath(identity.projectRoot, agentDir), { force: true });
  const cached = cachePath(identity.projectRoot);
  const file = await lstat(cached).catch(() => undefined);
  if (file?.isFile() && !file.isSymbolicLink()) await rm(cached, { force: true });
}
