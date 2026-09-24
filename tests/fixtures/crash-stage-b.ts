// Subprocess fixture: only a real SIGKILL preserves the exact on-disk crash window.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validatePackageDirectory, readWorkflowState, writeWorkflowState } from "../../src/package-validator.js";
import { createLocalGitOperations, GitWorkspace } from "../../src/git.js";
import { StageBController } from "../../src/stage-b.js";
import type { HarnessPair, WorkflowState } from "../../src/types.js";

const [sourceCwd, cwd, runId, crashPhase, crashWindow = "none"] = process.argv.slice(2);
if (!sourceCwd || !cwd || !runId || !crashPhase) throw new Error("crash-stage-b fixture requires source, worktree, runId, phase, and window");
const root = join(sourceCwd, ".pi-plan-execute-auto", runId);
const validation = await validatePackageDirectory(root);
if (!validation.package) throw new Error("Invalid fixture package");
const state = await readWorkflowState(root);
if (!state) throw new Error("Missing fixture state");
const kill = () => { process.kill(process.pid, "SIGKILL"); throw new Error("SIGKILL did not terminate fixture"); };
class CrashWorkspace extends GitWorkspace {
  override async commitPhase(...args: Parameters<GitWorkspace["commitPhase"]>): Promise<string> {
    const sha = await super.commitPhase(...args);
    if (crashWindow === "after-commit" && args[2]?.includes(crashPhase!)) kill();
    return sha;
  }
}
const harness: HarnessPair = {
  async execute(prompt, round) {
    const phaseId = /phase_id: (phase-\d+)/.exec(prompt)?.[1];
    const baseCommit = /phase_base_commit: ([0-9a-f]+)/.exec(prompt)?.[1];
    if (!phaseId || !baseCommit) throw new Error("Missing phase identity");
    await writeFile(join(cwd, "src", `${phaseId}.txt`), `${phaseId}\n`);
    return {
      phase_id: phaseId, round, base_commit: baseCommit, status: "complete" as const,
      summary: "done", changed_files: [`src/${phaseId}.txt`],
      self_tests: [{ id: "unit", command: "true", status: "passed" as const }],
      resolved_findings: [], known_issues: [],
    };
  },
  async rework() { throw new Error("Unexpected rework after restart"); },
  async review(prompt, round) {
    const phaseId = /phase_id: (phase-\d+)/.exec(prompt)?.[1];
    const baseCommit = /phase_base_commit: ([0-9a-f]+)/.exec(prompt)?.[1];
    if (!phaseId || !baseCommit) throw new Error("Missing review identity");
    return {
      phase_id: phaseId, round, base_commit: baseCommit, verdict: "PASS" as const,
      summary: "checked", findings: [], evidence: ["read source"],
      acceptance_assessment: "pass", out_of_scope_changes: [],
    };
  },
  async close() {},
};
const result = await new StageBController({
  package: validation.package,
  state,
  git: new CrashWorkspace(createLocalGitOperations(cwd), { cwd, runtimeRoot: `.pi-plan-execute-auto/${runId}` }),
  acceptanceRunner: { run: async () => ({ stdout: "", stderr: "", code: 0 }) },
  harness,
  requireDedicatedWorktree: false,
  saveState: async (next: WorkflowState) => {
    const target = next.phases.find((phase) => phase.phase_id === crashPhase);
    const hit = target?.status === "completed" && target.phase_commit_sha;
    if (hit && crashWindow === "after-record") kill();
    await writeWorkflowState(root, next);
    if (hit && crashWindow === "after-save") kill();
  },
}).run();
console.log(JSON.stringify({ status: result.status, reason: result.status === "paused" ? result.reason : undefined }));
