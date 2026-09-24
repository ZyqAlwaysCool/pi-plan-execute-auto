import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback, spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import {
  accessSync,
  constants as fsConstants,
  createWriteStream,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { CustomBackendConfig } from "@automatalabs/workflows";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import type { GitCommandResult } from "./types.js";
import { startClaudeCredentialRelay, type ClaudeCredentialRelay } from "./claude-relay.js";

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);
const SCRATCH_ROOT = "/tmp";
const RUNTIME_ROOT = "/agent-runtime";
const RUNTIME_NODE_BIN = `${RUNTIME_ROOT}/node-bin`;
const RUNTIME_NODE_MODULES = `${RUNTIME_ROOT}/node_modules`;
const RUNTIME_CODEX_ACP = "@automatalabs/codex-acp";
const RUNTIME_CLAUDE_ACP = "@agentclientprotocol/claude-agent-acp/dist/index.js";
const RUNTIME_PI_ACP = "@automatalabs/pi-acp";
const ALLOWED_BWRAP_DIRS = new Set(["/usr/bin", "/usr/local/bin"]);
const MAX_GIT_MIRROR_OBJECTS = 250_000;
const MAX_GIT_MIRROR_TREE_LIST_BYTES = 128 * 1024 * 1024;
const MAX_GIT_MIRROR_PACK_BYTES = 512 * 1024 * 1024;

export type SandboxedAgentRole = "executor" | "reviewer" | "acceptance";
export type SupportedAcpBackend = "claude" | "codex" | "opencode" | "pi";

export interface SandboxOptions {
  role: SandboxedAgentRole;
  model: string;
  cwd: string;
  sourceRoot: string;
  goldenRoot: string;
  signal?: AbortSignal;
  /** Internal: stage stored provider auth in run-private scratch, then remove it before the first turn. */
  includeProviderCredentials?: boolean;
}

export interface SandboxedBackend {
  backendId: SupportedAcpBackend;
  config: CustomBackendConfig;
  scratchPath: string;
  scrubCredentials(): Promise<void>;
  cleanup(): Promise<void>;
}

interface BackendRuntime {
  command: string;
  args: string[];
  credentialSources: Array<{ source: string; relativeTarget: string }>;
  extraBinary?: { source: string; target: string };
  nodeModulesRoot?: string;
  useNodeEnvProxy?: boolean;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function assertAgentRoots(options: SandboxOptions): void {
  const cwd = resolve(options.cwd);
  const sourceRoot = resolve(options.sourceRoot);
  const goldenRoot = resolve(options.goldenRoot);
  if (goldenRoot === sourceRoot || isWithin(goldenRoot, sourceRoot)) {
    throw new Error("Golden Package cannot contain the protected source root; mount only the run-specific package directory.");
  }
  if (isWithin(cwd, goldenRoot) || isWithin(goldenRoot, cwd)) {
    throw new Error("The dedicated worktree and Golden Package must be physically separate sandbox roots.");
  }
  if (goldenRoot === "/") throw new Error("Golden Package cannot be the host filesystem root.");
  for (const broadRoot of ["/root", "/etc", "/usr", "/var", "/opt", "/tmp", "/run", "/proc", "/sys", "/dev"]) {
    if (isWithin(goldenRoot, broadRoot) || isWithin(broadRoot, goldenRoot)) {
      throw new Error(`Golden Package cannot expose or overlap a broad host root: ${broadRoot}.`);
    }
  }
  if (cwd === "/") throw new Error("Agent workspace cannot be the host filesystem root.");
  for (const broadRoot of [homedir(), "/home", "/root", "/etc", "/usr", "/var", "/opt", "/tmp", "/run", "/proc", "/sys", "/dev"]) {
    if (isWithin(cwd, broadRoot)) {
      throw new Error(`Agent workspace cannot expose a broad host root: ${broadRoot}.`);
    }
  }
  if (isWithin("/tmp", cwd) || isWithin("/etc", cwd) || isWithin("/usr", cwd) || isWithin("/var", cwd) || isWithin("/opt", cwd) || isWithin("/root", cwd)) {
    throw new Error("Agent worktree must be outside host system and temporary directories.");
  }
  const sensitiveHomeRoots = [".ssh", ".aws", ".azure", ".gnupg", ".config", ".kube", ".docker", ".npm", ".local/share"]
    .map((entry) => resolve(homedir(), entry));
  for (const sensitiveRoot of sensitiveHomeRoots) {
    if (isWithin(cwd, sensitiveRoot) || isWithin(sensitiveRoot, cwd) || isWithin(goldenRoot, sensitiveRoot) || isWithin(sensitiveRoot, goldenRoot)) {
      throw new Error(`Agent workspace or Golden Package overlaps a protected credential directory: ${sensitiveRoot}.`);
    }
  }
  if (isWithin(cwd, sourceRoot) || isWithin(sourceRoot, cwd)) {
    throw new Error(`Agent workspace must be physically separate from protected source root ${sourceRoot}.`);
  }
}

export function supportedBackendForModel(model: string | undefined): SupportedAcpBackend {
  if (!model) throw new Error("A sandboxed ACP model must use an explicit claude/, codex/, opencode/, or pi/ model route.");
  const separator = model.indexOf("/");
  const backend = separator > 0 ? model.slice(0, separator).toLowerCase() : "";
  if (backend !== "claude" && backend !== "codex" && backend !== "opencode" && backend !== "pi") {
    throw new Error(`ACP backend ${backend || "<default>"} is not allowlisted for isolated Stage B execution.`);
  }
  if (!model.slice(separator + 1).trim()) throw new Error(`ACP model route is incomplete: ${model}`);
  return backend;
}

/** Validate provenance, not merely executability; a user-owned `true` wrapper is not a sandbox. */
export function validateBubblewrapBinary(path: string): string {
  let realPath: string;
  try {
    realPath = realpathSync(resolve(path));
  } catch {
    throw new Error(`Bubblewrap binary does not exist: ${path}`);
  }
  const file = statSync(realPath);
  if (
    basename(realPath) !== "bwrap" ||
    !ALLOWED_BWRAP_DIRS.has(dirname(realPath)) ||
    file.uid !== 0 ||
    (file.mode & 0o022) !== 0 ||
    !file.isFile() ||
    accessSync(realPath, fsConstants.X_OK) !== undefined
  ) {
    throw new Error(`Refusing untrusted bubblewrap binary: ${path}; install a root-owned bwrap in /usr/bin or /usr/local/bin.`);
  }
  return realPath;
}

export function findBubblewrap(): string {
  const configured = process.env.PI_PLAN_EXECUTE_BWRAP;
  if (configured) return validateBubblewrapBinary(configured);
  for (const directory of (process.env.PATH ?? "").split(":")) {
    if (!directory) continue;
    const candidate = join(directory, "bwrap");
    try {
      return validateBubblewrapBinary(candidate);
    } catch {
      // Ignore non-bwrap or user-writable PATH entries; continue to a trusted system binary.
    }
  }
  throw new Error("A root-owned system bubblewrap (bwrap) is required; refusing to start ACP without it.");
}

function findExecutable(name: string): string {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      const real = realpathSync(candidate);
      const stat = statSync(real);
      if (stat.isFile() && accessSync(real, fsConstants.X_OK) === undefined) return real;
    } catch {
      // Continue searching PATH.
    }
  }
  throw new Error(`Required ACP executable was not found on PATH: ${name}`);
}

function gitEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ATTR_NOSYSTEM: "1",
  };
}

async function runGit(
  cwd: string,
  args: string[],
  home: string,
  signal?: AbortSignal,
  maxBuffer = 1024 * 1024,
): Promise<string> {
  const result = await execFile("git", args, {
    cwd,
    env: gitEnvironment(home),
    encoding: "utf8",
    maxBuffer,
    timeout: 120_000,
    ...(signal ? { signal } : {}),
  });
  return result.stdout;
}

async function writeGitPack(
  cwd: string,
  objectIds: string[],
  packPath: string,
  home: string,
  signal?: AbortSignal,
): Promise<void> {
  const child = spawn(findExecutable("git"), ["-C", cwd, "pack-objects", "--stdout", "--no-reuse-object", "--no-reuse-delta", "--window=0", "--threads=1"], {
    env: gitEnvironment(home),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr: string[] = [];
  let stderrBytes = 0;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (stderrBytes >= 64 * 1024) return;
    const remaining = 64 * 1024 - stderrBytes;
    const part = chunk.slice(0, remaining);
    stderr.push(part);
    stderrBytes += Buffer.byteLength(part, "utf8");
  });
  child.stdin.on("error", () => undefined);
  let packBytes = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      packBytes += chunk.length;
      if (packBytes > MAX_GIT_MIRROR_PACK_BYTES) {
        callback(new Error("Read-only Git mirror exceeds the configured pack size limit."));
      } else {
        callback(null, chunk);
      }
    },
  });
  const output = createWriteStream(packPath, { flags: "wx", mode: 0o600 });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose, rejectClose) => {
    child.once("error", rejectClose);
    child.once("close", (code, signalName) => resolveClose({ code, signal: signalName }));
  });
  const piped = pipeline(child.stdout, limit, output);
  const onAbort = () => child.kill("SIGTERM");
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
  try {
    if (signal?.aborted) throw signal.reason ?? new Error("Git mirror creation cancelled.");
    child.stdin.end(`${objectIds.join("\n")}\n`);
    const [exit] = await Promise.all([closed, piped]);
    if (exit.code !== 0) {
      throw new Error(`Cannot create read-only Git metadata mirror: ${(stderr.join("").trim() || `git pack-objects exited ${exit.code ?? exit.signal ?? "unknown"}`)}`);
    }
  } catch (error) {
    child.kill("SIGKILL");
    await Promise.all([closed.catch(() => undefined), piped.catch(() => undefined)]);
    await rm(packPath, { force: true });
    if (signal?.aborted) throw signal.reason ?? error;
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function prepareReadOnlyGitMirror(cwd: string, scratchPath: string, signal?: AbortSignal): Promise<void> {
  const home = join(scratchPath, "run", "home");
  const format = (await runGit(cwd, ["rev-parse", "--show-object-format"], home, signal)).trim();
  if (format !== "sha1" && format !== "sha256") throw new Error(`Unsupported Git object format: ${format}`);
  const head = (await runGit(cwd, ["rev-parse", "--verify", "HEAD"], home, signal)).trim();
  const oidLength = format === "sha1" ? 40 : 64;
  if (!new RegExp(`^[0-9a-f]{${oidLength}}$`).test(head)) throw new Error("Dedicated worktree HEAD is not a valid full Git object ID.");
  const tree = (await runGit(cwd, ["rev-parse", "--verify", `${head}^{tree}`], home, signal)).trim();
  const listing = await runGit(cwd, ["ls-tree", "-r", "-t", "-z", tree], home, signal, MAX_GIT_MIRROR_TREE_LIST_BYTES);
  const objects = new Map<string, string>([[head, "commit"], [tree, "tree"]]);
  for (const record of listing.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) throw new Error("Git returned a malformed tree entry while preparing the read-only metadata mirror.");
    const fields = record.slice(0, tab).split(" ");
    const type = fields[1];
    const oid = fields[2];
    if (type !== "blob" && type !== "tree" && type !== "commit") {
      throw new Error("Git returned an unsupported object type while preparing the read-only metadata mirror.");
    }
    if (!oid || !new RegExp(`^[0-9a-f]{${oidLength}}$`).test(oid)) {
      throw new Error("Git returned an invalid object ID while preparing the read-only metadata mirror.");
    }
    if (type === "commit") continue;
    objects.set(oid, type);
    if (objects.size > MAX_GIT_MIRROR_OBJECTS) throw new Error("Read-only Git mirror exceeds the configured object-count limit.");
  }

  const mirror = join(scratchPath, "run", "git-mirror");
  const objectDirectory = join(mirror, "objects");
  await Promise.all([
    mkdir(join(objectDirectory, "info"), { recursive: true, mode: 0o700 }),
    mkdir(join(objectDirectory, "pack"), { recursive: true, mode: 0o700 }),
    mkdir(join(mirror, "refs", "heads"), { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(join(mirror, "HEAD"), `${head}\n`, { mode: 0o400 });
  await writeFile(join(mirror, "shallow"), `${head}\n`, { mode: 0o400 });
  const config = join(mirror, "config");
  const repositoryFormatVersion = format === "sha1" ? 0 : 1;
  const formatExtension = format === "sha256" ? `\n[extensions]\n\tobjectFormat = sha256\n` : "";
  await writeFile(config, `[core]\n\trepositoryformatversion = ${repositoryFormatVersion}\n\tfilemode = true\n\tbare = false\n${formatExtension}`, { mode: 0o600 });
  await runGit(cwd, ["config", "--file", config, "core.worktree", cwd], home, signal);

  const packPath = join(objectDirectory, "pack", "pack-phase-base.pack");
  await writeGitPack(cwd, [...objects.keys()], packPath, home, signal);
  await runGit(cwd, [`--git-dir=${mirror}`, "index-pack", packPath], home, signal);
  await runGit(cwd, [`--git-dir=${mirror}`, `--work-tree=${cwd}`, "read-tree", head], home, signal);
  await writeFile(join(scratchPath, "run", "git-pointer"), "gitdir: /tmp/run/git-mirror\n", { mode: 0o400 });
}

function outerNodeModulesRoot(entry: string): string {
  let cursor = dirname(entry);
  let outermost: string | undefined;
  while (true) {
    if (basename(cursor) === "node_modules") outermost = cursor;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (!outermost || !isWithin(outermost, entry)) {
    throw new Error(`Cannot safely expose ACP package dependencies from ${entry}.`);
  }
  return outermost;
}

function backendRuntime(backend: SupportedAcpBackend): BackendRuntime {
  if (backend === "codex") {
    if (process.env.AGENTPRISM_CODEX_ACP_CMD || process.env.AGENTPRISM_CODEX_ACP_BIN) {
      throw new Error("Custom Codex ACP command overrides are not supported by the Stage B sandbox.");
    }
    const entry = realpathSync(require.resolve(RUNTIME_CODEX_ACP));
    const nodeModules = realpathSync(outerNodeModulesRoot(entry));
    const nodeEntry = join(RUNTIME_NODE_MODULES, relative(nodeModules, entry));
    const nodeBinary = realpathSync(process.execPath);
    const nodeBinDir = dirname(nodeBinary);
    const nodePath = join(RUNTIME_NODE_BIN, basename(nodeBinary));
    const codexHome = resolve(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"));
    return {
      command: nodePath,
      args: [nodeEntry],
      nodeModulesRoot: nodeModules,
      credentialSources: [{ source: join(codexHome, "auth.json"), relativeTarget: "codex-home/auth.json" }],
    };
  }

  if (backend === "claude" || backend === "pi") {
    if (backend === "claude" && (process.env.AGENTPRISM_CLAUDE_ACP_CMD || process.env.AGENTPRISM_CLAUDE_ACP_ARGS)) {
      throw new Error("Custom Claude ACP commands are not supported by the Stage B sandbox.");
    }
    if (backend === "pi" && (process.env.AGENTPRISM_PI_ACP_CMD || process.env.AGENTPRISM_PI_ACP_ARGS)) {
      throw new Error("Custom Pi ACP commands are not supported by the Stage B sandbox.");
    }
    const library = realpathSync(require.resolve(backend === "claude" ? RUNTIME_CLAUDE_ACP : RUNTIME_PI_ACP));
    const entry = library;
    const nodeModules = realpathSync(outerNodeModulesRoot(library));
    const nodeBinary = realpathSync(process.execPath);
    return {
      command: join(RUNTIME_NODE_BIN, basename(nodeBinary)),
      args: [backend === "pi" ? `${RUNTIME_ROOT}/pi-acp-bootstrap.mjs` : join(RUNTIME_NODE_MODULES, relative(nodeModules, entry))],
      nodeModulesRoot: nodeModules,
      useNodeEnvProxy: true,
      ...(backend === "pi" ? { extraBinary: {
        source: realpathSync(join(dirname(fileURLToPath(import.meta.url)), "pi-acp-bootstrap.mjs")),
        target: `${RUNTIME_ROOT}/pi-acp-bootstrap.mjs`,
      } } : {}),
      credentialSources: backend === "claude"
        ? []
        : [{ source: join(resolve(process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent")), "auth.json"), relativeTarget: "home/.pi/agent/auth.json" }],
    };
  }

  if (process.env.AGENTPRISM_OPENCODE_ACP_CMD || process.env.AGENTPRISM_OPENCODE_ACP_ARGS) {
    throw new Error("Custom OpenCode ACP command overrides are not supported by the Stage B sandbox.");
  }
  const command = findExecutable("opencode");
  const xdgDataHome = resolve(process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"));
  return {
    command: `${RUNTIME_ROOT}/opencode`,
    args: ["acp"],
    credentialSources: [{ source: join(xdgDataHome, "opencode", "auth.json"), relativeTarget: "data/opencode/auth.json" }],
    extraBinary: { source: command, target: `${RUNTIME_ROOT}/opencode` },
  };
}

function ensureDirectoryArgs(args: string[], created: Set<string>, absolutePath: string): void {
  const normalized = resolve(absolutePath);
  const parts = normalized.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    if (created.has(current)) continue;
    args.push("--dir", current);
    created.add(current);
  }
}

function tryRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function addMinimalFilesystem(
  args: string[],
  options: SandboxOptions,
  scratchPath: string,
  runtime: BackendRuntime,
  claudeRelay?: ClaudeCredentialRelay,
): void {
  const created = new Set<string>();
  const cwd = resolve(options.cwd);
  const goldenRoot = resolve(options.goldenRoot);
  const nodeBinary = realpathSync(process.execPath);
  const nodeBinDir = dirname(nodeBinary);
  const pluginNodeModules = runtime.nodeModulesRoot;
  // Claude talks only to the trusted host relay. Never route the capability URL through
  // an inherited HTTP(S) proxy; Pi may still need the already-vetted credential-free proxy.
  const proxies = claudeRelay ? [] : safeProxyEnvironment();
  const hasNodeHttpProxy = proxies.some(([key, value]) =>
    ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"].includes(key) && /^https?:\/\//i.test(value),
  );

  args.push("--tmpfs", "/");

  // Expose system executables, dynamic libraries and shared data, not the host root or /usr/local.
  for (const hostPath of ["/usr/bin", "/usr/sbin", "/usr/lib", "/usr/lib64", "/usr/share"]) {
    const source = tryRealpath(hostPath);
    if (!source) continue;
    ensureDirectoryArgs(args, created, hostPath);
    args.push("--ro-bind", source, hostPath);
  }
  for (const alias of ["/bin", "/sbin", "/lib", "/lib64", "/lib32"]) {
    const target = tryRealpath(alias);
    if (!target) continue;
    const relativeToUsr = relative("/usr", target);
    if (relativeToUsr === "" || (!relativeToUsr.startsWith("..") && !isAbsolute(relativeToUsr))) {
      args.push("--symlink", relative("/", target), alias);
    } else {
      ensureDirectoryArgs(args, created, alias);
      args.push("--ro-bind", target, alias);
    }
  }

  ensureDirectoryArgs(args, created, "/etc");
  for (const hostPath of ["/etc/ssl/certs", "/etc/pki/tls/certs"]) {
    const source = tryRealpath(hostPath);
    if (!source) continue;
    ensureDirectoryArgs(args, created, hostPath);
    args.push("--ro-bind", source, hostPath);
  }
  for (const hostPath of [
    "/etc/ssl/cert.pem",
    "/etc/pki/tls/cert.pem",
    "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
    "/etc/ca-certificates/extracted/tls-ca-bundle.pem",
    "/etc/hosts",
    "/etc/resolv.conf",
    "/etc/nsswitch.conf",
    "/etc/passwd",
    "/etc/group",
    "/etc/gai.conf",
    "/etc/services",
    "/etc/protocols",
    "/etc/ld.so.cache",
    "/etc/localtime",
  ]) {
    const source = tryRealpath(hostPath);
    if (!source) continue;
    ensureDirectoryArgs(args, created, dirname(hostPath));
    args.push("--ro-bind", source, hostPath);
  }

  ensureDirectoryArgs(args, created, "/proc");
  args.push("--proc", "/proc");
  ensureDirectoryArgs(args, created, "/dev");
  args.push("--dev", "/dev");
  ensureDirectoryArgs(args, created, "/run");
  args.push("--tmpfs", "/run");
  ensureDirectoryArgs(args, created, "/tmp");
  args.push("--bind", scratchPath, "/tmp");
  const gitMirror = join(scratchPath, "run", "git-mirror");
  const gitPointer = join(scratchPath, "run", "git-pointer");
  args.push("--ro-bind", gitMirror, "/tmp/run/git-mirror");
  args.push("--ro-bind", gitPointer, "/tmp/run/git-pointer");

  ensureDirectoryArgs(args, created, RUNTIME_NODE_BIN);
  args.push("--ro-bind", nodeBinDir, RUNTIME_NODE_BIN);
  if (pluginNodeModules) {
    ensureDirectoryArgs(args, created, RUNTIME_NODE_MODULES);
    args.push("--ro-bind", pluginNodeModules, RUNTIME_NODE_MODULES);
  }
  const nodePrefix = dirname(nodeBinDir);
  for (const packageName of ["npm", "corepack"]) {
    const source = tryRealpath(join(nodePrefix, "lib", "node_modules", packageName));
    if (!source) continue;
    const destination = `${RUNTIME_ROOT}/lib/node_modules/${packageName}`;
    ensureDirectoryArgs(args, created, destination);
    args.push("--ro-bind", source, destination);
  }
  if (runtime.extraBinary) {
    ensureDirectoryArgs(args, created, dirname(runtime.extraBinary.target));
    args.push("--ro-bind", runtime.extraBinary.source, runtime.extraBinary.target);
  }

  for (const root of [cwd, goldenRoot]) {
    ensureDirectoryArgs(args, created, root);
    args.push(root === cwd && options.role !== "reviewer" ? "--bind" : "--ro-bind", root, root);
  }
  const worktreeGitPointer = join(cwd, ".git");
  // Bubblewrap resolves bind sources in the host namespace, before /tmp is mounted.
  args.push("--ro-bind", gitPointer, worktreeGitPointer);
  // The synthetic parent directories must not become writable lookalikes of
  // paths in the protected source worktree. Bind mounts stay separate writable
  // or readonly filesystems; this only locks the synthetic root itself.
  args.push("--remount-ro", "/");

  const runtimeHome = "/tmp/run";
  args.push(
    "--clearenv",
    "--setenv", "HOME", `${runtimeHome}/home`,
    "--setenv", "TMPDIR", "/tmp",
    "--setenv", "TMP", "/tmp",
    "--setenv", "TEMP", "/tmp",
    "--setenv", "CODEX_HOME", `${runtimeHome}/codex-home`,
    "--setenv", "CLAUDE_CONFIG_DIR", `${runtimeHome}/home/.claude`,
    ...(claudeRelay ? [
      "--setenv", "ANTHROPIC_BASE_URL", claudeRelay.baseUrl,
      "--setenv", "ANTHROPIC_AUTH_TOKEN", claudeRelay.dummyAuthToken,
      "--setenv", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1",
      "--setenv", "DISABLE_TELEMETRY", "1",
      "--setenv", "DISABLE_ERROR_REPORTING", "1",
      "--setenv", "DISABLE_AUTOUPDATER", "1",
    ] : []),
    "--setenv", "PI_CODING_AGENT_DIR", `${runtimeHome}/home/.pi/agent`,
    "--setenv", "PI_OFFLINE", "1",
    "--setenv", "XDG_DATA_HOME", `${runtimeHome}/data`,
    "--setenv", "XDG_STATE_HOME", `${runtimeHome}/state`,
    "--setenv", "XDG_CACHE_HOME", `${runtimeHome}/cache`,
    "--setenv", "XDG_CONFIG_HOME", `${runtimeHome}/config`,
    "--setenv", "OPENCODE_DISABLE_AUTOUPDATE", "1",
    "--setenv", "PATH", `${RUNTIME_NODE_BIN}:/usr/bin:/bin:/usr/sbin:/sbin`,
    "--setenv", "LANG", "C.UTF-8",
    "--setenv", "LC_ALL", "C.UTF-8",
    "--setenv", "TERM", "dumb",
    ...(runtime.useNodeEnvProxy && hasNodeHttpProxy ? ["--setenv", "NODE_USE_ENV_PROXY", "1"] : []),
    ...proxies.flatMap(([key, value]) => ["--setenv", key, value]),
    "--setenv", "GIT_OPTIONAL_LOCKS", "0",
    "--setenv", "GIT_CONFIG_NOSYSTEM", "1",
    "--setenv", "GIT_CONFIG_GLOBAL", "/dev/null",
    "--chdir", cwd,
  );
}

function safeProxyEnvironment(): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"] as const) {
    const value = process.env[key] ?? process.env[key.toLowerCase()];
    if (!value) continue;
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`Invalid ${key} URL; refusing to forward it into the ACP sandbox.`);
    }
    if (
      !["http:", "https:", "socks5:", "socks5h:"].includes(parsed.protocol) ||
      parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/"
    ) {
      throw new Error(`${key} must be a credential-free proxy URL without path/query data to enter the ACP sandbox.`);
    }
    result.push([key, value], [key.toLowerCase(), value]);
  }
  return result;
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function probeScript(
  role: SandboxedAgentRole,
  deniedWrites: string[],
  writableProbe: string | undefined,
  hiddenHostFiles: string[],
): string {
  const lines = ["set -eu"];
  if (writableProbe) {
    lines.push(`printf sandbox-probe > ${quoteShell(writableProbe)}`);
    lines.push(`rm -f -- ${quoteShell(writableProbe)}`);
  }
  for (const path of deniedWrites) {
    lines.push(`if printf sandbox-probe > ${quoteShell(path)} 2>/dev/null; then rm -f -- ${quoteShell(path)}; echo 'write escaped sandbox: ${role}' >&2; exit 73; fi`);
  }
  for (const path of hiddenHostFiles) {
    lines.push(`if test -e ${quoteShell(path)}; then echo 'host file visible in sandbox: ${role}' >&2; exit 74; fi`);
  }
  return lines.join("\n");
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function existingFile(path: string): Promise<string | undefined> {
  try {
    await lstat(path);
    return path;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function selectedOpenCodeRoute(model: string): { providerId: string; modelId: string } | undefined {
  const modelSpec = model.slice(model.indexOf("/") + 1);
  const separator = modelSpec.indexOf("/");
  if (separator < 1 || separator === modelSpec.length - 1) return undefined;
  const providerId = modelSpec.slice(0, separator);
  const modelId = modelSpec.slice(separator + 1);
  if (!/^[\w.-]+$/u.test(providerId) || !/^[\w.-]+$/u.test(modelId)) {
    throw new Error("OpenCode model/provider ID contains an unsupported character for isolated config staging.");
  }
  return { providerId, modelId };
}

/** Stage only the selected OpenCode credential entry, never the multi-provider host auth file. */
export async function stageSelectedOpenCodeCredential(
  model: string,
  scratchPath: string,
  dataRoot: string,
): Promise<string | undefined> {
  const selected = selectedOpenCodeRoute(model);
  if (!selected) return undefined;
  const source = await existingFile(join(dataRoot, "opencode", "auth.json"));
  if (!source) return undefined;
  const sourceStat = await lstat(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size > 1024 * 1024) {
    throw new Error("Refusing non-regular or oversized OpenCode auth store.");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(source, "utf8")); } catch {
    throw new Error("OpenCode auth store is not valid JSON.");
  }
  if (!plainRecord(parsed) || !(selected.providerId in parsed)) return undefined;
  const target = join(scratchPath, "run", "data", "opencode", "auth.json");
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, `${JSON.stringify({ [selected.providerId]: parsed[selected.providerId] })}\n`, { flag: "wx", mode: 0o600 });
  return target;
}

/** Stage just the selected OpenCode provider definition, never the whole host user config. */
export async function stageSelectedOpenCodeProviderConfig(model: string, scratchPath: string, configRoot: string): Promise<string | undefined> {
  const selected = selectedOpenCodeRoute(model);
  if (!selected) return undefined;
  const { providerId, modelId } = selected;
  const directory = join(configRoot, "opencode");
  const source = (await existingFile(join(directory, "opencode.jsonc")))
    ?? (await existingFile(join(directory, "opencode.json")));
  if (!source) return undefined;
  const sourceStat = await lstat(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size > 1024 * 1024) {
    throw new Error("Refusing non-regular or oversized OpenCode provider config.");
  }
  const errors: ParseError[] = [];
  const parsed = parseJsonc(await readFile(source, "utf8"), errors, { allowTrailingComma: true });
  if (errors.length || !plainRecord(parsed)) {
    throw new Error("OpenCode provider config is not valid JSONC.");
  }
  if (!("provider" in parsed)) return undefined;
  if (!plainRecord(parsed.provider)) throw new Error("OpenCode provider config has an invalid provider object.");
  const provider = parsed.provider[providerId];
  if (!plainRecord(provider)) return undefined;
  if (!plainRecord(provider.models) || !plainRecord(provider.models[modelId])) {
    throw new Error(`OpenCode config has no definition for model ${providerId}/${modelId}.`);
  }
  if (typeof provider.npm !== "string" || !plainRecord(provider.options) ||
    typeof provider.options.baseURL !== "string" ||
    ("apiKey" in provider.options && typeof provider.options.apiKey !== "string")) {
    throw new Error("Selected OpenCode provider requires explicit npm/baseURL fields and an optional string apiKey.");
  }
  let baseURL: URL;
  try {
    baseURL = new URL(provider.options.baseURL);
  } catch {
    throw new Error("Selected OpenCode provider baseURL is invalid.");
  }
  if (!["http:", "https:"].includes(baseURL.protocol) || baseURL.username || baseURL.password || baseURL.search || baseURL.hash) {
    throw new Error("Selected OpenCode provider baseURL must have a credential-free HTTP(S) origin/path.");
  }
  const selectedProvider = {
    npm: provider.npm,
    ...(typeof provider.name === "string" ? { name: provider.name } : {}),
    options: {
      baseURL: provider.options.baseURL,
      ...(typeof provider.options.apiKey === "string" ? { apiKey: provider.options.apiKey } : {}),
    },
    models: { [modelId]: provider.models[modelId] },
  };
  const target = join(scratchPath, "run", "config", "opencode", "opencode.json");
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, `${JSON.stringify({ provider: { [providerId]: selectedProvider } })}\n`, { flag: "wx", mode: 0o600 });
  return target;
}

async function stageSelectedPiCredential(modelRoute: string, runtime: BackendRuntime, scratchPath: string): Promise<string> {
  const modelId = modelRoute.startsWith("pi/") ? modelRoute.slice(3) : "";
  const providerId = modelId.split("/")[0];
  if (!providerId || !/^[a-zA-Z0-9][\w.-]*$/u.test(providerId) || !modelId.includes("/")) {
    throw new Error("Pi ACP model must specify exactly one provider/model route.");
  }
  const source = runtime.credentialSources[0]?.source;
  if (!source) throw new Error("Pi ACP auth source is not configured.");
  const metadata = await lstat(source).catch(() => undefined);
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024) {
    throw new Error("No safe saved Pi auth.json is available; credentials from the host environment are not forwarded.");
  }
  let auth: unknown;
  try { auth = JSON.parse(await readFile(source, "utf8")); } catch {
    throw new Error("Saved Pi auth.json is invalid.");
  }
  if (!plainRecord(auth) || !plainRecord(auth[providerId])) {
    throw new Error(`No saved Pi credential for the selected provider ${providerId}.`);
  }
  const target = join(scratchPath, "run", "home", ".pi", "agent", "auth.json");
  await writeFile(target, `${JSON.stringify({ [providerId]: auth[providerId] })}\n`, { flag: "wx", mode: 0o600 });
  return target;
}

async function prepareCredentials(
  backendId: SupportedAcpBackend,
  runtime: BackendRuntime,
  scratchPath: string,
): Promise<string[]> {
  const staged: string[] = [];
  for (const credential of runtime.credentialSources) {
    const sourceStat = await lstat(credential.source).catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!sourceStat) continue;
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw new Error(`Refusing non-regular ${backendId} credential source: ${credential.source}`);
    }
    const target = join(scratchPath, "run", credential.relativeTarget);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(credential.source, target);
    await chmod(target, 0o600);
    staged.push(target);
  }
  if (staged.length === 0) {
    throw new Error(`No isolated saved credential file was found for ACP backend ${backendId}; host credential environment variables are not forwarded.`);
  }
  return staged;
}

function assertTrustedExternalAgentBinary(
  source: string,
  roots: readonly string[],
): void {
  const real = realpathSync(source);
  const stat = statSync(real);
  if (!stat.isFile() || accessSync(real, fsConstants.X_OK) !== undefined || (stat.mode & 0o022) !== 0) {
    throw new Error(`Refusing mutable or non-executable external agent binary: ${source}`);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && stat.uid !== 0 && stat.uid !== uid) {
    throw new Error(`Refusing external agent binary owned by another user: ${source}`);
  }
  for (const root of roots) {
    if (isWithin(root, real)) {
      throw new Error(`External agent binary may not come from the project/worktree/Golden roots: ${real}`);
    }
  }
  if (isWithin("/tmp", real) || isWithin("/var/tmp", real)) {
    throw new Error(`External agent binary may not come from a temporary directory: ${real}`);
  }
  let cursor = dirname(real);
  while (cursor !== dirname(cursor)) {
    const parent = statSync(cursor);
    if ((parent.mode & 0o022) !== 0) {
      throw new Error(`External agent binary has a group/world-writable parent directory: ${cursor}`);
    }
    cursor = dirname(cursor);
  }
}

async function assertDedicatedWorktreePointer(cwd: string): Promise<void> {
  const path = join(cwd, ".git");
  const pointer = await lstat(path);
  if (!pointer.isFile() || pointer.isSymbolicLink()) {
    throw new Error("Sandbox cwd must be a Git worktree with a regular .git pointer file.");
  }
  const content = await readFile(path, "utf8");
  const target = content.match(/^gitdir: (.+)\r?\n?$/u)?.[1]?.trim();
  if (!target || !isAbsolute(target)) throw new Error("Sandbox cwd has an invalid .git worktree pointer.");
}

export async function createSandboxedBackend(options: SandboxOptions): Promise<SandboxedBackend> {
  const backendId = supportedBackendForModel(options.model);
  const cwd = await realpath(options.cwd);
  const sourceRoot = await realpath(options.sourceRoot);
  const goldenRoot = await realpath(options.goldenRoot);
  assertAgentRoots({ ...options, cwd, sourceRoot, goldenRoot });
  const bwrap = findBubblewrap();
  await assertDedicatedWorktreePointer(cwd);
  const runtime = backendRuntime(backendId);
  if (backendId === "opencode" && runtime.extraBinary) {
    assertTrustedExternalAgentBinary(runtime.extraBinary.source, [cwd, sourceRoot, goldenRoot]);
  }
  const scratchPath = await mkdtemp(join(SCRATCH_ROOT, "pi-plan-execute-sandbox-"));
  const credentials: string[] = [];
  let claudeRelay: ClaudeCredentialRelay | undefined;
  try {
    await prepareScratchLayout(scratchPath, cwd, options.signal);
    if (options.includeProviderCredentials) {
      if (backendId === "claude") {
        claudeRelay = await startClaudeCredentialRelay({ modelRoute: options.model });
      } else if (backendId === "pi") {
        credentials.push(await stageSelectedPiCredential(options.model, runtime, scratchPath));
      } else if (backendId === "opencode") {
        const dataRoot = resolve(process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"));
        const configRoot = resolve(process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"));
        const selectedAuth = await stageSelectedOpenCodeCredential(options.model, scratchPath, dataRoot);
        if (selectedAuth) credentials.push(selectedAuth);
        const selectedConfig = await stageSelectedOpenCodeProviderConfig(options.model, scratchPath, configRoot);
        if (selectedConfig) credentials.push(selectedConfig);
        if (!selectedAuth && !selectedConfig) {
          throw new Error("No isolated saved credential/config was found for the selected OpenCode provider.");
        }
      } else {
        credentials.push(...await prepareCredentials(backendId, runtime, scratchPath));
      }
    }
    const commandArgs = ["--die-with-parent", "--new-session", "--unshare-pid"];
    addMinimalFilesystem(commandArgs, { ...options, cwd, sourceRoot, goldenRoot }, scratchPath, runtime, claudeRelay);
    const config: CustomBackendConfig = {
      command: bwrap,
      args: [...commandArgs, "--", runtime.command, ...runtime.args],
      ...(backendId === "claude" ? {
        sessionMeta: {
          claudeCode: {
            options: {
              settingSources: [],
              allowDangerouslySkipPermissions: false,
              disallowedTools: ["Agent", "Task", "WebSearch", "WebFetch"],
            },
          },
        },
      } : {}),
      fork: { disposition: backendId === "claude" ? "id-only" : "live", cwd: "source-only" },
    };
    let cleaned = false;
    return {
      backendId,
      config,
      scratchPath,
      async scrubCredentials() {
        await Promise.all(credentials.map((path) => rm(path, { force: true })));
        credentials.length = 0;
      },
      async cleanup() {
        if (cleaned) return;
        cleaned = true;
        try {
          await claudeRelay?.close();
        } finally {
          await rm(scratchPath, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try {
      await claudeRelay?.close();
    } finally {
      await rm(scratchPath, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
}

async function prepareScratchDirectories(scratchPath: string): Promise<void> {
  await mkdir(join(scratchPath, "run", "home"), { recursive: true, mode: 0o700 });
  for (const directory of ["codex-home", "data/opencode", "state", "cache", "config", "home/.pi/agent", "home/.claude"]) {
    await mkdir(join(scratchPath, "run", directory), { recursive: true, mode: 0o700 });
  }
}

async function prepareScratchLayout(scratchPath: string, cwd: string, signal?: AbortSignal): Promise<void> {
  await prepareScratchDirectories(scratchPath);
  await prepareReadOnlyGitMirror(cwd, scratchPath, signal);
}

async function prepareProbeScratch(scratchPath: string): Promise<void> {
  await prepareScratchDirectories(scratchPath);
  await mkdir(join(scratchPath, "run", "git-mirror"), { recursive: true, mode: 0o700 });
  await writeFile(join(scratchPath, "run", "git-pointer"), "gitdir: /tmp/run/git-mirror\n", { mode: 0o400 });
}

async function exerciseFilesystemBoundary(
  options: SandboxOptions,
  label: string,
  bwrap: string,
  args: string[],
): Promise<void> {
  const { cwd, sourceRoot, goldenRoot } = options;
  const nonce = randomUUID();
  const hostCanaries = [
    join(homedir(), `.pi-plan-execute-host-canary-${nonce}`),
    join(dirname(sourceRoot), `.pi-plan-execute-other-project-canary-${nonce}`),
    join(SCRATCH_ROOT, `.pi-plan-execute-tmp-canary-${nonce}`),
  ];
  const symlinkProbe = join(cwd, `.pi-plan-execute-symlink-probe-${nonce}`);
  const gitMirrorProbe = `/tmp/run/git-mirror/.pi-plan-execute-sandbox-probe-${nonce}`;
  const deniedWrites: string[] = [];
  let writableProbe: string | undefined;
  try {
    await Promise.all(hostCanaries.map((path) => writeFile(path, nonce, { flag: "wx", mode: 0o600 })));
    const protectedRoots = options.role === "reviewer" ? [cwd, goldenRoot] : [goldenRoot];
    deniedWrites.push(...protectedRoots.map((root) => join(root, `.pi-plan-execute-sandbox-probe-${nonce}`)));
    deniedWrites.push(gitMirrorProbe);
    if (options.role !== "reviewer") writableProbe = join(cwd, `.pi-plan-execute-sandbox-probe-${nonce}`);
    await symlink(join(sourceRoot, "package.json"), symlinkProbe);
    deniedWrites.push(symlinkProbe);
    const script = probeScript(options.role, deniedWrites, writableProbe, hostCanaries);
    try {
      await execFile(bwrap, [...args, "--", "/bin/sh", "-c", script], {
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      throw new Error(`OS filesystem sandbox probe failed for ${label}/${options.role}: ${String(error)}`);
    }
  } finally {
    await Promise.all([
      ...hostCanaries.map((path) => rm(path, { force: true })),
      ...deniedWrites.filter((path) => path !== gitMirrorProbe).map((path) => rm(path, { force: true })),
      ...(writableProbe ? [rm(writableProbe, { force: true })] : []),
      rm(symlinkProbe, { force: true }),
    ]);
  }
}

async function runFilesystemProbe(options: SandboxOptions, runtime: BackendRuntime, label: string): Promise<void> {
  const cwd = await realpath(options.cwd);
  const sourceRoot = await realpath(options.sourceRoot);
  const goldenRoot = await realpath(options.goldenRoot);
  const normalized = { ...options, cwd, sourceRoot, goldenRoot };
  assertAgentRoots(normalized);
  await assertDedicatedWorktreePointer(cwd);
  const bwrap = findBubblewrap();
  const scratchPath = await mkdtemp(join(SCRATCH_ROOT, "pi-plan-execute-sandbox-probe-"));
  try {
    await prepareProbeScratch(scratchPath);
    const args = ["--die-with-parent", "--new-session", "--unshare-pid"];
    addMinimalFilesystem(args, normalized, scratchPath, runtime);
    await exerciseFilesystemBoundary(normalized, label, bwrap, args);
  } finally {
    await rm(scratchPath, { recursive: true, force: true });
  }
}

/** Exercise the actual trusted mount policy before opening an agent session. */
export async function verifySandboxBoundary(options: SandboxOptions): Promise<void> {
  const backendId = supportedBackendForModel(options.model);
  await runFilesystemProbe(options, backendRuntime(backendId), backendId);
}

export interface SandboxedCommandOptions {
  cwd: string;
  sourceRoot: string;
  goldenRoot: string;
  command: string;
  signal?: AbortSignal;
  timeout?: number;
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  return Buffer.isBuffer(value) ? value.toString("utf8") : "";
}

/** Run contract-supplied shell commands with the same filesystem boundary as the ACP actors. */
export async function runSandboxedCommand(options: SandboxedCommandOptions): Promise<GitCommandResult> {
  const sandboxOptions: SandboxOptions = {
    role: "acceptance",
    model: "acceptance-command",
    cwd: options.cwd,
    sourceRoot: options.sourceRoot,
    goldenRoot: options.goldenRoot,
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const runtime: BackendRuntime = { command: "/bin/bash", args: [], credentialSources: [] };
  const cwd = await realpath(options.cwd);
  const sourceRoot = await realpath(options.sourceRoot);
  const goldenRoot = await realpath(options.goldenRoot);
  const normalized = { ...sandboxOptions, cwd, sourceRoot, goldenRoot };
  assertAgentRoots(normalized);
  await assertDedicatedWorktreePointer(cwd);
  const bwrap = findBubblewrap();
  const scratchPath = await mkdtemp(join(SCRATCH_ROOT, "pi-plan-execute-acceptance-"));
  try {
    await prepareScratchLayout(scratchPath, cwd, options.signal);
    // Acceptance commands do not need provider access. Deny all network egress in the
    // kernel rather than trusting shell commands or credential-free proxy settings.
    const args = ["--die-with-parent", "--new-session", "--unshare-pid", "--unshare-net"];
    addMinimalFilesystem(args, normalized, scratchPath, runtime);
    await exerciseFilesystemBoundary(normalized, "acceptance", bwrap, args);
    const timeout = options.timeout ?? 120_000;
    try {
      const result = await execFile(bwrap, [...args, "--", "/bin/bash", "-lc", options.command], {
        timeout,
        maxBuffer: 16 * 1024 * 1024,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return { stdout: result.stdout, stderr: result.stderr, code: 0 };
    } catch (error) {
      const failure = error as { code?: unknown; killed?: unknown; signal?: unknown; stdout?: unknown; stderr?: unknown };
      return {
        stdout: outputText(failure.stdout),
        stderr: outputText(failure.stderr),
        code: typeof failure.code === "number" ? failure.code : -1,
        ...(failure.killed || failure.signal || failure.code === "ETIMEDOUT" || failure.code === "ABORT_ERR" ? { killed: true } : {}),
      };
    }
  } finally {
    await rm(scratchPath, { recursive: true, force: true });
  }
}
