import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { AcpAgent } from "@automatalabs/workflows";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSandboxedBackend, findBubblewrap, prepareReadOnlyGitMirror, runSandboxedCommand, stageSelectedOpenCodeProviderConfig, validateBubblewrapBinary, verifySandboxBoundary } from "../src/sandbox.js";

const execFile = promisify(execFileCallback);
const requireBubblewrapTests = process.env.PI_PLAN_EXECUTE_REQUIRE_BWRAP_TESTS === "1";

async function makeGitWorktree(root: string, files: Record<string, string> = {}): Promise<string> {
  const source = join(root, "source");
  const worktree = join(root, "worktree");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "history.txt"), "parent\n", "utf8");
  for (const [path, content] of Object.entries(files)) {
    const target = join(source, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  await execFile("git", ["init", "--quiet", source]);
  await execFile("git", ["-C", source, "config", "user.name", "Sandbox Test"]);
  await execFile("git", ["-C", source, "config", "user.email", "sandbox@example.invalid"]);
  await execFile("git", ["-C", source, "add", "-A"]);
  await execFile("git", ["-C", source, "commit", "--quiet", "-m", "parent"]);
  await writeFile(join(source, "history.txt"), "base\n", "utf8");
  await execFile("git", ["-C", source, "add", "history.txt"]);
  await execFile("git", ["-C", source, "commit", "--quiet", "-m", "base"]);
  await execFile("git", ["-C", source, "worktree", "add", "--detach", worktree, "HEAD"]);
  return worktree;
}

test("read-only Git metadata mirror supports baseline diff without shared history", async () => {
  const fixture = await mkdtemp(join(dirname(process.cwd()), ".peac-git-mirror-test-"));
  const worktree = await makeGitWorktree(fixture, { "src/value.ts": "export const value = 1;\n" });
  const scratch = await mkdtemp(join(tmpdir(), "peac-git-mirror-scratch-"));
  try {
    await mkdir(join(scratch, "run", "home"), { recursive: true });
    await writeFile(join(worktree, "src/value.ts"), "export const value = 2;\n", "utf8");
    const head = (await execFile("git", ["-C", worktree, "rev-parse", "HEAD"])).stdout.trim();
    await prepareReadOnlyGitMirror(worktree, scratch);
    const mirror = join(scratch, "run", "git-mirror");
    const gitPointer = join(worktree, ".git");
    const originalPointer = await readFile(gitPointer);
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" };
    try {
      await writeFile(gitPointer, `gitdir: ${mirror}\n`, "utf8");
      const status = await execFile("git", ["-C", worktree, "status", "--short"], { cwd: worktree, env });
      assert.match(status.stdout, /src\/value\.ts/);
      const diff = await execFile("git", ["-C", worktree, "diff", head], { cwd: worktree, env });
      assert.match(diff.stdout, /src\/value\.ts/);
      const log = await execFile("git", ["-C", worktree, "log", "--oneline"], { cwd: worktree, env });
      assert.equal(log.stdout.trim().split("\n").length, 1);
      await assert.rejects(execFile("git", ["-C", worktree, "cat-file", "-e", "HEAD^"], { cwd: worktree, env }));
    } finally {
      await writeFile(gitPointer, originalPointer);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});

test("OpenCode stages only the selected provider/model, not unrelated config or credentials", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "peac-opencode-config-"));
  const configRoot = join(fixture, "host-config");
  const scratch = join(fixture, "scratch");
  try {
    await mkdir(join(configRoot, "opencode"), { recursive: true });
    await mkdir(scratch);
    await writeFile(join(configRoot, "opencode", "opencode.jsonc"), [
      "{ // ordinary JSONC comments are supported",
      "  \"provider\": {",
      "    \"deepseek-local\": {",
      "      \"npm\": \"@ai-sdk/openai-compatible\", \"name\": \"Fixture\",",
      "      \"options\": { \"baseURL\": \"http://127.0.0.1:8080/v1\", \"apiKey\": \"selected-test-key\" },",
      "      \"models\": { \"deepseek-flash\": { \"variants\": { \"high\": {} } }, \"other\": {} },",
      "    },",
      "    \"unrelated\": { \"npm\": \"unrelated\", \"options\": { \"apiKey\": \"OTHER-SECRET\" } },",
      "  },",
      "  \"plugin\": [\"HOST-PLUGIN-SECRET\"],",
      "  \"model\": \"unrelated/other\"",
      "}",
    ].join("\n"));
    const target = await stageSelectedOpenCodeProviderConfig("opencode/deepseek-local/deepseek-flash", scratch, configRoot);
    assert.ok(target);
    const text = await readFile(target, "utf8");
    const staged = JSON.parse(text) as { provider: Record<string, { models: Record<string, unknown> }> };
    assert.deepEqual(Object.keys(staged.provider), ["deepseek-local"]);
    assert.deepEqual(Object.keys(staged.provider["deepseek-local"]?.models ?? {}), ["deepseek-flash"]);
    assert.match(text, /selected-test-key/);
    assert.doesNotMatch(text, /OTHER-SECRET|HOST-PLUGIN-SECRET|unrelated|\"other\"/);
    await assert.rejects(
      stageSelectedOpenCodeProviderConfig("opencode/deepseek-local/missing", join(fixture, "unused"), configRoot),
      /no definition for model/,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

let bubblewrapAvailable = true;
try {
  findBubblewrap();
} catch {
  bubblewrapAvailable = false;
}
if (requireBubblewrapTests && !bubblewrapAvailable) {
  throw new Error("PI_PLAN_EXECUTE_REQUIRE_BWRAP_TESTS=1 but no trusted system bwrap is available.");
}

test("ACP backend command uses minimal mounts and a scrubbed environment", {
  skip: !requireBubblewrapTests && !bubblewrapAvailable && "trusted system bwrap is unavailable",
}, async () => {
  const fixture = await mkdtemp(join(dirname(process.cwd()), ".peac-sandbox-config-"));
  const cwd = await makeGitWorktree(fixture, { "package.json": "{}\n" });
  try {
    const sandbox = await createSandboxedBackend({
      role: "reviewer",
      model: "codex/gpt-5.6-sol",
      cwd,
      sourceRoot: process.cwd(),
      goldenRoot: join(process.cwd(), "docs"),
    });
    try {
      assert.equal(sandbox.backendId, "codex");
      assert.equal(sandbox.config.command, findBubblewrap());
      assert.ok(sandbox.config.args?.includes("--ro-bind"));
      assert.ok(sandbox.config.args?.includes("--bind"));
      assert.ok(sandbox.config.args?.includes("/tmp"));
      assert.ok(sandbox.config.args?.includes("--clearenv"));
      assert.ok(sandbox.config.args?.includes("--tmpfs"));
      const args = sandbox.config.args ?? [];
      assert.equal(args.some((value, index) => value === "--remount-ro" && args[index + 1] === "/"), true);
      assert.equal(args.some((value, index) => value === "--ro-bind" && args[index + 1] === "/" && args[index + 2] === "/"), false);
    } finally {
      await sandbox.cleanup();
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("Pi ACP stages only the selected provider and unlinks auth before its first turn", {
  skip: !requireBubblewrapTests && !bubblewrapAvailable && "trusted bwrap is required for the Pi bootstrap",
}, async () => {
  const root = await mkdtemp(join(dirname(process.cwd()), ".peac-pi-auth-fixture-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  let sandbox: Awaited<ReturnType<typeof createSandboxedBackend>> | undefined;
  let agent: AcpAgent | undefined;
  try {
    const authDir = join(root, "host-pi-agent");
    await mkdir(authDir);
    await writeFile(join(authDir, "auth.json"), JSON.stringify({
      "openai-codex": { type: "oauth", access: "selected-test-token", refresh: "test-refresh", expires: Date.now() + 3_600_000 },
      "unrelated": { type: "api_key", key: "OTHER-SECRET" },
    }));
    process.env.PI_CODING_AGENT_DIR = authDir;
    const cwd = await makeGitWorktree(root);
    const sourceRoot = join(root, "source");
    const goldenRoot = join(sourceRoot, ".pi-plan-execute-auto", "fixture");
    await mkdir(goldenRoot, { recursive: true });
    sandbox = await createSandboxedBackend({ role: "reviewer", model: "pi/openai-codex/gpt-5.5", cwd, sourceRoot, goldenRoot, includeProviderCredentials: true });
    const target = join(sandbox.scratchPath, "run", "home", ".pi", "agent", "auth.json");
    const staged = await readFile(target, "utf8");
    assert.match(staged, /selected-test-token/);
    assert.doesNotMatch(staged, /OTHER-SECRET|unrelated/);
    assert.ok(sandbox.config.args?.includes("/agent-runtime/pi-acp-bootstrap.mjs"));
    agent = new AcpAgent({ cwd, model: "pi/openai-codex/gpt-5.5", backends: { pi: sandbox.config }, permissions: { defaultOutcome: "deny" } });
    await agent.ready();
    await assert.rejects(access(target));
    assert.equal(agent.backendId, "pi");
  } finally {
    await agent?.close({ keep: true }).catch(() => undefined);
    await sandbox?.cleanup();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("bubblewrap denies Reviewer writes and grants Executor writes only in its worktree", {
  skip: !requireBubblewrapTests && !bubblewrapAvailable && "bwrap is not installed; sandbox integration probe requires it",
}, async () => {
  const fixture = await mkdtemp(join(dirname(process.cwd()), ".peac-sandbox-probe-"));
  const worktree = await makeGitWorktree(fixture, {
    "package.json": "{}\n",
    "node_modules/dependency.js": "const value = 1;\n",
  });
  const common = {
    cwd: worktree,
    sourceRoot: process.cwd(),
    goldenRoot: join(process.cwd(), "docs"),
  };
  try {
    // Filesystem-only OpenCode probe needs a mountable executable, but never
    // launches it. Live-provider tests separately require the real backend.
    const testBin = join(fixture, "probe-bin");
    await mkdir(testBin);
    await writeFile(join(testBin, "opencode"), "#!/bin/sh\nexit 0\n");
    await chmod(join(testBin, "opencode"), 0o755);
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = `${testBin}:${originalPath ?? "/usr/bin:/bin"}`;
      for (const model of ["claude/sonnet", "codex/gpt-5.6-sol", "opencode/opencode/big-pickle", "pi/openai-codex/gpt-5.5"]) {
        await verifySandboxBoundary({ role: "executor", model, ...common });
        await verifySandboxBoundary({ role: "reviewer", model, ...common });
      }
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }

    // Node-backed Claude/Pi must use the already-vetted credential-free proxy;
    // Node's fetch otherwise ignores HTTP(S)_PROXY and live turns fail after ready().
    const priorHttpsProxy = process.env.HTTPS_PROXY;
    try {
      process.env.HTTPS_PROXY = "http://127.0.0.1:7890";
      for (const model of ["claude/sonnet", "pi/openai-codex/gpt-5.5", "codex/gpt-5.6-sol"]) {
        const sandbox = await createSandboxedBackend({ ...common, role: "reviewer", model });
        try {
          const args = sandbox.config.args ?? [];
          const proxyFlag = args.findIndex((value, index) => value === "NODE_USE_ENV_PROXY" && args[index + 1] === "1");
          assert.equal(proxyFlag !== -1, model.startsWith("claude/") || model.startsWith("pi/"));
        } finally { await sandbox.cleanup(); }
      }
    } finally {
      if (priorHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = priorHttpsProxy;
    }

    // Exercise Git *inside* the actual read-only Reviewer mount, not merely a
    // host-side mirror with a rewritten .git pointer.
    await writeFile(join(worktree, "history.txt"), "reviewed\n");
    const reviewer = await createSandboxedBackend({ role: "reviewer", model: "codex/gpt-5.6-sol", ...common });
    try {
      const args = reviewer.config.args ?? [];
      const separator = args.lastIndexOf("--");
      assert.ok(separator > 0);
      const prefix = args.slice(0, separator);
      const diff = await execFile(reviewer.config.command, [...prefix, "--", "/usr/bin/git", "diff", "HEAD", "--", "history.txt"]);
      assert.match(diff.stdout, /\+reviewed/);
      await assert.rejects(execFile(reviewer.config.command, [...prefix, "--", "/usr/bin/git", "add", "--", "history.txt"]));
      assert.equal((await execFile("git", ["-C", worktree, "diff", "--cached", "--name-only"])).stdout.trim(), "");
    } finally {
      await reviewer.cleanup();
    }

    const hostConfig = join(fixture, "host-config");
    const hostData = join(fixture, "host-data");
    await mkdir(join(hostConfig, "opencode"), { recursive: true });
    await mkdir(join(hostData, "opencode"), { recursive: true });
    await writeFile(join(hostConfig, "opencode", "opencode.jsonc"), JSON.stringify({
      provider: { "deepseek-local": {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://127.0.0.1:8080/v1", apiKey: "temporary-provider-key" },
        models: { "deepseek-flash": { variants: { high: {} } } },
      } },
    }));
    await writeFile(join(hostData, "opencode", "auth.json"), "{}\n");
    const savedEnv = {
      PATH: process.env.PATH,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    };
    let configured: Awaited<ReturnType<typeof createSandboxedBackend>> | undefined;
    try {
      process.env.PATH = `${testBin}:${savedEnv.PATH ?? "/usr/bin:/bin"}`;
      process.env.XDG_CONFIG_HOME = hostConfig;
      process.env.XDG_DATA_HOME = hostData;
      configured = await createSandboxedBackend({
        ...common, role: "executor", model: "opencode/deepseek-local/deepseek-flash",
        includeProviderCredentials: true,
      });
      const providerConfig = join(configured.scratchPath, "run", "config", "opencode", "opencode.json");
      const stagedAuth = join(configured.scratchPath, "run", "data", "opencode", "auth.json");
      assert.match(await readFile(providerConfig, "utf8"), /temporary-provider-key/);
      await access(stagedAuth);
      await configured.scrubCredentials();
      await assert.rejects(access(providerConfig));
      await assert.rejects(access(stagedAuth));
    } finally {
      await configured?.cleanup();
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    const nonce = randomUUID();
    const sourceMarker = join(process.cwd(), `.peac-acceptance-source-${nonce}`);
    const siblingMarker = join(fixture, `.peac-acceptance-sibling-${nonce}`);
    const goldenMarker = join(common.goldenRoot, `.peac-acceptance-golden-${nonce}`);
    const tmpMarker = join(tmpdir(), `.peac-acceptance-tmp-${nonce}`);
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const command = [sourceMarker, siblingMarker, goldenMarker, tmpMarker]
      .map((path) => `printf unreviewed > ${quote(path)} 2>/dev/null || true`)
      .join("; ");
    try {
      const result = await runSandboxedCommand({
        ...common,
        command,
        timeout: 20_000,
      });
      assert.equal(result.code, 0, result.stderr);
      for (const marker of [sourceMarker, siblingMarker, goldenMarker, tmpMarker]) {
        await assert.rejects(access(marker));
      }
      const server = createServer((socket) => socket.end());
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const network = await runSandboxedCommand({
          ...common,
          command: `node -e 'const s=require("node:net").connect(${address.port},"127.0.0.1"); s.on("connect",()=>process.exit(73)); s.on("error",()=>process.exit(0)); setTimeout(()=>process.exit(74),2000)'`,
          timeout: 20_000,
        });
        assert.equal(network.code, 0, `acceptance reached the host network or could not run node: ${network.stderr}`);
      } finally {
        server.close();
      }
    } finally {
      await Promise.all([sourceMarker, siblingMarker, goldenMarker, tmpMarker].map((path) => rm(path, { force: true })));
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("an executable fake bwrap cannot pass provenance validation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "peac-fake-bwrap-"));
  const fake = join(directory, "bwrap");
  try {
    await writeFile(fake, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(fake, 0o755);
    assert.throws(() => validateBubblewrapBinary(fake), /Refusing untrusted bubblewrap/);
    assert.throws(() => validateBubblewrapBinary("/usr/bin/true"), /Refusing untrusted bubblewrap/);
    const previous = process.env.PI_PLAN_EXECUTE_BWRAP;
    process.env.PI_PLAN_EXECUTE_BWRAP = fake;
    try {
      assert.throws(() => findBubblewrap(), /Refusing untrusted bubblewrap/);
    } finally {
      if (previous === undefined) delete process.env.PI_PLAN_EXECUTE_BWRAP;
      else process.env.PI_PLAN_EXECUTE_BWRAP = previous;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sandbox rejects host-wide worktree and Golden roots before requiring bwrap", async () => {
  const cwd = await mkdtemp(join(dirname(process.cwd()), ".peac-sandbox-root-policy-"));
  try {
    await assert.rejects(
      createSandboxedBackend({ role: "reviewer", model: "codex/model", cwd, sourceRoot: process.cwd(), goldenRoot: "/etc" }),
      /broad host root/,
    );
    await assert.rejects(
      createSandboxedBackend({ role: "reviewer", model: "codex/model", cwd: homedir(), sourceRoot: process.cwd(), goldenRoot: join(process.cwd(), "docs") }),
      /physically separate/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Executor sandbox refuses an overlapping worktree and protected source root", async () => {
  await assert.rejects(
    createSandboxedBackend({
      role: "executor",
      model: "codex/gpt-5.6-sol",
      cwd: process.cwd(),
      sourceRoot: process.cwd(),
      goldenRoot: join(process.cwd(), "docs"),
    }),
    /physically separate/,
  );
});

test("sandbox cannot be disabled with an unsupported model route", async () => {
  await assert.rejects(
    createSandboxedBackend({
      role: "reviewer",
      model: "arbitrary-backend/model",
      cwd: process.cwd(),
      sourceRoot: process.cwd(),
      goldenRoot: join(process.cwd(), "docs"),
    }),
    /not allowlisted/,
  );
});
