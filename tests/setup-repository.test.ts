import { execFile as callback } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureSetupRepository, type SetupRepositoryUI } from "../src/setup-repository.js";

const git = promisify(callback);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "peac-init-ui-"));
  const project = join(root, "project");
  await mkdir(project);
  return { root, project };
}
function ui(choice: string, baseline: boolean, notes: string[] = []): SetupRepositoryUI {
  return {
    async select() { return choice; },
    async confirm() { return baseline; },
    notify(message) { notes.push(message); },
  };
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch { return false; }
}

test("setup does not initialize Git unless the human explicitly selects it", async () => {
  const { root, project } = await fixture();
  try {
    assert.equal(await ensureSetupRepository(project, ui("Cancel", false)), false);
    assert.equal(await exists(join(project, ".git")), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("initializing configures a repository-local runtime ignore rule without changing project files", async () => {
  const { root, project } = await fixture();
  const notes: string[] = [];
  try {
    await writeFile(join(project, "user-file.txt"), "keep these bytes\n");
    assert.equal(await ensureSetupRepository(project, ui("Initialize Git repository here (no files staged)", false, notes)), true);
    assert.equal(await exists(join(project, ".git")), true);
    assert.equal(await exists(join(project, ".gitignore")), false);
    assert.match(await readFile(join(project, ".git", "info", "exclude"), "utf8"), /\.pi-plan-execute-auto\//);
    assert.equal(await readFile(join(project, "user-file.txt"), "utf8"), "keep these bytes\n");
    await assert.rejects(git("git", ["-C", project, "rev-parse", "--verify", "HEAD"]));
    assert.equal((await git("git", ["-C", project, "ls-files"])).stdout.trim(), "");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("separately approved baseline commit is empty and never captures untracked files", async () => {
  const { root, project } = await fixture();
  try {
    await writeFile(join(project, "user-file.txt"), "must stay untracked\n");
    const widget = ui("Initialize Git repository here (no files staged)", true);
    widget.confirm = async () => {
      await git("git", ["-C", project, "config", "user.name", "Setup Fixture"]);
      await git("git", ["-C", project, "config", "user.email", "setup@example.invalid"]);
      return true;
    };
    assert.equal(await ensureSetupRepository(project, widget), true);
    assert.ok((await git("git", ["-C", project, "rev-parse", "HEAD"])).stdout.trim());
    assert.equal((await git("git", ["-C", project, "ls-tree", "-r", "--name-only", "HEAD"])).stdout.trim(), "");
    assert.equal((await git("git", ["-C", project, "status", "--porcelain"])).stdout.trim(), "?? user-file.txt");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("setup appends the runtime rule once to Git info/exclude without changing .gitignore", async () => {
  const { root, project } = await fixture();
  try {
    await git("git", ["-C", project, "init", "-q"]);
    await writeFile(join(project, ".gitignore"), "# existing\r\nnode_modules/\n", "utf8");
    const before = await readFile(join(project, ".gitignore"), "utf8");
    await ensureSetupRepository(project, ui("unused", false));
    await ensureSetupRepository(project, ui("unused", false));
    assert.equal(await readFile(join(project, ".gitignore"), "utf8"), before);
    const exclude = await readFile(join(project, ".git", "info", "exclude"), "utf8");
    assert.equal((exclude.match(/\.pi-plan-execute-auto\//g) ?? []).length, 1);
    await mkdir(join(project, ".pi-plan-execute-auto"));
    await writeFile(join(project, ".pi-plan-execute-auto", "config.json"), "{}\n");
    assert.equal((await git("git", ["-C", project, "status", "--porcelain"])).stdout.trim(), "?? .gitignore");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("setup refuses a symlinked Git info/exclude without changing its target", async () => {
  const { root, project } = await fixture();
  try {
    await git("git", ["-C", project, "init", "-q"]);
    const exclude = join(project, ".git", "info", "exclude");
    const outside = join(root, "outside-ignore");
    await writeFile(outside, "keep\n");
    await rm(exclude, { force: true });
    await symlink(outside, exclude);
    await assert.rejects(ensureSetupRepository(project, ui("unused", false)), /symlinked Git info\/exclude/);
    assert.equal(await readFile(outside, "utf8"), "keep\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an unborn repository with staged files is never committed automatically", async () => {
  const { root, project } = await fixture();
  try {
    await git("git", ["-C", project, "init", "-q"]);
    await writeFile(join(project, "staged.txt"), "preserve staged state\n");
    await git("git", ["-C", project, "add", "staged.txt"]);
    assert.equal(await ensureSetupRepository(project, {
      select: async () => { throw new Error("Repository already exists"); },
      confirm: async () => { throw new Error("Must not auto-commit staged files"); },
      notify() {},
    }), true);
    await assert.rejects(git("git", ["-C", project, "rev-parse", "--verify", "HEAD"]));
    assert.equal((await git("git", ["-C", project, "status", "--porcelain"])).stdout.trim(), "A  staged.txt");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("setup uses the common Git info/exclude when started from a linked worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "peac-linked-worktree-"));
  const main = join(root, "main");
  const linked = join(root, "linked");
  try {
    await mkdir(main);
    await git("git", ["-C", main, "init", "-q"]);
    await git("git", ["-C", main, "config", "user.name", "Setup Fixture"]);
    await git("git", ["-C", main, "config", "user.email", "setup@example.invalid"]);
    await git("git", ["-C", main, "commit", "--allow-empty", "-m", "base"]);
    await git("git", ["-C", main, "worktree", "add", "-b", "linked-test", linked]);
    assert.equal(await ensureSetupRepository(linked, ui("unused", false)), true);
    const common = (await git("git", ["-C", linked, "rev-parse", "--git-common-dir"])).stdout.trim();
    const commonDir = resolve(linked, common);
    assert.match(await readFile(join(commonDir, "info", "exclude"), "utf8"), /\.pi-plan-execute-auto\//);
    assert.equal(await exists(join(linked, ".gitignore")), false);
  } finally {
    await git("git", ["-C", main, "worktree", "remove", "--force", linked]).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("host GIT_DIR/GIT_WORK_TREE variables cannot redirect setup", async () => {
  const { root, project } = await fixture();
  const other = join(root, "other");
  await mkdir(other);
  await git("git", ["-C", other, "init", "-q"]);
  const previousDir = process.env.GIT_DIR;
  const previousTree = process.env.GIT_WORK_TREE;
  try {
    process.env.GIT_DIR = join(other, ".git");
    process.env.GIT_WORK_TREE = other;
    assert.equal(await ensureSetupRepository(project, ui("Cancel", false)), false);
    assert.equal(await exists(join(project, ".git")), false);
  } finally {
    if (previousDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previousDir;
    if (previousTree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = previousTree;
    await rm(root, { recursive: true, force: true });
  }
});

test("a Git parent prevents nested initialization even without a local .git", async () => {
  const { root, project } = await fixture();
  try {
    await git("git", ["-C", root, "init", "-q"]);
    const notes: string[] = [];
    assert.equal(await ensureSetupRepository(project, {
      select: async () => { throw new Error("Must not offer git init in a subdirectory"); },
      confirm: async () => { throw new Error("Must not create a commit"); },
      notify: (message) => { notes.push(message); },
    }), false);
    assert.equal(await exists(join(project, ".git")), false);
    assert.match(notes.join("\n"), /Start Pi from that repository root/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a broken or symlinked .git is never overwritten", async () => {
  const { root, project } = await fixture();
  try {
    await mkdir(join(root, "outside"));
    await symlink(join(root, "outside"), join(project, ".git"));
    await assert.rejects(ensureSetupRepository(project, ui("Initialize Git repository here (no files staged)", true)), /unexpected .git entry/);
    assert.equal((await lstat(join(project, ".git"))).isSymbolicLink(), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
