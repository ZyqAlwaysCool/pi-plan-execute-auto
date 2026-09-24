import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AcceptanceContract, AcceptanceResult, PhaseCompletionRecord } from "./types.js";
import { blockingFindings, normalizeExecutionReport, normalizeReviewReport } from "./reports.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40,64}$/i;
const RUNTIME_ROOT = ".runtime";

export function phaseReportRelativePath(phaseId: string, round: number, kind: "execution" | "review" | "acceptance"): string {
  return `${RUNTIME_ROOT}/reports/${phaseId}-round-${String(round).padStart(2, "0")}-${kind}.json`;
}

export function completionRecordRelativePath(phaseId: string): string {
  return `${RUNTIME_ROOT}/completions/${phaseId}.json`;
}

export function finalDiffRelativePath(phaseId: string): string {
  return `${RUNTIME_ROOT}/completions/${phaseId}.diff`;
}

export function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAcceptanceResult(value: unknown): value is AcceptanceResult {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.command === "string" &&
    typeof value.required === "boolean" &&
    (typeof value.exit_code === "number" || value.exit_code === null) &&
    typeof value.passed === "boolean" &&
    typeof value.stdout === "string" &&
    typeof value.stderr === "string"
  );
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isExpectedRuntimePath(value: unknown, expected: string): value is string {
  if (typeof value !== "string" || value !== expected || value.includes("\\") || value.startsWith("/")) return false;
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

async function readRuntimeFile(root: string, relative: string): Promise<Buffer> {
  if (!isExpectedRuntimePath(relative, relative)) throw new Error(`Unsafe runtime evidence path: ${relative}`);
  const absoluteRoot = resolve(root);
  const absolute = resolve(root, ...relative.split("/"));
  if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}/`)) {
    throw new Error(`Runtime evidence path escapes package root: ${relative}`);
  }
  return readFile(join(root, ...relative.split("/")));
}

export interface ValidatedCompletionEvidence {
  record: PhaseCompletionRecord;
  recordText: string;
  recordSha256: string;
}

/** Validate every completion field and every referenced evidence byte, not only identity fields. */
export async function validatePhaseCompletionRecord(
  root: string,
  phaseId: string,
  packageHash: string,
  expectedState?: {
    base_commit_sha?: string;
    phase_commit_sha?: string;
    completion_record_sha256?: string;
    reviewed_diff_sha256?: string;
  },
  expectedAcceptance?: AcceptanceContract,
): Promise<ValidatedCompletionEvidence> {
  const recordPath = completionRecordRelativePath(phaseId);
  const recordBytes = await readRuntimeFile(root, recordPath);
  const recordText = recordBytes.toString("utf8");
  const value: unknown = JSON.parse(recordText);
  if (!isRecord(value)) throw new Error(`Completion record is not an object: ${recordPath}`);

  const record = value as Partial<PhaseCompletionRecord>;
  if (
    record.version !== 1 ||
    record.phase_id !== phaseId ||
    record.package_hash !== packageHash ||
    typeof record.base_commit_sha !== "string" ||
    !COMMIT_PATTERN.test(record.base_commit_sha) ||
    typeof record.phase_commit_sha !== "string" ||
    !COMMIT_PATTERN.test(record.phase_commit_sha) ||
    typeof record.committed_at !== "string" ||
    !Number.isFinite(Date.parse(record.committed_at)) ||
    typeof record.review_rounds !== "number" ||
    !Number.isInteger(record.review_rounds) ||
    record.review_rounds < 1 ||
    !Array.isArray(record.acceptance_results) ||
    record.acceptance_results.length === 0 ||
    record.acceptance_results.some((entry) => !isAcceptanceResult(entry)) ||
    typeof record.execution_report_sha256 !== "string" ||
    !SHA256_PATTERN.test(record.execution_report_sha256) ||
    typeof record.review_report_sha256 !== "string" ||
    !SHA256_PATTERN.test(record.review_report_sha256) ||
    typeof record.acceptance_report_sha256 !== "string" ||
    !SHA256_PATTERN.test(record.acceptance_report_sha256) ||
    typeof record.final_diff_sha256 !== "string" ||
    !SHA256_PATTERN.test(record.final_diff_sha256) ||
    typeof record.reviewed_diff_sha256 !== "string" ||
    !SHA256_PATTERN.test(record.reviewed_diff_sha256)
  ) {
    throw new Error(`Completion record has incomplete or invalid fields: ${recordPath}`);
  }

  const expectedExecution = phaseReportRelativePath(phaseId, record.review_rounds, "execution");
  const expectedReview = phaseReportRelativePath(phaseId, record.review_rounds, "review");
  const expectedAcceptancePath = phaseReportRelativePath(phaseId, record.review_rounds, "acceptance");
  const expectedDiff = finalDiffRelativePath(phaseId);
  if (
    !isExpectedRuntimePath(record.execution_report_path, expectedExecution) ||
    !isExpectedRuntimePath(record.review_report_path, expectedReview) ||
    !isExpectedRuntimePath(record.acceptance_report_path, expectedAcceptancePath) ||
    !isExpectedRuntimePath(record.final_diff_path, expectedDiff)
  ) {
    throw new Error(`Completion record references non-canonical runtime evidence paths: ${recordPath}`);
  }

  const executionBytes = await readRuntimeFile(root, record.execution_report_path);
  const reviewBytes = await readRuntimeFile(root, record.review_report_path);
  const acceptanceBytes = await readRuntimeFile(root, record.acceptance_report_path);
  const diffBytes = await readRuntimeFile(root, record.final_diff_path);
  if (
    sha256Bytes(executionBytes) !== record.execution_report_sha256 ||
    sha256Bytes(reviewBytes) !== record.review_report_sha256 ||
    sha256Bytes(acceptanceBytes) !== record.acceptance_report_sha256 ||
    sha256Bytes(diffBytes) !== record.final_diff_sha256 ||
    record.reviewed_diff_sha256 !== record.final_diff_sha256
  ) {
    throw new Error(`Completion evidence hash mismatch: ${recordPath}`);
  }

  const execution = JSON.parse(executionBytes.toString("utf8")) as unknown;
  const review = JSON.parse(reviewBytes.toString("utf8")) as unknown;
  const acceptance = JSON.parse(acceptanceBytes.toString("utf8")) as unknown;
  const normalizedExecution = normalizeExecutionReport(execution, {
    phase_id: phaseId,
    round: record.review_rounds,
    base_commit: record.base_commit_sha,
  });
  const normalizedReview = normalizeReviewReport(review, {
    phase_id: phaseId,
    round: record.review_rounds,
    base_commit: record.base_commit_sha,
  });
  if (
    !normalizedExecution.report || normalizedExecution.report.status !== "complete" ||
    !normalizedReview.report || normalizedReview.report.verdict !== "PASS" ||
    blockingFindings(normalizedReview.report).length > 0 || normalizedReview.report.out_of_scope_changes.length > 0 ||
    !Array.isArray(acceptance) || !jsonEqual(acceptance, record.acceptance_results) ||
    record.acceptance_results.some((result) => result.required && (!result.passed || result.exit_code !== 0))
  ) {
    throw new Error(`Completion evidence identity/content mismatch: ${recordPath}`);
  }

  if (expectedAcceptance) {
    const acceptanceResults = record.acceptance_results as AcceptanceResult[];
    if (acceptanceResults.length !== expectedAcceptance.self_tests.length) {
      throw new Error(`Acceptance evidence does not exactly match the frozen contract: ${recordPath}`);
    }
    expectedAcceptance.self_tests.forEach((expected, index) => {
      const actual = acceptanceResults[index];
      if (!actual || actual.id !== expected.id || actual.command !== expected.command || actual.required !== expected.required) {
        throw new Error(`Acceptance evidence identity does not match the frozen contract: ${expected.id}`);
      }
      if (expected.required && (!actual.passed || actual.exit_code !== 0)) {
        throw new Error(`Required acceptance evidence is missing or failed: ${expected.id}`);
      }
    });
  }

  const recordSha256 = sha256Bytes(recordBytes);
  if (expectedState?.base_commit_sha && expectedState.base_commit_sha !== record.base_commit_sha) {
    throw new Error(`Completion base SHA does not match workflow state: ${recordPath}`);
  }
  if (expectedState?.phase_commit_sha && expectedState.phase_commit_sha !== record.phase_commit_sha) {
    throw new Error(`Completion commit SHA does not match workflow state: ${recordPath}`);
  }
  if (expectedState?.completion_record_sha256 && expectedState.completion_record_sha256 !== recordSha256) {
    throw new Error(`Completion record hash does not match workflow state: ${recordPath}`);
  }
  if (expectedState?.reviewed_diff_sha256 && expectedState.reviewed_diff_sha256 !== record.reviewed_diff_sha256) {
    throw new Error(`Reviewed diff hash does not match workflow state: ${recordPath}`);
  }
  return { record: record as PhaseCompletionRecord, recordText, recordSha256 };
}
