import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatValidationIssues,
  readWorkflowState,
  serializeManifest,
  validatePackageDirectory,
  writeValidatedPackage,
  writeWorkflowState,
} from "../src/package-validator.js";
import type { FinalizeInput, Manifest } from "../src/types.js";
import { createDraftState, freezeRun } from "../src/workflow-state.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-plan-execute-auto-test-"));
}

function validInput(): FinalizeInput {
  const manifest: Manifest = {
    version: 1,
    documents: [
      { id: "implementation", path: "implementation.md", purpose: "implementation overview" },
    ],
    phases: [
      {
        id: "phase-01",
        order: 1,
        spec: "phases/phase-01.md",
        acceptance: "acceptance/phase-01.yaml",
        commit: { required: true, message: "pi-plan-execute-auto: complete phase-01" },
      },
    ],
  };
  return {
    run_id: "validator-test",
    manifest,
    files: [
      { path: "implementation.md", content: "# Implementation\n" },
      { path: "phases/phase-01.md", content: "Implement the test change.\n" },
      {
        path: "acceptance/phase-01.yaml",
        content: [
          "version: 1",
          "phase_id: phase-01",
          "scope:",
          "  allowed_paths:",
          "    - src/**",
          "self_tests:",
          "  - id: unit",
          "    command: node --test",
          "    required: true",
          "review:",
          "  require_no_blocking_findings: true",
          "commit:",
          "  required: true",
          "  allow_empty: false",
          "",
        ].join("\n"),
      },
    ],
  };
}

test("writes and validates a dynamic phased package", async () => {
  const cwd = await tempDir();
  try {
    const result = await writeValidatedPackage(cwd, validInput(), "validator-test");
    assert.equal(result.package.manifest.phases.length, 1);
    assert.equal(result.package.phases[0]?.acceptance.phase_id, "phase-01");
    assert.match(result.package.package_hash, /^[0-9a-f]{64}$/);
    const reread = await validatePackageDirectory(result.package.root);
    assert.equal(reread.ok, true);
    assert.deepEqual(reread.package?.golden_files, [
      "acceptance/phase-01.yaml",
      "implementation.md",
      "manifest.yaml",
      "phases/phase-01.md",
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("requires phases and rejects unsafe references", async () => {
  const cwd = await tempDir();
  try {
    const root = join(cwd, "bad");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "manifest.yaml"),
      serializeManifest({
        version: 1,
        documents: [],
        phases: [
          {
            id: "phase-01",
            order: 2,
            spec: "../phase.md",
            acceptance: "acceptance.yaml",
            commit: { required: true, message: "" },
          },
        ],
      }),
      "utf8",
    );
    await writeFile(join(root, "acceptance.yaml"), "not: a valid contract\n", "utf8");
    const result = await validatePackageDirectory(root);
    assert.equal(result.ok, false);
    const text = formatValidationIssues(result.errors);
    assert.match(text, /PHASE_ORDER_INVALID|PHASE_SPEC_INVALID/);
    assert.match(text, /COMMIT_MESSAGE_INVALID/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("each phase requires a required self-test", async () => {
  const cwd = await tempDir();
  try {
    const input = validInput();
    const file = input.files.find((entry) => entry.path === "acceptance/phase-01.yaml");
    assert.ok(file);
    file.content = file.content.replace("  - id: unit\n    command: node --test\n    required: true\n", "  - id: unit\n    command: node --test\n    required: false\n");
    await assert.rejects(writeValidatedPackage(cwd, input, "missing-required-test"), /Invalid document package/);
    file.content = file.content.replace(/self_tests:\n[\s\S]*?review:/, "self_tests:\nreview:");
    await assert.rejects(writeValidatedPackage(cwd, input, "empty-tests"), /Invalid document package/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("acceptance contract must match its phase and be machine-readable", async () => {
  const cwd = await tempDir();
  try {
    const input = validInput();
    const file = input.files.find((entry) => entry.path === "acceptance/phase-01.yaml");
    assert.ok(file);
    file.content = file.content.replace("phase_id: phase-01", "phase_id: phase-02");
    await assert.rejects(
      writeValidatedPackage(cwd, input, "bad-acceptance"),
      (error: unknown) => {
        assert.match(String(error), /Invalid document package/);
        return true;
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("run-id traversal is rejected before any package path is resolved", async () => {
  const cwd = await tempDir();
  try {
    await assert.rejects(writeValidatedPackage(cwd, validInput(), "../../escaped"), /Invalid run_id/);
    const { packageRoot } = await import("../src/workflow-state.js");
    assert.throws(() => packageRoot(cwd, "../../escaped"), /Invalid run_id/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("freeze rejects a package changed after the displayed review hash", async () => {
  const cwd = await tempDir();
  try {
    const written = await writeValidatedPackage(cwd, validInput(), "freeze-toctou");
    await writeWorkflowState(written.package.root, createDraftState(written.package, "freeze-toctou"));
    await writeFile(join(written.package.root, "phases", "phase-01.md"), "changed after review\n", "utf8");
    await assert.rejects(
      freezeRun(written.package, "freeze-toctou", { reviewedPackageHash: written.package.package_hash }),
      /changed after review|hash changed|invalid/i,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("freeze binds the human-selected ACP models and high effort to the run", async () => {
  const cwd = await tempDir();
  try {
    const written = await writeValidatedPackage(cwd, validInput(), "setup-freeze");
    await writeWorkflowState(written.package.root, createDraftState(written.package, "setup-freeze"));
    const frozen = await freezeRun(written.package, "setup-freeze", {
      reviewedPackageHash: written.package.package_hash,
      executorModel: "opencode/deepseek-local/deepseek-flash",
      reviewerModel: "codex/gpt-6-luna",
      reasoningEffort: "high",
    });
    assert.equal(frozen.status, "frozen");
    assert.equal(frozen.executor_model, "opencode/deepseek-local/deepseek-flash");
    assert.equal(frozen.reviewer_model, "codex/gpt-6-luna");
    assert.equal(frozen.reasoning_effort, "high");
    const persisted = await readWorkflowState(written.package.root);
    assert.equal(persisted?.reasoning_effort, "high");
    assert.equal(persisted?.reviewer_model, "codex/gpt-6-luna");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("low, medium and max ACP effort survive freeze and state reload without silent downgrade", async () => {
  const cwd = await tempDir();
  try {
    for (const reasoningEffort of ["low", "medium", "max"] as const) {
      const runId = `effort-${reasoningEffort}`;
      const written = await writeValidatedPackage(cwd, validInput(), runId);
      await writeWorkflowState(written.package.root, createDraftState(written.package, runId));
      const frozen = await freezeRun(written.package, runId, { reviewedPackageHash: written.package.package_hash, reasoningEffort });
      assert.equal(frozen.reasoning_effort, reasoningEffort);
      assert.equal((await readWorkflowState(written.package.root))?.reasoning_effort, reasoningEffort);
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("per-role efforts remain bound to the frozen run after persistence", async () => {
  const cwd = await tempDir();
  try {
    const written = await writeValidatedPackage(cwd, validInput(), "role-efforts");
    await writeWorkflowState(written.package.root, createDraftState(written.package, "role-efforts"));
    const frozen = await freezeRun(written.package, "role-efforts", {
      reviewedPackageHash: written.package.package_hash,
      executorReasoningEffort: "medium", reviewerReasoningEffort: "high",
    });
    assert.equal(frozen.executor_reasoning_effort, "medium");
    assert.equal(frozen.reviewer_reasoning_effort, "high");
    assert.equal(frozen.reasoning_effort, undefined);
    const persisted = await readWorkflowState(written.package.root);
    assert.equal(persisted?.executor_reasoning_effort, "medium");
    assert.equal(persisted?.reviewer_reasoning_effort, "high");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("runtime state and reports do not change the Golden Docs hash", async () => {
  const cwd = await tempDir();
  try {
    const result = await writeValidatedPackage(cwd, validInput(), "hash-test");
    const before = result.package.package_hash;
    await mkdir(join(result.package.root, ".runtime", "reports"), { recursive: true });
    await writeFile(join(result.package.root, ".state.json"), "{}\n", "utf8");
    await writeFile(join(result.package.root, ".runtime", "reports", "report.json"), "{}\n", "utf8");
    const after = await validatePackageDirectory(result.package.root);
    assert.equal(after.ok, true);
    assert.equal(after.package?.package_hash, before);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
