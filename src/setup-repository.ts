import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const INIT_CHOICE = "Initialize Git repository here (no files staged)";

export interface SetupRepositoryUI {
  select(title: string, choices: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  notify(message: string, level: "info" | "warning" | "error"): void;
}

async function git(cwd: string, args: string[]): Promise<string> {
  // A user's GIT_DIR/GIT_WORK_TREE must not redirect setup into a different repository.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const result = await execFile("git", args, { cwd, env, timeout: 15_000, maxBuffer: 16 * 1024 });
  return result.stdout.trim();
}

async function gitEntryExists(root: string): Promise<boolean> {
  try {
    const entry = await lstat(join(root, ".git"));
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      throw new Error("Refusing an unexpected .git entry. Resolve it manually before setup.");
    }
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function ensurePluginIgnored(root: string, ui: SetupRepositoryUI): Promise<void> {
  // Keep plugin runtime/config out of Git status without mutating project files.
  // Repository-local info/exclude is intentionally untracked and applies only here.
  const ignored = await git(root, ["check-ignore", "-q", "--no-index", "--", ".pi-plan-execute-auto/"])
    .then(() => true, () => false);
  if (ignored) return;

  const commonDirRaw = await git(root, ["rev-parse", "--git-common-dir"]);
  const commonDir = resolve(root, commonDirRaw);
  const excludeRaw = await git(root, ["rev-parse", "--git-path", "info/exclude"]);
  const excludePath = resolve(root, excludeRaw);
  const infoDir = dirname(excludePath);
  if (infoDir !== resolve(commonDir, "info")) {
    throw new Error("Refusing unexpected Git info/exclude path; configure .pi-plan-execute-auto/ ignore manually.");
  }
  await mkdir(infoDir, { recursive: true, mode: 0o700 });
  const rule = ".pi-plan-execute-auto/";
  let entry;
  try { entry = await lstat(excludePath); } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  if (!entry) {
    await writeFile(excludePath, `${rule}\n`, { flag: "wx", mode: 0o600 });
  } else {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error("Refusing to modify a non-regular or symlinked Git info/exclude file.");
    }
    const handle = await open(excludePath, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 128 * 1024) throw new Error("Refusing to modify an oversized Git info/exclude file.");
      const content = await handle.readFile("utf8");
      if (content.includes("\0")) throw new Error("Refusing to modify a binary Git info/exclude file.");
      const newline = content.includes("\r\n") ? "\r\n" : "\n";
      const next = `${content}${content && !content.endsWith("\n") ? newline : ""}${rule}${newline}`;
      await handle.truncate(0);
      await handle.write(next, 0, "utf8");
      await handle.truncate(Buffer.byteLength(next));
    } finally { await handle.close(); }
  }
  ui.notify("Configured repository-local .git/info/exclude for .pi-plan-execute-auto/. No project file was changed or staged.", "info");
}

/** Git init and an optional empty commit require distinct UI approvals; user files are never staged. */
export async function ensureSetupRepository(cwd: string, ui: SetupRepositoryUI): Promise<boolean> {
  const root = await realpath(cwd);
  if (root === "/" || root === homedir()) {
    throw new Error("Refusing to initialize or use the filesystem root or the user's home directory as a project repository.");
  }
  const hasEntry = await gitEntryExists(root);
  let gitRoot: string | undefined;
  try {
    gitRoot = resolve(await git(root, ["rev-parse", "--show-toplevel"]));
  } catch {
    // No working-tree root: inspect .git before offering to initialize anything.
  }
  if (gitRoot && gitRoot !== root) {
    ui.notify(`You are inside an existing Git repository at ${gitRoot}. Start Pi from that repository root; setup will not create a nested .git.`, "warning");
    return false;
  }
  if (!gitRoot && hasEntry) {
    throw new Error("A .git entry already exists here, but Git cannot open this repository. Resolve it manually; setup will not overwrite it.");
  }
  if (!gitRoot && !hasEntry) {
    const inGitMetadata = await git(root, ["rev-parse", "--is-inside-git-dir"]).catch(() => "false");
    if (inGitMetadata === "true") throw new Error("Refusing to initialize a repository inside an existing .git metadata directory.");
    const choice = await ui.select("Git repository required for phase commits", [INIT_CHOICE, "Cancel"]);
    if (choice !== INIT_CHOICE) return false;
    await git(root, ["-c", "init.templateDir=/dev/null", "init", "-q"]);
    if (!await gitEntryExists(root) || resolve(await git(root, ["rev-parse", "--show-toplevel"])) !== root) {
      throw new Error("git init did not create a usable Git repository at this project root.");
    }
    ui.notify("Initialized Git here. No project files were staged or committed.", "info");
  }
  await ensurePluginIgnored(root, ui);
  let hasHead = false;
  try { await git(root, ["rev-parse", "--verify", "HEAD"]); hasHead = true; } catch { /* An unborn repository needs a baseline commit. */ }
  if (hasHead) return true;
  const cached = await git(root, ["ls-files", "--cached", "-z"]);
  if (cached) {
    ui.notify("This repository has staged files but no commit. Commit or unstage them yourself before Execution & Review; setup will not commit user files.", "warning");
    return true;
  }
  const createBaseline = await ui.confirm(
    "Create an empty initial Git commit?",
    "Execution & Review requires an existing HEAD to create a dedicated worktree. This creates an EMPTY baseline commit only; it does not add, stage, or commit your files. " +
    "Git user.name and user.email must already be configured. You may decline and create your own initial commit later.",
  );
  if (!createBaseline) {
    ui.notify("Before Approve & Start, create an initial commit and make the source worktree clean. Model setup can continue now.", "warning");
    return true;
  }
  try {
    await git(root, ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "--only", "--no-verify", "-m", "Initialize plan-execute repository"]);
    ui.notify("Created an empty initial commit. Untracked project files were not staged; commit or ignore them before Stage B.", "info");
  } catch {
    ui.notify("Git was initialized, but the empty baseline commit failed (check Git user.name/user.email). Commit manually before Stage B; setup can continue.", "warning");
  }
  return true;
}
