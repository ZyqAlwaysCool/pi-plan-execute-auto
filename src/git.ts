import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  opendir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { BigIntStats } from "node:fs";
import { promisify } from "node:util";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { assertSafeRunId } from "./package-validator.js";
import type {
  GitCommandResult,
  GitOperations,
  PhaseCompletionRecord,
} from "./types.js";

export interface GitFileStatus {
  status: string;
  path: string;
}

// Only roots that the provisioning step actually copies may be treated as disposable.
// Generic build/dist/coverage names remain visible to workspace policy checks.
export const CONTROLLED_ENVIRONMENT_PATHS = ["node_modules", ".venv", "venv"] as const;

export interface GitWorkspaceOptions {
  cwd: string;
  runtimeRoot?: string;
  dedicatedBranch?: string;
  dedicatedWorktreePath?: string;
}

export interface WorkspaceSnapshot {
  head: string;
  branch: string;
  refs: string;
  reflog: string;
  unreachable: string;
  status: string;
  ignored: string;
  workingTreeDiff: string;
  index: string;
  fileHashes: string;
}

export interface DedicatedWorktree {
  branchName: string;
  path: string;
  baseCommit: string;
}

export interface PhaseEvidenceHashes {
  execution_report_sha256: string;
  review_report_sha256: string;
  acceptance_report_sha256: string;
  final_diff_sha256: string;
  reviewed_diff_sha256: string;
  completion_payload_sha256: string;
}

export function phaseCompletionPayloadSha256(
  value: PhaseCompletionRecord | Omit<PhaseCompletionRecord, "phase_commit_sha">,
): string {
  const { phase_commit_sha: _phaseCommitSha, ...payload } = value as PhaseCompletionRecord;
  return createHash("sha256").update(`${JSON.stringify(payload, null, 2)}\n`).digest("hex");
}

export function phaseEvidenceHashesForRecord(record: PhaseCompletionRecord): PhaseEvidenceHashes {
  return {
    execution_report_sha256: record.execution_report_sha256,
    review_report_sha256: record.review_report_sha256,
    acceptance_report_sha256: record.acceptance_report_sha256,
    final_diff_sha256: record.final_diff_sha256,
    reviewed_diff_sha256: record.reviewed_diff_sha256,
    completion_payload_sha256: phaseCompletionPayloadSha256(record),
  };
}

export function phaseCommitMessage(message: string, evidence: PhaseEvidenceHashes): string {
  return [
    message,
    "",
    "pi-plan-execute-auto-evidence-version: 1",
    `execution-report-sha256: ${evidence.execution_report_sha256}`,
    `review-report-sha256: ${evidence.review_report_sha256}`,
    `acceptance-report-sha256: ${evidence.acceptance_report_sha256}`,
    `final-diff-sha256: ${evidence.final_diff_sha256}`,
    `reviewed-diff-sha256: ${evidence.reviewed_diff_sha256}`,
    `completion-payload-sha256: ${evidence.completion_payload_sha256}`,
  ].join("\n");
}

export const DEFAULT_PROVISION_PATHS = ["node_modules", ".venv", "venv"] as const;
export const DEFAULT_PROVISION_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const DEFAULT_PROVISION_MAX_FILES = 500_000;

export interface ProvisionOptions {
  signal?: AbortSignal;
  timeout?: number;
  maxBytes?: number;
  maxFiles?: number;
}

interface ProvisionBudget {
  bytes: number;
  files: number;
  maxBytes: number;
  maxFiles: number;
  sourceRoot: string;
  deadline: number | undefined;
  signal: AbortSignal | undefined;
}

function checkProvisionBudget(budget: ProvisionBudget): void {
  if (budget.signal?.aborted) throw budget.signal.reason ?? new Error("Dependency provisioning cancelled.");
  if (budget.deadline !== undefined && Date.now() > budget.deadline) {
    throw new Error("Dependency provisioning exceeded its timeout.");
  }
  if (budget.files > budget.maxFiles) throw new Error(`Dependency provisioning exceeded ${budget.maxFiles} files.`);
  if (budget.bytes > budget.maxBytes) throw new Error(`Dependency provisioning exceeded ${budget.maxBytes} bytes.`);
}

function assertInside(root: string, candidate: string): void {
  const relativePath = relative(root, candidate);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Dependency symlink escapes the source project: ${candidate}`);
  }
}

async function copyProvisionFile(source: string, target: string, mode: number, budget: ProvisionBudget): Promise<void> {
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        checkProvisionBudget(budget);
        budget.bytes += chunk.byteLength;
        checkProvisionBudget(budget);
        callback(null, chunk);
      } catch (error) {
        callback(error as Error);
      }
    },
  });
  await pipeline(
    createReadStream(source, { highWaterMark: 64 * 1024 }),
    limiter,
    createWriteStream(target, { flags: "wx", mode: mode & 0o777 }),
    ...(budget.signal ? [{ signal: budget.signal }] : []),
  );
  await chmod(target, mode & 0o777).catch(() => undefined);
}

async function copyProvisionTree(source: string, target: string, budget: ProvisionBudget): Promise<void> {
  checkProvisionBudget(budget);
  const stat = await lstat(source);
  budget.files += 1;
  checkProvisionBudget(budget);
  if (stat.isDirectory()) {
    await mkdir(target, { recursive: true, mode: stat.mode & 0o777 });
    const directory = await opendir(source);
    try {
      for await (const entry of directory) {
        await copyProvisionTree(resolve(source, entry.name), resolve(target, entry.name), budget);
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    return;
  }
  if (stat.isSymbolicLink()) {
    const link = await readlink(source);
    const resolvedTarget = isAbsolute(link) ? resolve(link) : resolve(dirname(source), link);
    try {
      if (isAbsolute(link)) throw new Error(`Dependency symlink is absolute: ${source}`);
      assertInside(budget.sourceRoot, resolvedTarget);
      // Relative links inside the project remain relative so they resolve inside the private worktree.
      await symlink(link, target);
      return;
    } catch (error) {
      // A common virtualenv link points to a read-only external interpreter. Copy external files
      // rather than preserving an escape-capable symlink; external directories are rejected.
      const external = await lstat(resolvedTarget).catch(() => undefined);
      if (!external?.isFile()) throw error;
      await copyProvisionFile(resolvedTarget, target, external.mode, budget);
      return;
    }
  }
  if (!stat.isFile()) throw new Error(`Unsupported dependency entry type: ${source}`);
  if (budget.bytes + stat.size > budget.maxBytes) throw new Error(`Dependency provisioning exceeded ${budget.maxBytes} bytes.`);
  await copyProvisionFile(source, target, stat.mode, budget);
}

/** Copy common ignored dependency environments into a fresh worktree with cancellation and bounds. */
export async function provisionDedicatedEnvironment(
  sourceCwd: string,
  targetCwd: string,
  paths: readonly string[] = DEFAULT_PROVISION_PATHS,
  options: ProvisionOptions = {},
): Promise<string[]> {
  const copied: string[] = [];
  const sourceRoot = await realpath(sourceCwd);
  const targetRoot = await realpath(targetCwd);
  const targetFromSource = relative(sourceRoot, targetRoot);
  const sourceFromTarget = relative(targetRoot, sourceRoot);
  if (
    targetFromSource === "" || (!targetFromSource.startsWith("..") && !isAbsolute(targetFromSource)) ||
    sourceFromTarget === "" || (!sourceFromTarget.startsWith("..") && !isAbsolute(sourceFromTarget))
  ) throw new Error("Dependency provisioning source and dedicated target must be separate trees.");
  if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0)) {
    throw new Error("Dependency provisioning timeout must be a positive finite number.");
  }
  const deadline = options.timeout !== undefined ? Date.now() + options.timeout : undefined;
  const controller = new AbortController();
  const abortExternal = () => controller.abort(options.signal?.reason ?? new Error("Dependency provisioning cancelled."));
  if (options.signal?.aborted) abortExternal();
  else options.signal?.addEventListener("abort", abortExternal, { once: true });
  const timer = options.timeout !== undefined
    ? setTimeout(() => controller.abort(new Error(`Dependency provisioning exceeded its ${options.timeout}ms timeout.`)), options.timeout)
    : undefined;
  const budget: ProvisionBudget = {
    bytes: 0,
    files: 0,
    maxBytes: options.maxBytes ?? DEFAULT_PROVISION_MAX_BYTES,
    maxFiles: options.maxFiles ?? DEFAULT_PROVISION_MAX_FILES,
    sourceRoot,
    deadline,
    signal: controller.signal,
  };
  try {
    for (const relativePath of paths) {
      if (!relativePath || isAbsolute(relativePath) || relativePath.split(/[\\/]/u).some((part) => part === ".." || part === "" || part === ".")) {
        throw new Error(`Unsafe dependency provisioning path: ${relativePath}`);
      }
      const source = resolve(sourceRoot, relativePath);
      const target = resolve(targetRoot, relativePath);
      let sourceStat;
      try {
        sourceStat = await lstat(source);
      } catch (error) {
        if (isMissingFileError(error)) continue;
        throw error;
      }
      if (sourceStat.isSymbolicLink()) throw new Error(`Controlled environment source is a symlink: ${source}`);
      if (!sourceStat.isDirectory()) throw new Error(`Controlled environment source is not a directory: ${source}`);
      checkProvisionBudget(budget);
      try {
        const targetStat = await lstat(target);
        if (targetStat.isSymbolicLink()) throw new Error(`Controlled environment target is a symlink: ${target}`);
        if (!targetStat.isDirectory()) throw new Error(`Controlled environment target is not a directory: ${target}`);
        copied.push(relativePath);
        continue;
      } catch (error) {
        if (error instanceof Error && /^Controlled environment target is not a directory:|^Controlled environment target is a symlink:/u.test(error.message)) throw error;
        if (!isMissingFileError(error)) throw error;
        // Target is absent; copy into a private temporary tree before publishing it.
      }
      const temporary = `${target}.pi-provision-${process.pid}-${Date.now()}`;
      let published = false;
      try {
        await mkdir(dirname(target), { recursive: true });
        await copyProvisionTree(source, temporary, budget);
        checkProvisionBudget(budget);
        await rename(temporary, target);
        published = true;
        checkProvisionBudget(budget);
        copied.push(relativePath);
      } catch (error) {
        await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
        if (published) await rm(target, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    }
    return copied;
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortExternal);
  }
}

function commandError(args: string[], result: GitCommandResult): GitPolicyError {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
  return new GitPolicyError(`git ${args.join(" ")} failed: ${detail}`, "GIT_COMMAND_FAILED");
}

function parseNullSeparatedNames(output: string): string[] {
  return output.split("\0").filter((value) => value.length > 0);
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function parseStatus(output: string): GitFileStatus[] {
  const records = output.split("\0").filter((value) => value.length > 0);
  const result: GitFileStatus[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2);
    const firstPath = record.slice(3);
    result.push({ status, path: firstPath });
    if (status.includes("R") || status.includes("C")) {
      const destination = records[index + 1];
      if (destination) {
        result.push({ status, path: destination });
        index += 1;
      }
    }
  }
  return result;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Git adapter with the policy-sensitive operations kept in one place. Commands are passed as
 * argv, never through a shell, so file names and commit messages cannot become shell syntax.
 */
export class GitWorkspace {
  readonly cwd: string;
  readonly runtimeRoot: string;
  readonly dedicatedBranch: string | undefined;
  readonly dedicatedWorktreePath: string | undefined;
  private readonly git: GitOperations;
  private readonly fileHashCache = new Map<string, { signature: string; sha256: string }>();

  constructor(git: GitOperations, options: GitWorkspaceOptions) {
    this.git = git;
    this.cwd = options.cwd;
    this.runtimeRoot = options.runtimeRoot ?? ".pi-plan-execute-auto";
    this.dedicatedBranch = options.dedicatedBranch;
    this.dedicatedWorktreePath = options.dedicatedWorktreePath;
  }

  private pathspecs(): string[] {
    return [
      ".",
      `:(exclude)${this.runtimeRoot}`,
      `:(exclude)${this.runtimeRoot}/**`,
    ];
  }

  async head(options?: { signal?: AbortSignal; timeout?: number }): Promise<string> {
    const result = await this.git.run(["rev-parse", "HEAD"], options);
    if (result.code !== 0) throw commandError(["rev-parse", "HEAD"], result);
    const value = result.stdout.trim();
    if (!/^[0-9a-f]{7,64}$/i.test(value)) {
      throw new GitPolicyError("git rev-parse HEAD returned an invalid commit SHA.", "GIT_HEAD_INVALID");
    }
    return value;
  }

  async status(options?: { signal?: AbortSignal; timeout?: number }): Promise<GitFileStatus[]> {
    const args = ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...this.pathspecs()];
    const result = await this.git.run(args, options);
    if (result.code !== 0) throw commandError(args, result);
    return parseStatus(result.stdout);
  }

  async changedPaths(options?: { signal?: AbortSignal; timeout?: number }): Promise<string[]> {
    return uniqueSorted((await this.status(options)).map((entry) => entry.path));
  }

  async cachedPaths(options?: { signal?: AbortSignal; timeout?: number }): Promise<string[]> {
    const args = ["diff", "--cached", "--name-only", "-z", "--", ...this.pathspecs()];
    const result = await this.git.run(args, options);
    if (result.code !== 0) throw commandError(args, result);
    return uniqueSorted(parseNullSeparatedNames(result.stdout));
  }

  async assertNoCachedChanges(options?: { signal?: AbortSignal; timeout?: number }): Promise<void> {
    const paths = await this.cachedPaths(options);
    if (paths.length > 0) {
      throw new GitPolicyError(
        `Harness left staged changes before plugin commit: ${paths.join(", ")}.`,
        "HARNESS_STAGED_CHANGES",
      );
    }
  }

  /**
   * Capture the full commit/index/worktree evidence relevant to the phase. A path-only status
   * comparison is insufficient because a reviewer can replace the bytes of an already changed
   * file without changing its path set.
   */
  private statSignature(stat: BigIntStats): string {
    return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
  }

  private async hashWorkspaceFile(path: string, signal?: AbortSignal): Promise<string> {
    const absolute = resolve(this.cwd, path);
    const before = await lstat(absolute, { bigint: true });
    const signature = this.statSignature(before);
    if (before.isSymbolicLink()) {
      await this.assertContainedSymlink(path);
      const target = await readlink(absolute);
      const after = await lstat(absolute, { bigint: true });
      if (this.statSignature(after) !== signature) {
        throw new GitPolicyError(`Workspace symlink changed while snapshotting: ${path}.`, "WORKSPACE_SNAPSHOT_RACE");
      }
      return createHash("sha256").update(`symlink:${target}`).digest("hex");
    }
    if (!before.isFile()) {
      const after = await lstat(absolute, { bigint: true });
      if (this.statSignature(after) !== signature) {
        throw new GitPolicyError(`Workspace entry changed while snapshotting: ${path}.`, "WORKSPACE_SNAPSHOT_RACE");
      }
      return createHash("sha256").update(`special:${signature}`).digest("hex");
    }
    const cached = this.fileHashCache.get(absolute);
    if (cached?.signature === signature) {
      const after = await lstat(absolute, { bigint: true });
      if (this.statSignature(after) !== signature) {
        throw new GitPolicyError(`Workspace file changed while snapshotting: ${path}.`, "WORKSPACE_SNAPSHOT_RACE");
      }
      return cached.sha256;
    }
    const fileHash = createHash("sha256");
    const stream = createReadStream(absolute, { highWaterMark: 256 * 1024, ...(signal ? { signal } : {}) });
    for await (const chunk of stream) fileHash.update(chunk);
    const after = await lstat(absolute, { bigint: true });
    if (this.statSignature(after) !== signature) {
      throw new GitPolicyError(`Workspace file changed while snapshotting: ${path}.`, "WORKSPACE_SNAPSHOT_RACE");
    }
    const sha256 = fileHash.digest("hex");
    this.fileHashCache.set(absolute, { signature, sha256 });
    return sha256;
  }

  private async assertContainedSymlink(path: string): Promise<void> {
    const absolute = resolve(this.cwd, path);
    const link = await readlink(absolute);
    const lexicalTarget = isAbsolute(link) ? resolve(link) : resolve(dirname(absolute), link);
    const root = resolve(this.cwd);
    const relativeTarget = relative(root, lexicalTarget);
    if (isAbsolute(link) || relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
      throw new GitPolicyError(`Workspace symlink escapes the dedicated worktree: ${path} -> ${link}.`, "WORKSPACE_SYMLINK_ESCAPE");
    }
    try {
      const realTarget = await realpath(absolute);
      const realRelative = relative(root, realTarget);
      if (realRelative.startsWith("..") || isAbsolute(realRelative)) {
        throw new GitPolicyError(`Workspace symlink resolves outside the dedicated worktree: ${path}.`, "WORKSPACE_SYMLINK_ESCAPE");
      }
    } catch (error) {
      if (error instanceof GitPolicyError) throw error;
      if (!isMissingFileError(error)) {
        throw new GitPolicyError(`Unable to verify workspace symlink target: ${path}.`, "WORKSPACE_SYMLINK_CHECK_FAILED");
      }
      // A dangling contained link is still observable as a normal workspace change.
    }
  }

  async snapshot(options?: { signal?: AbortSignal; timeout?: number }): Promise<WorkspaceSnapshot> {
    const commandOptions = options;
    const head = await this.head(commandOptions);
    const branchResult = await this.git.run(["symbolic-ref", "--short", "-q", "HEAD"], commandOptions);
    const refsResult = await this.git.run(["for-each-ref", "--format=%(refname) %(objectname)"], commandOptions);
    const reflogResult = await this.git.run(["reflog", "--all", "--format=%H%x00%gD%x00%gs"], commandOptions);
    const unreachableResult = await this.git.run(["fsck", "--no-reflogs", "--unreachable", "--no-progress"], commandOptions);
    if (refsResult.code !== 0 || reflogResult.code !== 0 || unreachableResult.code !== 0) {
      throw new GitPolicyError("Unable to capture Git refs/reflog evidence.", "GIT_HISTORY_EVIDENCE_FAILED");
    }
    const statusArgs = ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...this.pathspecs()];
    const statusResult = await this.git.run(statusArgs, commandOptions);
    if (statusResult.code !== 0) throw commandError(statusArgs, statusResult);
    const ignoredArgs = ["status", "--porcelain=v1", "-z", "--ignored", "--untracked-files=all", "--", ...this.pathspecs()];
    const ignoredResult = await this.git.run(ignoredArgs, commandOptions);
    if (ignoredResult.code !== 0) throw commandError(ignoredArgs, ignoredResult);
    const ignoredFilesArgs = ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...this.pathspecs()];
    const ignoredFilesResult = await this.git.run(ignoredFilesArgs, commandOptions);
    if (ignoredFilesResult.code !== 0) throw commandError(ignoredFilesArgs, ignoredFilesResult);
    const diffArgs = ["diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD", "--", ...this.pathspecs()];
    const diffResult = await this.git.run(diffArgs, commandOptions);
    if (diffResult.code !== 0) throw commandError(diffArgs, diffResult);
    const indexArgs = ["ls-files", "--stage", "-z", "--", ...this.pathspecs()];
    const indexResult = await this.git.run(indexArgs, commandOptions);
    if (indexResult.code !== 0) throw commandError(indexArgs, indexResult);

    const entries = parseStatus(statusResult.stdout);
    const fileHash = createHash("sha256");
    for (const entry of entries) {
      fileHash.update(entry.status);
      fileHash.update("\0");
      fileHash.update(entry.path);
      fileHash.update("\0");
      try {
        fileHash.update(await this.hashWorkspaceFile(entry.path, commandOptions?.signal));
      } catch (error) {
        if (error instanceof GitPolicyError) throw error;
        if (!isMissingFileError(error)) {
          throw new GitPolicyError(`Unable to hash workspace file: ${entry.path}.`, "WORKSPACE_SNAPSHOT_FAILED");
        }
        fileHash.update("<missing>");
      }
      fileHash.update("\0");
    }
    const ignoredStatusEvidence = parseStatus(ignoredResult.stdout)
      .filter((entry) => entry.status === "!!")
      .map((entry) => `${entry.status}\0${entry.path}\0`)
      .join("");
    const ignoredBytesHash = createHash("sha256").update(ignoredStatusEvidence);
    for (const path of parseNullSeparatedNames(ignoredFilesResult.stdout)) {
      ignoredBytesHash.update(path);
      ignoredBytesHash.update("\0");
      try {
        // Provisioned dependencies remain workspace bytes; cached digests avoid rereading unchanged trees.
        ignoredBytesHash.update(await this.hashWorkspaceFile(path, commandOptions?.signal));
      } catch (error) {
        if (error instanceof GitPolicyError) throw error;
        if (!isMissingFileError(error)) {
          throw new GitPolicyError(`Unable to hash ignored workspace file: ${path}.`, "WORKSPACE_SNAPSHOT_FAILED");
        }
        ignoredBytesHash.update("<missing>");
      }
      ignoredBytesHash.update("\0");
    }
    return {
      head,
      branch: branchResult.code === 0 ? branchResult.stdout.trim() : "(detached)",
      refs: createHash("sha256").update(refsResult.stdout).digest("hex"),
      reflog: createHash("sha256").update(reflogResult.stdout).digest("hex"),
      unreachable: createHash("sha256").update(unreachableResult.stdout).digest("hex"),
      status: createHash("sha256").update(statusResult.stdout).digest("hex"),
      ignored: ignoredBytesHash.digest("hex"),
      workingTreeDiff: createHash("sha256").update(diffResult.stdout).digest("hex"),
      index: createHash("sha256").update(indexResult.stdout).digest("hex"),
      fileHashes: fileHash.digest("hex"),
    };
  }

  async assertDedicatedIdentity(): Promise<void> {
    if (!this.dedicatedBranch || !this.dedicatedWorktreePath) {
      throw new GitPolicyError(
        "Execution & Review requires a plugin-created dedicated branch and worktree.",
        "DEDICATED_WORKTREE_REQUIRED",
      );
    }
    const branchResult = await this.git.run(["branch", "--show-current"]);
    const topResult = await this.git.run(["rev-parse", "--show-toplevel"]);
    if (branchResult.code !== 0 || topResult.code !== 0) {
      throw new GitPolicyError("Unable to verify dedicated worktree identity.", "WORKTREE_IDENTITY_UNKNOWN");
    }
    if (branchResult.stdout.trim() !== this.dedicatedBranch || resolve(topResult.stdout.trim()) !== resolve(this.dedicatedWorktreePath)) {
      throw new GitPolicyError(
        `Execution & Review is not running in its dedicated worktree (${this.dedicatedBranch} at ${this.dedicatedWorktreePath}).`,
        "WORKTREE_IDENTITY_MISMATCH",
      );
    }
  }

  async diffFrom(baseCommit: string, options?: { signal?: AbortSignal; timeout?: number }): Promise<string> {
    const statuses = await this.status(options);
    const paths = uniqueSorted(statuses.map((entry) => entry.path));
    let diff = "";
    for (const path of paths) {
      const status = statuses.find((entry) => entry.path === path)?.status ?? "";
      let piece: string;
      if (status.startsWith("??")) {
        const noIndexArgs = ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--binary", "--", "/dev/null", path];
        const noIndex = await this.git.run(noIndexArgs, options);
        // git diff --no-index returns 1 for a real difference and 0 for equality.
        if (noIndex.code > 1) throw commandError(noIndexArgs, noIndex);
        piece = noIndex.stdout;
      } else {
        const args = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--binary", baseCommit, "--", path];
        const result = await this.git.run(args, options);
        if (result.code !== 0) throw commandError(args, result);
        piece = result.stdout;
      }
      // Each Git diff invocation already terminates its patch in the canonical byte stream.
      // Never add a synthetic separator: cached/commit diff hashes must be identical.
      if (piece) diff += piece;
    }
    return diff;
  }

  async verifyPhaseCommit(
    phaseCommit: string,
    baseCommit: string,
    message: string,
    expectedDiffSha256: string,
    options?: { signal?: AbortSignal; timeout?: number },
    evidence?: PhaseEvidenceHashes,
  ): Promise<void> {
    const typeArgs = ["cat-file", "-t", phaseCommit];
    const typeResult = await this.git.run(typeArgs, options);
    if (typeResult.code !== 0 || typeResult.stdout.trim() !== "commit") {
      throw new GitPolicyError(`Completion SHA is not a Git commit: ${phaseCommit}.`, "COMMIT_OBJECT_INVALID");
    }
    const showArgs = ["show", "-s", "--format=%H%x00%P%x00%B", phaseCommit];
    const shown = await this.git.run(showArgs, options);
    if (shown.code !== 0) throw commandError(showArgs, shown);
    const [shownSha, parents, fullMessage] = shown.stdout.trimEnd().split("\0");
    if (shownSha !== phaseCommit || parents !== baseCommit) {
      throw new GitPolicyError(
        `Completion commit ${phaseCommit} is not a direct child of its phase base ${baseCommit}.`,
        "COMMIT_PARENT_MISMATCH",
      );
    }
    const diffArgs = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--binary", baseCommit, phaseCommit];
    const diff = await this.git.run(diffArgs, options);
    if (diff.code !== 0) throw commandError(diffArgs, diff);
    const diffSha256 = createHash("sha256").update(diff.stdout).digest("hex");
    if (diffSha256 !== expectedDiffSha256) {
      throw new GitPolicyError(
        `Completion commit diff does not match final diff evidence for ${phaseCommit}.`,
        "COMMIT_DIFF_MISMATCH",
      );
    }
    const expectedMessage = evidence ? phaseCommitMessage(message, evidence) : message;
    const expectedSubject = message.trim().split(/\r?\n/, 1)[0] ?? "";
    const actualSubject = (fullMessage ?? "").split(/\r?\n/, 1)[0] ?? "";
    if (actualSubject !== expectedSubject || (evidence !== undefined && (fullMessage ?? "").trimEnd() !== expectedMessage.trimEnd())) {
      throw new GitPolicyError(
        `Completion commit message does not match the phase contract/evidence anchor for ${phaseCommit}.`,
        "COMMIT_MESSAGE_MISMATCH",
      );
    }
  }

  async commitPhase(
    baseCommit: string,
    paths: readonly string[],
    message: string,
    allowEmpty: boolean,
    options?: { signal?: AbortSignal; timeout?: number; expectedDiffSha256?: string },
  ): Promise<string> {
    const commandOptions = options
      ? {
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
        }
      : undefined;
    const currentHead = await this.head(commandOptions);
    if (currentHead !== baseCommit) {
      throw new GitPolicyError(
        `HEAD changed from ${baseCommit} to ${currentHead} before phase commit.`,
        "HEAD_CHANGED",
      );
    }
    await this.assertNoCachedChanges(commandOptions);
    const changed = uniqueSorted(paths);
    if (changed.length === 0 && !allowEmpty) {
      throw new GitPolicyError("Phase has no file changes and does not allow an empty commit.", "EMPTY_COMMIT_FORBIDDEN");
    }
    if (changed.length > 0) {
      const addArgs = ["add", "--", ...changed];
      const added = await this.git.run(addArgs, commandOptions);
      if (added.code !== 0) throw commandError(addArgs, added);
      const staged = await this.cachedPaths(commandOptions);
      const expected = uniqueSorted(changed);
      if (staged.length !== expected.length || staged.some((path, index) => path !== expected[index])) {
        throw new GitPolicyError(
          `Plugin staging set differs from validated phase paths. Expected ${expected.join(", ")}; got ${staged.join(", ")}.`,
          "STAGING_SET_MISMATCH",
        );
      }
    }
    if (options?.expectedDiffSha256) {
      const cachedDiffArgs = ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-renames", "--binary"];
      const cachedDiff = await this.git.run(cachedDiffArgs, commandOptions);
      if (cachedDiff.code !== 0) throw commandError(cachedDiffArgs, cachedDiff);
      const cachedDiffSha256 = createHash("sha256").update(cachedDiff.stdout).digest("hex");
      if (cachedDiffSha256 !== options.expectedDiffSha256) {
        throw new GitPolicyError(
          "Plugin cached diff differs from the Reviewer-approved diff; no commit was created.",
          "CACHED_DIFF_MISMATCH",
        );
      }
    }
    const commitArgs = ["commit", ...(changed.length === 0 ? ["--allow-empty"] : []), "-m", message];
    const committed = await this.git.run(commitArgs, commandOptions);
    if (committed.code !== 0) throw commandError(commitArgs, committed);
    const committedHead = await this.head(commandOptions);
    await this.assertNoCachedChanges(commandOptions);
    const remaining = await this.changedPaths(commandOptions);
    if (remaining.length > 0) {
      throw new GitPolicyError(
        `Workspace changed during plugin commit after ${committedHead}: ${remaining.join(", ")}.`,
        "POST_COMMIT_WORKSPACE_DIRTY",
      );
    }
    return committedHead;
  }
}

export class GitPolicyError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "GitPolicyError";
    this.code = code;
  }
}

const execFile = promisify(execFileCallback);

export function createLocalGitOperations(cwd: string): GitOperations {
  return {
    async run(args, options) {
      try {
        const result = await execFile("git", args, {
          cwd,
          maxBuffer: 128 * 1024 * 1024,
          ...(options?.signal ? { signal: options.signal } : {}),
          ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
        });
        return { stdout: result.stdout, stderr: result.stderr, code: 0 };
      } catch (error) {
        const value = error as { stdout?: string; stderr?: string; code?: number; killed?: boolean };
        return {
          stdout: value.stdout ?? "",
          stderr: value.stderr ?? "",
          code: typeof value.code === "number" ? value.code : 1,
          ...(value.killed ? { killed: true } : {}),
        };
      }
    },
  };
}

export function createPiGitOperations(
  pi: { exec(command: string, args: string[], options?: { signal?: AbortSignal | undefined; timeout?: number | undefined; cwd?: string | undefined }): Promise<GitCommandResult> },
  cwd?: string,
): GitOperations {
  return {
    run(args, options) {
      return pi.exec("git", args, {
        ...options,
        ...(cwd ? { cwd } : {}),
      });
    },
  };
}

export async function ensureDedicatedWorktree(
  sourceGit: GitOperations,
  options: {
    sourceCwd: string;
    runId: string;
    runtimeRoot: string;
    targetPath: string;
    branchName: string;
    targetGit: GitOperations;
    existing?: { path?: string; branchName?: string };
    signal?: AbortSignal;
    timeout?: number;
  },
): Promise<DedicatedWorktree> {
  assertSafeRunId(options.runId);
  const commandOptions = {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
  };
  const source = new GitWorkspace(sourceGit, {
    cwd: options.sourceCwd,
    runtimeRoot: options.runtimeRoot,
  });
  const baseCommit = await source.head(commandOptions);
  await source.assertNoCachedChanges(commandOptions);
  const dirty = await source.changedPaths(commandOptions);
  if (dirty.length > 0) {
    throw new GitPolicyError(
      `Main worktree must be clean before creating the dedicated execution worktree: ${dirty.join(", ")}.`,
      "SOURCE_WORKTREE_DIRTY",
    );
  }

  const targetPath = resolve(options.targetPath);
  const branchName = options.branchName;
  if (options.existing?.path || options.existing?.branchName) {
    if (options.existing.path !== targetPath || options.existing.branchName !== branchName) {
      throw new GitPolicyError("Persisted dedicated worktree identity does not match this run.", "WORKTREE_IDENTITY_MISMATCH");
    }
    const branch = await options.targetGit.run(["branch", "--show-current"], commandOptions);
    const top = await options.targetGit.run(["rev-parse", "--show-toplevel"], commandOptions);
    if (branch.code !== 0 || top.code !== 0 || branch.stdout.trim() !== branchName || resolve(top.stdout.trim()) !== targetPath) {
      throw new GitPolicyError("Persisted dedicated worktree cannot be verified.", "WORKTREE_IDENTITY_UNKNOWN");
    }
    const targetHead = await new GitWorkspace(options.targetGit, { cwd: targetPath }).head(commandOptions);
    return { branchName, path: targetPath, baseCommit: targetHead };
  }

  await mkdir(dirname(targetPath), { recursive: true });
  try {
    await access(targetPath);
    throw new GitPolicyError(`Dedicated worktree path already exists: ${targetPath}.`, "WORKTREE_PATH_EXISTS");
  } catch (error) {
    if (error instanceof GitPolicyError) throw error;
  }
  const addArgs = ["worktree", "add", "-b", branchName, targetPath, baseCommit];
  const added = await sourceGit.run(addArgs, commandOptions);
  if (added.code !== 0) throw commandError(addArgs, added);
  const target = new GitWorkspace(options.targetGit, {
    cwd: targetPath,
    dedicatedBranch: branchName,
    dedicatedWorktreePath: targetPath,
  });
  await target.assertDedicatedIdentity();
  return { branchName, path: targetPath, baseCommit };
}
