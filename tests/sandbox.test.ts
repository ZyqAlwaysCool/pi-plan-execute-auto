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

test("Codex catalog staging preserves config but skips live IPC sockets", {
  skip: !requireBubblewrapTests && !bubblewrapAvailable && "trusted system bwrap is unavailable",
}, async () => {
  const root = await mkdtemp(join(dirname(process.cwd()), ".peac-codex-socket-"));
  const previous = process.env.CODEX_HOME;
  const server = createServer();
  let sandbox: Awaited<ReturnType<typeof createSandboxedBackend>> | undefined;
  try {
    const home = join(root, "codex-home");
    await mkdir(join(home, "ipc"), { recursive: true });
    await writeFile(join(home, "config.toml"), "model = 'fixture'\n");
    const socket = join(home, "ipc", "ipc.sock");
    await new Promise<void>((resolve, reject) => server.listen(socket, resolve).once("error", reject));
    process.env.CODEX_HOME = home;
    const cwd = await makeGitWorktree(root);
    const sourceRoot = join(root, "source");
    const goldenRoot = join(sourceRoot, ".pi-plan-execute-auto", "fixture");
    await mkdir(goldenRoot, { recursive: true });
    sandbox = await createSandboxedBackend({ role: "reviewer", model: "codex/gpt-5.6-sol", cwd, sourceRoot, goldenRoot });
    assert.equal(await readFile(join(sandbox.scratchPath, "run", "codex-home", "config.toml"), "utf8"), "model = 'fixture'\n");
    await assert.rejects(access(join(sandbox.scratchPath, "run", "codex-home", "ipc", "ipc.sock")));
  } finally {
    await sandbox?.cleanup();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi ACP preserves native CLI auth state and bootstrap unlinks it before the first turn", {
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
    assert.match(staged, /OTHER-SECRET|unrelated/);
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

    // Native CLI sessions preserve the user's proxy semantics, including an
    // authenticated proxy. Node-backed Claude/Pi additionally enable env-proxy handling.
    const priorHttpsProxy = process.env.HTTPS_PROXY;
    try {
      process.env.HTTPS_PROXY = "http://fixture-user:fixture-pass@127.0.0.1:7890";
      for (const model of ["claude/sonnet", "pi/openai-codex/gpt-5.5", "codex/gpt-5.6-sol"]) {
        const sandbox = await createSandboxedBackend({ ...common, role: "reviewer", model });
        try {
          const args = sandbox.config.args ?? [];
          assert.ok(args.includes("http://fixture-user:fixture-pass@127.0.0.1:7890"));
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
        options: { baseURL: "http://127.0.0.1:8080/v1" },
        models: { "deepseek-flash": { variants: { high: {} } } },
      } },
      plugin: ["fixture-native-plugin"],
    }));
    await writeFile(join(hostData, "opencode", "auth.json"), JSON.stringify({
      "deepseek-local": { type: "api", key: "selected-opencode-secret" },
      "unrelated-provider": { type: "api", key: "OTHER-SECRET" },
    }));
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
      const providerConfig = join(configured.scratchPath, "run", "config", "opencode", "opencode.jsonc");
      const stagedAuth = join(configured.scratchPath, "run", "data", "opencode", "auth.json");
      const stagedProvider = await readFile(providerConfig, "utf8");
      const stagedCredential = await readFile(stagedAuth, "utf8");
      assert.doesNotMatch(stagedProvider, /selected-opencode-secret|OTHER-SECRET/);
      assert.match(stagedProvider, /fixture-native-plugin/);
      assert.match(stagedCredential, /selected-opencode-secret/);
      assert.match(stagedCredential, /OTHER-SECRET|unrelated-provider/);
      await configured.scrubCredentials();
      // Native CLI state lives only in run-private scratch, but remains available
      // for the full CLI session just as it would in a standalone OpenCode session.
      await access(stagedAuth);
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
        assert.equal(network.code, 73, `acceptance could not reach the normal host network: ${network.stderr}`);
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

test("Claude isolated session preserves native CLI routing, auth and tools without host-home mounts", {
  skip: !requireBubblewrapTests && !bubblewrapAvailable && "trusted system bwrap is unavailable",
}, async () => {
  const fixture = await mkdtemp(join(dirname(process.cwd()), ".peac-claude-native-fixture-"));
  const worktree = await makeGitWorktree(fixture, { "package.json": "{}\n" });
  const claudeConfig = join(fixture, "claude-config");
  await mkdir(claudeConfig);
  await writeFile(join(claudeConfig, "settings.json"), JSON.stringify({
    enabledPlugins: { "fixture-plugin@example": true },
    env: { FIXTURE_SETTING: "preserved" },
  }));
  const original = {
    token: process.env.ANTHROPIC_AUTH_TOKEN,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    model: process.env.ANTHROPIC_MODEL,
    sonnet: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    configDir: process.env.CLAUDE_CONFIG_DIR,
    httpsProxy: process.env.HTTPS_PROXY,
    subprocessScrub: process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB,
  };
  let sandbox: Awaited<ReturnType<typeof createSandboxedBackend>> | undefined;
  try {
    process.env.CLAUDE_CONFIG_DIR = claudeConfig;
    process.env.ANTHROPIC_AUTH_TOKEN = "HOST_CLAUDE_NATIVE_TOKEN";
    process.env.ANTHROPIC_BASE_URL = "http://gateway.example.invalid:8080";
    process.env.ANTHROPIC_MODEL = "deepseek-flash[1m]";
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = "deepseek-flash[1m]";
    process.env.HTTPS_PROXY = "http://127.0.0.1:7890";
    delete process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB;
    sandbox = await createSandboxedBackend({
      role: "executor",
      model: "claude/sonnet",
      cwd: worktree,
      sourceRoot: process.cwd(),
      goldenRoot: join(process.cwd(), "docs"),
      includeProviderCredentials: true,
    });
    const args = sandbox.config.args ?? [];
    const routedEnv: Record<string, string> = {};
    for (let index = 0; index < args.length - 2; index += 1) {
      if (args[index] === "--setenv") routedEnv[args[index + 1] ?? ""] = args[index + 2] ?? "";
    }
    assert.equal(routedEnv.ANTHROPIC_AUTH_TOKEN, "HOST_CLAUDE_NATIVE_TOKEN");
    assert.equal(routedEnv.ANTHROPIC_BASE_URL, "http://gateway.example.invalid:8080");
    assert.equal(routedEnv.ANTHROPIC_MODEL, "deepseek-flash[1m]");
    assert.equal(routedEnv.ANTHROPIC_DEFAULT_SONNET_MODEL, "deepseek-flash[1m]");
    assert.equal(routedEnv.HTTPS_PROXY, "http://127.0.0.1:7890");
    assert.equal(routedEnv.CLAUDE_CONFIG_DIR, "/tmp/run/home/.claude");
    assert.notEqual(routedEnv.CLAUDE_CONFIG_DIR, claudeConfig);
    assert.equal(routedEnv.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, undefined);
    assert.equal(sandbox.config.sessionMeta, undefined);
    const stagedSettings = await readFile(join(sandbox.scratchPath, "run", "home", ".claude", "settings.json"), "utf8");
    assert.match(stagedSettings, /fixture-plugin@example/);
    assert.match(stagedSettings, /FIXTURE_SETTING/);
    assert.equal(args.includes("--unshare-net"), false);
  } finally {
    await sandbox?.cleanup();
    if (original.token === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = original.token;
    if (original.baseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = original.baseUrl;
    if (original.model === undefined) delete process.env.ANTHROPIC_MODEL; else process.env.ANTHROPIC_MODEL = original.model;
    if (original.sonnet === undefined) delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL; else process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = original.sonnet;
    if (original.configDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = original.configDir;
    if (original.httpsProxy === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = original.httpsProxy;
    if (original.subprocessScrub === undefined) delete process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB; else process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = original.subprocessScrub;
    await rm(fixture, { recursive: true, force: true });
  }
});

test("OpenCode runtime rejects a PATH binary sourced from the project tree", {
  skip: !requireBubblewrapTests && !bubblewrapAvailable && "trusted system bwrap is unavailable",
}, async () => {
  const fixture = await mkdtemp(join(dirname(process.cwd()), ".peac-opencode-provenance-"));
  const worktree = await makeGitWorktree(fixture, { "bin/opencode": "#!/bin/sh\nexit 0\n" });
  const untrustedDir = join(process.cwd(), ".peac-untrusted-opencode-bin");
  const sourceBin = join(untrustedDir, "opencode");
  const previousPath = process.env.PATH;
  try {
    await mkdir(untrustedDir);
    await writeFile(sourceBin, "#!/bin/sh\nexit 0\n");
    await chmod(sourceBin, 0o755);
    process.env.PATH = `${untrustedDir}:${previousPath ?? "/usr/bin:/bin"}`;
    await assert.rejects(
      createSandboxedBackend({
        role: "executor",
        model: "opencode/opencode/big-pickle",
        cwd: worktree,
        sourceRoot: process.cwd(),
        goldenRoot: join(process.cwd(), "docs"),
      }),
      /External agent binary may not come from the project\/worktree\/Golden roots/,
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await rm(untrustedDir, { recursive: true, force: true });
    await rm(fixture, { recursive: true, force: true });
  }
});

test("OpenCode runtime accepts a current-user-owned 0775 install tree outside protected roots", {
  skip: !requireBubblewrapTests && !bubblewrapAvailable && "trusted system bwrap is unavailable",
}, async () => {
  const fixture = await mkdtemp(join(dirname(process.cwd()), ".peac-opencode-user-install-"));
  const install = join(fixture, "user-install");
  const bin = join(install, "bin");
  const executable = join(bin, "opencode");
  const worktree = await makeGitWorktree(fixture, { "package.json": "{}\n" });
  const previousPath = process.env.PATH;
  let sandbox: Awaited<ReturnType<typeof createSandboxedBackend>> | undefined;
  try {
    await mkdir(bin, { recursive: true, mode: 0o775 });
    await chmod(install, 0o775);
    await chmod(bin, 0o775);
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o755);
    process.env.PATH = `${bin}:${previousPath ?? "/usr/bin:/bin"}`;
    sandbox = await createSandboxedBackend({
      role: "executor",
      model: "opencode/opencode/big-pickle",
      cwd: worktree,
      sourceRoot: process.cwd(),
      goldenRoot: join(process.cwd(), "docs"),
    });
    assert.equal(sandbox.backendId, "opencode");
    const args = sandbox.config.args ?? [];
    const runtimeTarget = args.indexOf("/agent-runtime/opencode");
    assert.ok(runtimeTarget > 0);
    const stagedBinary = args[runtimeTarget - 1] ?? "";
    assert.equal(stagedBinary, join(sandbox.scratchPath, "run", "external", "opencode"));
    assert.equal(args.includes(executable), false);

    // Once staged, later replacement of the original PATH binary cannot change
    // what the run executes.
    await writeFile(executable, "#!/bin/sh\nexit 99\n");
    await chmod(executable, 0o755);
    const executed = await execFile(sandbox.config.command, args, { cwd: worktree });
    assert.equal(executed.stdout, "");
  } finally {
    await sandbox?.cleanup();
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
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
