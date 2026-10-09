import type {
  AcceptanceContract,
  ExecutionReport,
  ExecutionSelfTestEvidence,
  ReviewFinding,
  ReviewReport,
} from "./types.js";

export const MAX_REPORT_BYTES = 512 * 1024;
export const MAX_REPORT_LIST_ITEMS = 512;
export const MAX_FINDINGS = 256;
export const MAX_FINDING_ID_LENGTH = 256;
export const MAX_REPORT_STRING_LENGTH = 128 * 1024;

export function reportWithinLimit(value: unknown): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value)) <= MAX_REPORT_BYTES;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, maxLength = MAX_REPORT_STRING_LENGTH): string | undefined {
  return typeof value === "string" && value.length <= maxLength ? value : undefined;
}

function stringArray(value: unknown, maxItems = MAX_REPORT_LIST_ITEMS): string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length > maxItems ||
    value.some((entry) => typeof entry !== "string" || entry.length > MAX_REPORT_STRING_LENGTH)
  ) return undefined;
  return value as string[];
}

function normalizeSelfTests(value: unknown): ExecutionSelfTestEvidence[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_REPORT_LIST_ITEMS) return undefined;
  const result: ExecutionSelfTestEvidence[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" || entry.id.length > MAX_FINDING_ID_LENGTH ||
      typeof entry.command !== "string" || entry.command.length > MAX_REPORT_STRING_LENGTH
    ) return undefined;
    if (entry.status !== "passed" && entry.status !== "failed" && entry.status !== "skipped") return undefined;
    const evidence: ExecutionSelfTestEvidence = {
      id: entry.id,
      command: entry.command,
      status: entry.status,
    };
    if (typeof entry.output === "string") evidence.output = entry.output;
    result.push(evidence);
  }
  return result;
}

export function normalizeExecutionReport(
  value: unknown,
  expected: { phase_id: string; round: number; base_commit: string },
): { report?: ExecutionReport; error?: string } {
  if (!reportWithinLimit(value)) return { error: "executor report exceeds the maximum evidence size" };
  if (!isRecord(value)) return { error: "executor report is not an object" };
  if (value.phase_id !== expected.phase_id) return { error: "executor report phase_id does not match current phase" };
  if (value.round !== expected.round) return { error: "executor report round does not match current round" };
  if (value.base_commit !== expected.base_commit) return { error: "executor report base_commit does not match phase base" };
  if (value.status !== "complete" && value.status !== "blocked" && value.status !== "failed") {
    return { error: "executor report status must be complete, blocked, or failed" };
  }
  const summary = stringValue(value.summary);
  const changedFiles = stringArray(value.changed_files);
  const selfTests = normalizeSelfTests(value.self_tests);
  const resolvedFindings = stringArray(value.resolved_findings);
  const knownIssues = stringArray(value.known_issues);
  if (!summary || !changedFiles || !selfTests || !resolvedFindings || !knownIssues) {
    return { error: "executor report is missing a required field" };
  }
  const report: ExecutionReport = {
    phase_id: expected.phase_id,
    round: expected.round,
    base_commit: expected.base_commit,
    status: value.status,
    summary,
    changed_files: changedFiles,
    self_tests: selfTests,
    resolved_findings: resolvedFindings,
    known_issues: knownIssues,
  };
  if (typeof value.executor_session_id === "string") report.executor_session_id = value.executor_session_id;
  return { report };
}

function normalizeFindings(value: unknown): ReviewFinding[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_FINDINGS) return undefined;
  const result: ReviewFinding[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      entry.id.length === 0 || entry.id.length > MAX_FINDING_ID_LENGTH ||
      ids.has(entry.id) ||
      typeof entry.severity !== "string" || entry.severity.length > MAX_REPORT_STRING_LENGTH ||
      typeof entry.summary !== "string" || entry.summary.length > MAX_REPORT_STRING_LENGTH ||
      typeof entry.evidence !== "string" || entry.evidence.length > MAX_REPORT_STRING_LENGTH ||
      typeof entry.blocking !== "boolean"
    ) {
      return undefined;
    }
    ids.add(entry.id);
    result.push({
      id: entry.id,
      severity: entry.severity,
      summary: entry.summary,
      evidence: entry.evidence,
      blocking: entry.blocking,
    });
  }
  return result;
}

export function normalizeReviewReport(
  value: unknown,
  expected: { phase_id: string; round: number; base_commit: string },
): { report?: ReviewReport; error?: string } {
  if (!reportWithinLimit(value)) return { error: "reviewer report exceeds the maximum evidence size" };
  if (!isRecord(value)) return { error: "reviewer report is not an object" };
  if (value.phase_id !== expected.phase_id) return { error: "reviewer report phase_id does not match current phase" };
  if (value.round !== expected.round) return { error: "reviewer report round does not match current round" };
  if (value.base_commit !== expected.base_commit) return { error: "reviewer report base_commit does not match phase base" };
  if (value.verdict !== "PASS" && value.verdict !== "REWORK") return { error: "reviewer verdict must be PASS or REWORK" };
  const summary = stringValue(value.summary);
  const findings = normalizeFindings(value.findings);
  const evidence = stringArray(value.evidence);
  const acceptance = stringValue(value.acceptance_assessment);
  const outOfScope = stringArray(value.out_of_scope_changes);
  if (!summary || !findings || !evidence || !acceptance || !outOfScope) {
    return { error: "reviewer report is missing a required field" };
  }
  const report: ReviewReport = {
    phase_id: expected.phase_id,
    round: expected.round,
    base_commit: expected.base_commit,
    verdict: value.verdict,
    summary,
    findings,
    evidence,
    acceptance_assessment: acceptance,
    out_of_scope_changes: outOfScope,
  };
  if (typeof value.reviewer_session_id === "string") report.reviewer_session_id = value.reviewer_session_id;
  return { report };
}

export function validateExecutionEvidence(
  report: ExecutionReport,
  contract: AcceptanceContract,
  actualChangedFiles: readonly string[],
): string | undefined {
  const ids = new Set<string>();
  for (const evidence of report.self_tests) {
    if (ids.has(evidence.id)) return `executor self-test ${evidence.id} is reported more than once`;
    ids.add(evidence.id);
  }
  for (const required of contract.self_tests.filter((test) => test.required)) {
    const matches = report.self_tests.filter((test) => test.id === required.id);
    if (matches.length !== 1) return `required self-test ${required.id} must be reported exactly once`;
    const evidence = matches[0];
    if (!evidence) return `required self-test ${required.id} is missing evidence`;
    if (evidence.command !== required.command) {
      return `self-test ${required.id} command does not match the frozen acceptance contract`;
    }
    if (evidence.status !== "passed") {
      return `required self-test ${required.id} was not passed by the Executor`;
    }
  }
  const declared = [...new Set(report.changed_files)].sort();
  const actual = [...new Set(actualChangedFiles)].sort();
  if (declared.length !== actual.length || declared.some((path, index) => path !== actual[index])) {
    return `executor changed_files does not match the actual workspace (${actual.join(", ") || "none"})`;
  }
  return undefined;
}

export function blockingFindings(report: ReviewReport): ReviewFinding[] {
  return report.findings.filter((finding) => finding.blocking);
}

export function formatReviewFeedback(report: ReviewReport): string {
  const findings = report.findings.length === 0
    ? "(none)"
    : report.findings
        .map(
          (finding) =>
            `${finding.id} [${finding.severity}${finding.blocking ? ", blocking" : ""}]: ${finding.summary}\nEvidence: ${finding.evidence}`,
        )
        .join("\n");
  const outOfScope = report.out_of_scope_changes.length === 0 ? "(none)" : report.out_of_scope_changes.join(", ");
  return [
    `Reviewer verdict: ${report.verdict}`,
    `Summary: ${report.summary}`,
    `Findings:\n${findings}`,
    `Out-of-scope changes: ${outOfScope}`,
    `Acceptance assessment: ${report.acceptance_assessment}`,
  ].join("\n");
}

export function makeInvalidExecutionReport(
  expected: { phase_id: string; round: number; base_commit: string },
  error: string,
): ExecutionReport {
  return {
    ...expected,
    status: "failed",
    summary: `Structured executor report rejected: ${error}`,
    changed_files: [],
    self_tests: [],
    resolved_findings: [],
    known_issues: [error],
  };
}

export function makeInvalidReviewReport(
  expected: { phase_id: string; round: number; base_commit: string },
  error: string,
): ReviewReport {
  return {
    ...expected,
    verdict: "REWORK",
    summary: `Structured reviewer report rejected: ${error}`,
    findings: [
      {
        id: "PLUGIN-REPORT",
        severity: "blocking",
        summary: "Reviewer returned an invalid structured report.",
        evidence: error,
        blocking: true,
      },
    ],
    evidence: [],
    acceptance_assessment: "Invalid report; acceptance cannot be established.",
    out_of_scope_changes: [],
  };
}

