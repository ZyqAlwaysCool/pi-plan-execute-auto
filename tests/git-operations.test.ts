import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPiGitOperations } from "../src/git.js";

const execFile = promisify(execFileCallback);

// Pi's extension `exec` accumulates `Buffer.toString()` per pipe chunk, which can corrupt a
// UTF-8 code point that straddles a chunk boundary. Phase-commit evidence hashes full diffs, so
// that corruption caused spurious CACHED_DIFF_MISMATCH pauses. Git operations must stay on Node's
// decoding and never route through `pi.exec`.
test("git operations use a UTF-8-safe runner instead of Pi extension exec", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-plan-execute-git-ops-"));
  try {
    const git = (args: string[]) => execFile("git", args, { cwd, maxBuffer: 1024 * 1024 });
    await git(["init", "-q"]);
    await git(["config", "user.email", "test@example.invalid"]);
    await git(["config", "user.name", "Git Ops Test"]);
    await writeFile(join(cwd, "a.txt"), "base\n", "utf8");
    await git(["add", "a.txt"]);
    await git(["commit", "-qm", "base"]);

    // Larger than one pipe chunk and full of multi-byte characters.
    const multibyte = "生成固定步长运行时骨架与确定性随机数生成器\n".repeat(4_000);
    await writeFile(join(cwd, "a.txt"), multibyte, "utf8");

    const args = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--binary", "HEAD", "--", "a.txt"];
    const piStub = {
      async exec(): Promise<never> {
        throw new Error("pi.exec must not run git operations");
      },
    };
    const viaFactory = await createPiGitOperations(piStub, cwd).run(args);
    assert.equal(viaFactory.code, 0);
    const expected = (await execFile("git", args, { cwd, maxBuffer: 128 * 1024 * 1024 })).stdout;
    assert.equal(viaFactory.stdout, expected);
    assert.ok(!viaFactory.stdout.includes("\uFFFD"), "diff output must not contain replacement characters");
    assert.ok(viaFactory.stdout.includes("确定性随机数生成器"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
