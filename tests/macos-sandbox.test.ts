import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { test } from "node:test";
import assert from "node:assert/strict";
import { AcpAgent } from "@automatalabs/workflows";
import {
  createSandboxedBackend,
  findMacOSSandboxExec,
  runSandboxedCommand,
  verifySandboxBoundary,
} from "../src/sandbox.js";
import { writeFakeCodexInstall } from "./fixtures/fake-codex.js";

const execFile = promisify(execFileCallback);
const requireMacSandboxTests = process.env.PI_PLAN_EXECUTE_REQUIRE_MACOS_SANDBOX_TESTS === "1";

let macSandboxAvailable = false;
if (process.platform === "darwin") {
  try {
    findMacOSSandboxExec();
    macSandboxAvailable = true;
  } catch {
    macSandboxAvailable = false;
  }
}
if (requireMacSandboxTests && (process.platform !== "darwin" || !macSandboxAvailable)) {
  throw new Error("PI_PLAN_EXECUTE_REQUIRE_MACOS_SANDBOX_TESTS=1 but trusted /usr/bin/sandbox-exec is unavailable on macOS.");
}

async function makeFixture() {
  const root = await mkdtemp(join(dirname(process.cwd()), ".peac-macos-seatbelt-"));
  const sourceRoot = join(root, "source");
  const cwd = join(root, "worktree");
  const goldenRoot = join(sourceRoot, ".pi-plan-execute-auto", "fixture");
  await mkdir(sourceRoot);
  await execFile("git", ["-C", sourceRoot, "init", "-q"]);
  await execFile("git", ["-C", sourceRoot, "config", "user.name", "macOS Sandbox Fixture"]);
  await execFile("git", ["-C", sourceRoot, "config", "user.email", "sandbox@example.invalid"]);
  await writeFile(join(sourceRoot, "package.json"), "{}\n");
  await writeFile(join(sourceRoot, "tracked.txt"), "base\n");
  await execFile("git", ["-C", sourceRoot, "add", "package.json", "tracked.txt"]);
  await execFile("git", ["-C", sourceRoot, "commit", "-qm", "base"]);
  await mkdir(goldenRoot, { recursive: true });
  await writeFile(join(goldenRoot, "plan.md"), "protected golden package\n");
  await execFile("git", ["-C", sourceRoot, "worktree", "add", "-q", "--detach", cwd, "HEAD"]);
  return { root, sourceRoot, cwd, goldenRoot };
}

test("macOS backend uses the trusted Seatbelt launcher instead of bubblewrap", {
  skip: process.platform !== "darwin" || (!requireMacSandboxTests && !macSandboxAvailable)
    ? "macOS sandbox-exec is unavailable"
    : false,
}, async () => {
  const fixture = await makeFixture();
  const originalCodexPath = process.env.CODEX_PATH;
  let sandbox: Awaited<ReturnType<typeof createSandboxedBackend>> | undefined;
  try {
    // A host CODEX_PATH override must never leak into the isolated environment;
    // the plugin resolves a trusted host `codex` from PATH itself and otherwise
    // keeps its package-compatible bundled Codex runtime.
    process.env.CODEX_PATH = "/opt/homebrew/bin/codex-host-version-must-not-leak";
    sandbox = await createSandboxedBackend({
      role: "reviewer",
      model: "codex/gpt-5.6-sol",
      cwd: fixture.cwd,
      sourceRoot: fixture.sourceRoot,
      goldenRoot: fixture.goldenRoot,
    });
    assert.equal(sandbox.config.command, findMacOSSandboxExec());
    const args = sandbox.config.args ?? [];
    assert.equal(args[0], "-f");
    assert.ok(args.includes("/usr/bin/env"));
    const chdirIndex = args.indexOf("-C");
    assert.ok(chdirIndex >= 0, "macOS backend must chdir before starting the ACP process");
    assert.equal(args[chdirIndex + 1], fixture.cwd);
    assert.ok(args.includes("-i"));
    assert.ok(args.some((value) => value.startsWith("HOME=")));
    assert.ok(args.some((value) => value.startsWith("GIT_DIR=")));
    assert.equal(args.some((value) => value.includes("codex-host-version-must-not-leak")), false);
    assert.equal(args.includes("bwrap"), false);
  } finally {
    await sandbox?.cleanup();
    if (originalCodexPath === undefined) delete process.env.CODEX_PATH;
    else process.env.CODEX_PATH = originalCodexPath;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("macOS Codex sessions prefer a trusted host CLI through the Seatbelt profile", {
  skip: process.platform !== "darwin" || (!requireMacSandboxTests && !macSandboxAvailable)
    ? "macOS sandbox-exec is unavailable"
    : false,
}, async () => {
  const fixture = await makeFixture();
  const previousPath = process.env.PATH;
  let sandbox: Awaited<ReturnType<typeof createSandboxedBackend>> | undefined;
  try {
    const install = await writeFakeCodexInstall(join(fixture.root, "install"));
    process.env.PATH = `${install.pathDir}:${previousPath ?? ""}`;
    sandbox = await createSandboxedBackend({
      role: "reviewer",
      model: "codex/gpt-6.1-sol",
      cwd: fixture.cwd,
      sourceRoot: fixture.sourceRoot,
      goldenRoot: fixture.goldenRoot,
    });
    const args = sandbox.config.args ?? [];
    assert.ok(args.includes(`CODEX_PATH=${install.binary}`), "CODEX_PATH must select the host app-server on macOS");
    const profile = await readFile(join(sandbox.scratchPath, "run", "seatbelt.sb"), "utf8");
    assert.ok(
      profile.includes(`(subpath ${JSON.stringify(install.vendorRoot)})`),
      "Seatbelt must be able to read the host Codex vendor tree",
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await sandbox?.cleanup();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("macOS Seatbelt boundary denies Reviewer writes and unrelated host access", {
  skip: process.platform !== "darwin" || (!requireMacSandboxTests && !macSandboxAvailable)
    ? "macOS sandbox-exec is unavailable"
    : false,
}, async () => {
  const fixture = await makeFixture();
  try {
    await verifySandboxBoundary({
      role: "reviewer",
      model: "codex/gpt-5.6-sol",
      cwd: fixture.cwd,
      sourceRoot: fixture.sourceRoot,
      goldenRoot: fixture.goldenRoot,
    });
    await verifySandboxBoundary({
      role: "executor",
      model: "codex/gpt-5.6-sol",
      cwd: fixture.cwd,
      sourceRoot: fixture.sourceRoot,
      goldenRoot: fixture.goldenRoot,
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("macOS acceptance commands can write only the dedicated worktree and private runtime", {
  skip: process.platform !== "darwin" || (!requireMacSandboxTests && !macSandboxAvailable)
    ? "macOS sandbox-exec is unavailable"
    : false,
}, async () => {
  const fixture = await makeFixture();
  const homeMarker = join(homedir(), `.pi-plan-execute-macos-test-${process.pid}`);
  const sourceMarker = join(fixture.sourceRoot, "source-write-escape.txt");
  const goldenMarker = join(fixture.goldenRoot, "golden-write-escape.txt");
  try {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const result = await runSandboxedCommand({
      cwd: fixture.cwd,
      sourceRoot: fixture.sourceRoot,
      goldenRoot: fixture.goldenRoot,
      command: [
        "printf allowed > acceptance-created.txt",
        `printf denied > ${quote(sourceMarker)} 2>/dev/null || true`,
        `printf denied > ${quote(goldenMarker)} 2>/dev/null || true`,
        `printf denied > ${quote(homeMarker)} 2>/dev/null || true`,
      ].join("; "),
      timeout: 20_000,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(join(fixture.cwd, "acceptance-created.txt"), "utf8"), "allowed");
    for (const path of [sourceMarker, goldenMarker, homeMarker]) {
      await assert.rejects(access(path));
    }
  } finally {
    await rm(homeMarker, { force: true });
    await rm(fixture.root, { recursive: true, force: true });
  }
});


test("macOS Seatbelt can launch a real OpenCode ACP session", {
  skip: process.platform !== "darwin" || (!requireMacSandboxTests && !macSandboxAvailable)
    ? "macOS sandbox-exec is unavailable"
    : false,
  timeout: 30_000,
}, async () => {
  const fixture = await makeFixture();
  let sandbox: Awaited<ReturnType<typeof createSandboxedBackend>> | undefined;
  let agent: AcpAgent | undefined;
  try {
    const version = await execFile("opencode", ["--version"], { timeout: 10_000, maxBuffer: 64 * 1024 });
    assert.match(version.stdout.trim(), /^1\.18\./u);

    sandbox = await createSandboxedBackend({
      role: "reviewer",
      model: "opencode/catalog",
      cwd: fixture.cwd,
      sourceRoot: fixture.sourceRoot,
      goldenRoot: fixture.goldenRoot,
    });
    agent = new AcpAgent({
      cwd: fixture.cwd,
      model: "opencode",
      mode: "plan",
      backends: { opencode: sandbox.config },
      permissions: { defaultOutcome: "deny" },
    });
    await agent.ready();
    assert.equal(agent.backendId, "opencode");
  } finally {
    await agent?.close({ keep: true }).catch(() => {});
    await sandbox?.cleanup();
    await rm(fixture.root, { recursive: true, force: true });
  }
});


test("macOS Seatbelt can launch Codex ACP through auth negotiation", {
  skip: process.platform !== "darwin" || (!requireMacSandboxTests && !macSandboxAvailable)
    ? "macOS sandbox-exec is unavailable"
    : false,
  timeout: 30_000,
}, async () => {
  const fixture = await makeFixture();
  let sandbox: Awaited<ReturnType<typeof createSandboxedBackend>> | undefined;
  let agent: AcpAgent | undefined;
  try {
    sandbox = await createSandboxedBackend({
      role: "reviewer",
      model: "codex/catalog",
      cwd: fixture.cwd,
      sourceRoot: fixture.sourceRoot,
      goldenRoot: fixture.goldenRoot,
    });
    agent = new AcpAgent({
      cwd: fixture.cwd,
      model: "codex",
      mode: "read-only",
      backends: { codex: sandbox.config },
      permissions: { defaultOutcome: "deny" },
    });

    let ready = false;
    try {
      await agent.ready();
      ready = true;
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
      assert.equal(
        code,
        "AUTH_REQUIRED",
        `credentialless macOS Codex ACP may stop at auth negotiation, but must not die during startup: ${String(error)}`,
      );
    }

    assert.equal(agent.backendId, "codex");
    if (ready) {
      assert.ok(
        agent.configOptions.some((entry) => entry.id === "model" && entry.type === "select"),
        "Authenticated Codex ACP catalog session should advertise the model config option",
      );
    }
  } finally {
    await agent?.close({ keep: true }).catch(() => {});
    await sandbox?.cleanup();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
