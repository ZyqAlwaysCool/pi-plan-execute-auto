import { createHash } from "node:crypto";
import {
  access,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, posix, resolve, sep } from "node:path";
import YAML from "yaml";
import {
  MANIFEST_FILE,
  RUNTIME_DIRECTORY,
  STATE_FILE,
  type AcceptanceContract,
  type AcceptanceSelfTest,
  type CommitContract,
  type DocumentReference,
  type FinalizeInput,
  type Manifest,
  type PackageFileInput,
  type PackageValidationIssue,
  type PhasePackage,
  type PhaseReference,
  type ValidatedPackage,
  WORKFLOW_VERSION,
} from "./types.js";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface PackageValidationResult {
  ok: boolean;
  errors: PackageValidationIssue[];
  package?: ValidatedPackage;
}

export interface PackageWriteResult {
  package: ValidatedPackage;
  created: boolean;
}

function issue(
  errors: PackageValidationIssue[],
  code: string,
  path: string,
  message: string,
): void {
  errors.push({ code, path, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.trim().length > 0;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/**
 * Validate a path that is stored in a package. Package paths are deliberately POSIX-shaped,
 * even when pi is running on a platform with a different native separator.
 */
export function normalizePackagePath(value: unknown): string | undefined {
  if (!isString(value) || value.length === 0 || value.includes("\\")) return undefined;
  if (isAbsolute(value) || value.startsWith("/")) return undefined;
  const normalized = posix.normalize(value);
  if (normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    return undefined;
  }
  if (normalized.split("/").some((part) => part === ".." || part.length === 0)) {
    return undefined;
  }
  return normalized;
}

export function assertSafeRunId(value: string): void {
  if (!RUN_ID_PATTERN.test(value)) {
    throw new Error(
      `Invalid run_id ${JSON.stringify(value)}; use 1-64 letters, numbers, '.', '_' or '-'.`,
    );
  }
}

export function makeRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `run-${stamp.toLowerCase()}`;
}

function parseYaml(content: string, source: string, errors: PackageValidationIssue[]): unknown {
  try {
    return YAML.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issue(errors, "YAML_INVALID", source, message);
    return undefined;
  }
}

function validateDocumentReferences(
  value: unknown,
  errors: PackageValidationIssue[],
): DocumentReference[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issue(errors, "DOCUMENTS_NOT_ARRAY", "manifest.documents", "documents must be an array.");
    return [];
  }

  const result: DocumentReference[] = [];
  const ids = new Set<string>();
  const paths = new Set<string>();
  value.forEach((entry, index) => {
    const path = `manifest.documents[${index}]`;
    if (!isRecord(entry)) {
      issue(errors, "DOCUMENT_INVALID", path, "document must be an object.");
      return;
    }
    const id = entry.id;
    const filePath = normalizePackagePath(entry.path);
    const purpose = entry.purpose;
    if (!isNonEmptyString(id) || !ID_PATTERN.test(id)) {
      issue(errors, "DOCUMENT_ID_INVALID", `${path}.id`, "document id is invalid.");
    } else if (ids.has(id)) {
      issue(errors, "DOCUMENT_ID_DUPLICATE", `${path}.id`, `duplicate document id ${id}.`);
    } else {
      ids.add(id);
    }
    if (!filePath) {
      issue(
        errors,
        "DOCUMENT_PATH_INVALID",
        `${path}.path`,
        "document path must be a safe relative package path.",
      );
    } else if (paths.has(filePath)) {
      issue(errors, "DOCUMENT_PATH_DUPLICATE", `${path}.path`, `duplicate document path ${filePath}.`);
    } else {
      paths.add(filePath);
    }
    if (!isNonEmptyString(purpose)) {
      issue(errors, "DOCUMENT_PURPOSE_INVALID", `${path}.purpose`, "document purpose is required.");
    }
    if (isNonEmptyString(id) && ID_PATTERN.test(id) && filePath && isNonEmptyString(purpose)) {
      result.push({ id, path: filePath, purpose: purpose.trim() });
    }
  });
  return result;
}

function validateCommit(
  value: unknown,
  errors: PackageValidationIssue[],
  path: string,
): CommitContract | undefined {
  if (!isRecord(value)) {
    issue(errors, "COMMIT_CONTRACT_MISSING", path, "each phase must require a completion commit.");
    return undefined;
  }
  if (value.required !== true) {
    issue(errors, "COMMIT_REQUIRED", `${path}.required`, "phase commit.required must be true.");
  }
  if (!isNonEmptyString(value.message)) {
    issue(errors, "COMMIT_MESSAGE_INVALID", `${path}.message`, "phase commit message is required.");
  }
  if (value.required === true && isNonEmptyString(value.message)) {
    return { required: true, message: value.message.trim() };
  }
  return undefined;
}

function validatePhaseReferences(
  value: unknown,
  errors: PackageValidationIssue[],
): PhaseReference[] {
  if (!Array.isArray(value) || value.length === 0) {
    issue(errors, "PHASES_REQUIRED", "manifest.phases", "manifest must contain at least one phase.");
    return [];
  }

  const result: PhaseReference[] = [];
  const ids = new Set<string>();
  const orders = new Set<number>();
  const paths = new Set<string>();

  value.forEach((entry, index) => {
    const path = `manifest.phases[${index}]`;
    if (!isRecord(entry)) {
      issue(errors, "PHASE_INVALID", path, "phase must be an object.");
      return;
    }
    const id = entry.id;
    const order = entry.order;
    const spec = normalizePackagePath(entry.spec);
    const acceptance = normalizePackagePath(entry.acceptance);
    const commit = validateCommit(entry.commit, errors, `${path}.commit`);

    if (!isNonEmptyString(id) || !ID_PATTERN.test(id)) {
      issue(errors, "PHASE_ID_INVALID", `${path}.id`, "phase id is invalid.");
    } else if (ids.has(id)) {
      issue(errors, "PHASE_ID_DUPLICATE", `${path}.id`, `duplicate phase id ${id}.`);
    } else {
      ids.add(id);
    }
    if (!isInteger(order) || order < 1) {
      issue(errors, "PHASE_ORDER_INVALID", `${path}.order`, "phase order must be a positive integer.");
    } else if (orders.has(order)) {
      issue(errors, "PHASE_ORDER_DUPLICATE", `${path}.order`, `duplicate phase order ${order}.`);
    } else {
      orders.add(order);
    }
    if (!spec) {
      issue(errors, "PHASE_SPEC_INVALID", `${path}.spec`, "phase spec must be a safe relative path.");
    }
    if (!acceptance) {
      issue(
        errors,
        "PHASE_ACCEPTANCE_INVALID",
        `${path}.acceptance`,
        "phase acceptance must be a safe relative path.",
      );
    }
    if (spec && acceptance && spec === acceptance) {
      issue(errors, "PHASE_FILES_SAME", path, "phase spec and acceptance must be separate files.");
    }
    for (const referencedPath of [spec, acceptance]) {
      if (referencedPath) {
        if (paths.has(referencedPath)) {
          issue(errors, "PHASE_PATH_DUPLICATE", path, `duplicate phase file path ${referencedPath}.`);
        }
        paths.add(referencedPath);
      }
    }
    if (
      isNonEmptyString(id) &&
      ID_PATTERN.test(id) &&
      isInteger(order) &&
      order >= 1 &&
      spec &&
      acceptance &&
      commit
    ) {
      result.push({ id, order, spec, acceptance, commit });
    }
  });

  const sortedOrders = [...orders].sort((a, b) => a - b);
  sortedOrders.forEach((order, index) => {
    if (order !== index + 1) {
      issue(
        errors,
        "PHASE_ORDER_NOT_CONTIGUOUS",
        "manifest.phases",
        `phase orders must be unique and contiguous starting at 1; found ${sortedOrders.join(", ")}.`,
      );
    }
  });
  return result.sort((a, b) => a.order - b.order);
}

function validateManifest(
  value: unknown,
  errors: PackageValidationIssue[],
): Manifest | undefined {
  if (!isRecord(value)) {
    issue(errors, "MANIFEST_INVALID", MANIFEST_FILE, "manifest must be a YAML object.");
    return undefined;
  }
  if (value.version !== WORKFLOW_VERSION) {
    issue(errors, "MANIFEST_VERSION", "manifest.version", "manifest.version must be 1.");
  }
  const documents = validateDocumentReferences(value.documents, errors);
  const phases = validatePhaseReferences(value.phases, errors);
  if (value.max_review_rounds !== undefined) {
    if (!isInteger(value.max_review_rounds) || value.max_review_rounds < 1 || value.max_review_rounds > 100) {
      issue(
        errors,
        "MAX_REVIEW_ROUNDS_INVALID",
        "manifest.max_review_rounds",
        "max_review_rounds must be an integer from 1 to 100.",
      );
    }
  }
  if (value.version !== WORKFLOW_VERSION || errors.some((entry) => entry.path === "manifest.phases" && entry.code === "PHASES_REQUIRED")) {
    return undefined;
  }
  const manifest: Manifest = {
    version: WORKFLOW_VERSION,
    documents,
    phases,
  };
  if (isInteger(value.max_review_rounds) && value.max_review_rounds >= 1 && value.max_review_rounds <= 100) {
    manifest.max_review_rounds = value.max_review_rounds;
  }
  return manifest;
}

function validateAcceptance(
  value: unknown,
  phase: PhaseReference,
  errors: PackageValidationIssue[],
  source: string,
): AcceptanceContract | undefined {
  if (!isRecord(value)) {
    issue(errors, "ACCEPTANCE_INVALID", source, "acceptance contract must be a YAML object.");
    return undefined;
  }
  if (value.version !== WORKFLOW_VERSION) {
    issue(errors, "ACCEPTANCE_VERSION", `${source}.version`, "acceptance.version must be 1.");
  }
  if (value.phase_id !== phase.id) {
    issue(
      errors,
      "ACCEPTANCE_PHASE_MISMATCH",
      `${source}.phase_id`,
      `acceptance phase_id must equal ${phase.id}.`,
    );
  }

  const scope = value.scope;
  let allowedPaths: string[] = [];
  if (!isRecord(scope) || !Array.isArray(scope.allowed_paths)) {
    issue(errors, "ACCEPTANCE_SCOPE_INVALID", `${source}.scope.allowed_paths`, "allowed_paths must be an array.");
  } else {
    const seen = new Set<string>();
    scope.allowed_paths.forEach((entry, index) => {
      const normalized = normalizePackagePath(entry);
      if (!normalized) {
        issue(
          errors,
          "ALLOWED_PATH_INVALID",
          `${source}.scope.allowed_paths[${index}]`,
          "allowed path must be a safe relative path or glob.",
        );
      } else if (seen.has(normalized)) {
        issue(
          errors,
          "ALLOWED_PATH_DUPLICATE",
          `${source}.scope.allowed_paths[${index}]`,
          `duplicate allowed path ${normalized}.`,
        );
      } else {
        seen.add(normalized);
        allowedPaths.push(normalized);
      }
    });
  }

  const selfTests: AcceptanceSelfTest[] = [];
  if (!Array.isArray(value.self_tests)) {
    issue(errors, "SELF_TESTS_INVALID", `${source}.self_tests`, "self_tests must be an array.");
  } else {
    const ids = new Set<string>();
    value.self_tests.forEach((entry, index) => {
      const path = `${source}.self_tests[${index}]`;
      if (!isRecord(entry)) {
        issue(errors, "SELF_TEST_INVALID", path, "self test must be an object.");
        return;
      }
      if (!isNonEmptyString(entry.id) || !ID_PATTERN.test(entry.id)) {
        issue(errors, "SELF_TEST_ID_INVALID", `${path}.id`, "self test id is invalid.");
      } else if (ids.has(entry.id)) {
        issue(errors, "SELF_TEST_ID_DUPLICATE", `${path}.id`, `duplicate self test id ${entry.id}.`);
      } else {
        ids.add(entry.id);
      }
      if (!isNonEmptyString(entry.command)) {
        issue(errors, "SELF_TEST_COMMAND_INVALID", `${path}.command`, "self test command is required.");
      }
      if (typeof entry.required !== "boolean") {
        issue(errors, "SELF_TEST_REQUIRED_INVALID", `${path}.required`, "self test required must be boolean.");
      }
      if (
        isNonEmptyString(entry.id) &&
        ID_PATTERN.test(entry.id) &&
        isNonEmptyString(entry.command) &&
        typeof entry.required === "boolean"
      ) {
        selfTests.push({ id: entry.id, command: entry.command.trim(), required: entry.required });
      }
    });
  }

  if (selfTests.length === 0) {
    issue(errors, "SELF_TESTS_REQUIRED", `${source}.self_tests`, "each phase must declare at least one self-test.");
  } else if (!selfTests.some((entry) => entry.required)) {
    issue(errors, "REQUIRED_SELF_TEST_REQUIRED", `${source}.self_tests`, "each phase must declare at least one required self-test.");
  }

  if (!isRecord(value.review) || value.review.require_no_blocking_findings !== true) {
    issue(
      errors,
      "REVIEW_POLICY_INVALID",
      `${source}.review.require_no_blocking_findings`,
      "review.require_no_blocking_findings must be true.",
    );
  }
  if (!isRecord(value.commit) || value.commit.required !== true || typeof value.commit.allow_empty !== "boolean") {
    issue(
      errors,
      "ACCEPTANCE_COMMIT_INVALID",
      `${source}.commit`,
      "acceptance commit must require a commit and explicitly set allow_empty.",
    );
  }

  if (
    value.version === WORKFLOW_VERSION &&
    value.phase_id === phase.id &&
    isRecord(scope) &&
    Array.isArray(scope.allowed_paths) &&
    Array.isArray(value.self_tests) &&
    isRecord(value.review) &&
    value.review.require_no_blocking_findings === true &&
    isRecord(value.commit) &&
    value.commit.required === true &&
    typeof value.commit.allow_empty === "boolean"
  ) {
    return {
      version: WORKFLOW_VERSION,
      phase_id: phase.id,
      scope: { allowed_paths: allowedPaths },
      self_tests: selfTests,
      review: { require_no_blocking_findings: true },
      commit: { required: true, allow_empty: value.commit.allow_empty },
    };
  }
  return undefined;
}

async function walkFiles(root: string, current = ""): Promise<string[]> {
  const absolute = join(root, current);
  const entries = await readdir(absolute, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const relative = current ? `${current}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      throw new Error(`SYMLINK_NOT_ALLOWED:${relative}`);
    }
    if (entry.isDirectory()) {
      result.push(...(await walkFiles(root, relative)));
    } else if (entry.isFile()) {
      result.push(relative);
    }
  }
  return result.sort();
}

function isRuntimePath(relative: string): boolean {
  return relative === STATE_FILE || relative === RUNTIME_DIRECTORY || relative.startsWith(`${RUNTIME_DIRECTORY}/`);
}

async function readRequiredFile(
  root: string,
  relative: string,
  files: Set<string>,
  errors: PackageValidationIssue[],
  source: string,
): Promise<string | undefined> {
  if (!files.has(relative)) {
    issue(errors, "REFERENCED_FILE_MISSING", source, `referenced file ${relative} does not exist.`);
    return undefined;
  }
  try {
    return await readFile(join(root, ...relative.split("/")), "utf8");
  } catch (error) {
    issue(
      errors,
      "REFERENCED_FILE_UNREADABLE",
      source,
      error instanceof Error ? error.message : String(error),
    );
    return undefined;
  }
}

export async function hashGoldenFiles(root: string, files?: string[]): Promise<{ hash: string; files: string[] }> {
  const discovered = files ?? (await walkFiles(root));
  const golden = discovered
    .map((entry) => normalizePackagePath(entry))
    .filter((entry): entry is string => entry !== undefined && !isRuntimePath(entry))
    .sort();
  const hash = createHash("sha256");
  for (const relative of golden) {
    const content = await readFile(join(root, ...relative.split("/")));
    hash.update(relative);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return { hash: hash.digest("hex"), files: golden };
}

export async function validatePackageDirectory(root: string): Promise<PackageValidationResult> {
  const absoluteRoot = resolve(root);
  const errors: PackageValidationIssue[] = [];
  let files: string[];
  try {
    const stat = await lstat(absoluteRoot);
    if (!stat.isDirectory()) {
      issue(errors, "PACKAGE_ROOT_INVALID", ".", "package root is not a directory.");
      return { ok: false, errors };
    }
    files = await walkFiles(absoluteRoot);
  } catch (error) {
    issue(errors, "PACKAGE_ROOT_UNREADABLE", ".", error instanceof Error ? error.message : String(error));
    return { ok: false, errors };
  }

  for (const file of files) {
    if (!normalizePackagePath(file)) {
      issue(errors, "PACKAGE_PATH_INVALID", file, "package contains an unsafe path.");
    }
  }
  const fileSet = new Set(files);
  const manifestText = await readRequiredFile(absoluteRoot, MANIFEST_FILE, fileSet, errors, MANIFEST_FILE);
  if (manifestText === undefined) return { ok: false, errors };
  const manifestValue = parseYaml(manifestText, MANIFEST_FILE, errors);
  const manifest = validateManifest(manifestValue, errors);
  if (!manifest) return { ok: false, errors };

  const referencedPaths = new Set<string>([MANIFEST_FILE]);
  for (const document of manifest.documents) {
    const normalized = normalizePackagePath(document.path);
    if (normalized) {
      referencedPaths.add(normalized);
      await readRequiredFile(absoluteRoot, normalized, fileSet, errors, `manifest.documents.${document.id}.path`);
    }
  }

  const phases: PhasePackage[] = [];
  for (const phase of manifest.phases) {
    referencedPaths.add(phase.spec);
    referencedPaths.add(phase.acceptance);
    const spec = await readRequiredFile(
      absoluteRoot,
      phase.spec,
      fileSet,
      errors,
      `manifest.phases.${phase.id}.spec`,
    );
    const acceptanceText = await readRequiredFile(
      absoluteRoot,
      phase.acceptance,
      fileSet,
      errors,
      `manifest.phases.${phase.id}.acceptance`,
    );
    if (spec === undefined || acceptanceText === undefined) continue;
    if (spec.trim().length === 0) {
      issue(errors, "PHASE_SPEC_EMPTY", phase.spec, "each phase must have a non-empty independent spec.");
      continue;
    }
    const acceptanceValue = parseYaml(acceptanceText, phase.acceptance, errors);
    const acceptance = validateAcceptance(acceptanceValue, phase, errors, phase.acceptance);
    if (acceptance) phases.push({ phase, spec, acceptance });
  }

  if (errors.length > 0) return { ok: false, errors };
  const { hash, files: goldenFiles } = await hashGoldenFiles(absoluteRoot, files);
  return {
    ok: true,
    errors: [],
    package: {
      root: absoluteRoot,
      manifest,
      phases,
      package_hash: hash,
      golden_files: goldenFiles,
    },
  };
}

function validateFinalizeInput(input: FinalizeInput): PackageValidationIssue[] {
  const errors: PackageValidationIssue[] = [];
  if (!input || typeof input !== "object") {
    issue(errors, "INPUT_INVALID", "input", "finalization input must be an object.");
    return errors;
  }
  if (input.run_id !== undefined && (!isString(input.run_id) || !RUN_ID_PATTERN.test(input.run_id))) {
    issue(errors, "RUN_ID_INVALID", "run_id", "run_id is invalid.");
  }
  if (!isRecord(input.manifest)) issue(errors, "MANIFEST_INVALID", "manifest", "manifest is required.");
  if (!Array.isArray(input.files)) issue(errors, "FILES_INVALID", "files", "files must be an array.");
  const seen = new Set<string>();
  for (const [index, file] of (input.files ?? []).entries()) {
    if (!isRecord(file)) {
      issue(errors, "FILE_INVALID", `files[${index}]`, "file must be an object.");
      continue;
    }
    const path = normalizePackagePath(file.path);
    if (!path || path === MANIFEST_FILE || path === STATE_FILE || path === RUNTIME_DIRECTORY || path.startsWith(`${RUNTIME_DIRECTORY}/`)) {
      issue(errors, "FILE_PATH_INVALID", `files[${index}].path`, "file path is unsafe or reserved.");
    } else if (seen.has(path)) {
      issue(errors, "FILE_PATH_DUPLICATE", `files[${index}].path`, `duplicate file path ${path}.`);
    } else {
      seen.add(path);
    }
    if (!isString(file.content)) issue(errors, "FILE_CONTENT_INVALID", `files[${index}].content`, "file content must be text.");
  }
  return errors;
}

export function serializeManifest(manifest: Manifest): string {
  return YAML.stringify(manifest, { indent: 2, lineWidth: 0 });
}

export async function writeValidatedPackage(
  cwd: string,
  input: FinalizeInput,
  runId: string,
): Promise<PackageWriteResult> {
  const inputErrors = validateFinalizeInput(input);
  if (inputErrors.length > 0) {
    throw new PackageInputError(inputErrors);
  }
  assertSafeRunId(runId);
  const root = resolve(cwd, ".pi-plan-execute-auto", runId);
  try {
    await access(root);
    throw new Error(`Package already exists for run ${runId}; choose a new run_id.`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Package already exists")) throw error;
  }

  const parent = dirname(root);
  await mkdir(parent, { recursive: true });
  const temporary = join(parent, `.tmp-${runId}-${process.pid}-${Date.now()}`);
  await mkdir(temporary, { recursive: true });
  try {
    const manifest: Manifest = {
      version: WORKFLOW_VERSION,
      documents: input.manifest.documents ?? [],
      phases: input.manifest.phases,
    };
    if (input.manifest.max_review_rounds !== undefined) {
      manifest.max_review_rounds = input.manifest.max_review_rounds;
    }
    await writeFile(join(temporary, MANIFEST_FILE), serializeManifest(manifest), "utf8");
    for (const file of input.files as PackageFileInput[]) {
      const path = normalizePackagePath(file.path);
      if (!path) throw new Error(`Invalid package file path ${file.path}.`);
      const target = join(temporary, ...path.split("/"));
      const resolvedTarget = resolve(target);
      if (resolvedTarget !== temporary && !resolvedTarget.startsWith(`${temporary}${sep}`)) {
        throw new Error(`Package file escapes package root: ${file.path}.`);
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, "utf8");
    }
    await rename(temporary, root);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }

  const validation = await validatePackageDirectory(root);
  if (!validation.ok || !validation.package) {
    await rm(root, { recursive: true, force: true });
    throw new PackageValidationError(validation.errors);
  }
  return { package: validation.package, created: true };
}


export async function replaceValidatedDraftPackage(
  cwd: string,
  input: FinalizeInput,
  runId: string,
  expectedPackageHash: string,
): Promise<PackageWriteResult> {
  const inputErrors = validateFinalizeInput(input);
  if (inputErrors.length > 0) throw new PackageInputError(inputErrors);
  assertSafeRunId(runId);
  const root = resolve(cwd, ".pi-plan-execute-auto", runId);
  const current = await readWorkflowState(root);
  if (!current || current.run_id !== runId || current.status !== "draft") {
    throw new Error(`Workflow ${runId} is not an editable draft.`);
  }
  if (current.package_hash !== expectedPackageHash) {
    throw new Error("The draft plan changed after the requested revision; review the latest package before rewriting it.");
  }
  const previousValidation = await validatePackageDirectory(root);
  if (!previousValidation.ok || !previousValidation.package || previousValidation.package.package_hash !== expectedPackageHash) {
    throw new Error("The current draft package no longer matches the revision base hash.");
  }

  const parent = dirname(root);
  const temporary = join(parent, `.tmp-revise-${runId}-${process.pid}-${Date.now()}`);
  const backup = join(parent, `.backup-revise-${runId}-${process.pid}-${Date.now()}`);
  await mkdir(temporary, { recursive: true });
  try {
    const manifest: Manifest = {
      version: WORKFLOW_VERSION,
      documents: input.manifest.documents ?? [],
      phases: input.manifest.phases,
    };
    if (input.manifest.max_review_rounds !== undefined) manifest.max_review_rounds = input.manifest.max_review_rounds;
    await writeFile(join(temporary, MANIFEST_FILE), serializeManifest(manifest), "utf8");
    for (const file of input.files as PackageFileInput[]) {
      const path = normalizePackagePath(file.path);
      if (!path) throw new Error(`Invalid package file path ${file.path}.`);
      const target = join(temporary, ...path.split("/"));
      const resolvedTarget = resolve(target);
      if (resolvedTarget !== temporary && !resolvedTarget.startsWith(`${temporary}${sep}`)) {
        throw new Error(`Package file escapes package root: ${file.path}.`);
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, "utf8");
    }
    const staged = await validatePackageDirectory(temporary);
    if (!staged.ok || !staged.package) throw new PackageValidationError(staged.errors);

    await rename(root, backup);
    try {
      await rename(temporary, root);
      const oldRuntime = join(backup, RUNTIME_DIRECTORY);
      try {
        await cp(oldRuntime, join(root, RUNTIME_DIRECTORY), { recursive: true, force: true, errorOnExist: false });
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      }

      const revision = current.plan_revision ?? 1;
      const snapshotRoot = join(root, RUNTIME_DIRECTORY, "planning", "revisions", `revision-${String(revision).padStart(3, "0")}`, "package");
      for (const relativePath of previousValidation.package.golden_files) {
        const source = join(backup, ...relativePath.split("/"));
        const target = join(snapshotRoot, ...relativePath.split("/"));
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await cp(source, target, { force: true });
      }

      const validation = await validatePackageDirectory(root);
      if (!validation.ok || !validation.package) throw new PackageValidationError(validation.errors);
      const next: import("./types.js").WorkflowState = {
        ...current,
        package_hash: validation.package.package_hash,
        package_dir: validation.package.root,
        status: "draft",
        plan_revision: revision + 1,
        phases: validation.package.phases.map((phase) => ({
          phase_id: phase.phase.id,
          status: "pending",
          review_rounds: 0,
          execution_report_paths: [],
          review_report_paths: [],
          unresolved_findings: [],
        })),
      };
      delete next.approved_at;
      delete next.started_at;
      delete next.completed_at;
      delete next.pause_reason;
      delete next.branch_name;
      delete next.worktree_path;
      delete next.controlled_environment_paths;
      await writeWorkflowState(root, next);
      await rm(backup, { recursive: true, force: true });
      return { package: validation.package, created: false };
    } catch (error) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
      await rename(backup, root).catch(() => undefined);
      throw error;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}

export class PackageInputError extends Error {
  readonly issues: PackageValidationIssue[];

  constructor(issues: PackageValidationIssue[]) {
    super(`Invalid finalization input (${issues.length} error${issues.length === 1 ? "" : "s"}).`);
    this.name = "PackageInputError";
    this.issues = issues;
  }
}

export class PackageValidationError extends Error {
  readonly issues: PackageValidationIssue[];

  constructor(issues: PackageValidationIssue[]) {
    super(`Invalid document package (${issues.length} error${issues.length === 1 ? "" : "s"}).`);
    this.name = "PackageValidationError";
    this.issues = issues;
  }
}

export async function readWorkflowState(root: string): Promise<import("./types.js").WorkflowState | undefined> {
  try {
    const content = await readFile(join(root, STATE_FILE), "utf8");
    const value: unknown = JSON.parse(content);
    if (!isRecord(value) || value.version !== WORKFLOW_VERSION || !isString(value.run_id)) return undefined;
    if (!isString(value.package_hash) || !isString(value.package_dir) || !isString(value.created_at)) return undefined;
    if (value.plan_revision !== undefined && (!isInteger(value.plan_revision) || value.plan_revision < 1)) return undefined;
    if (!isString(value.status) || !["draft", "frozen", "running", "paused", "completed", "cancelled"].includes(value.status)) return undefined;
    if (!Array.isArray(value.phases)) return undefined;
    for (const phase of value.phases) {
      if (
        !isRecord(phase) ||
        !isString(phase.phase_id) ||
        !isString(phase.status) ||
        !["pending", "running", "paused", "completed"].includes(phase.status) ||
        !isInteger(phase.review_rounds) ||
        phase.review_rounds < 0
      ) {
        return undefined;
      }
    }
    return value as unknown as import("./types.js").WorkflowState;
  } catch {
    return undefined;
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

/** Write an evidence record once. Existing bytes may be re-validated but never replaced. */
export async function writeJsonExclusive(path: string, value: unknown): Promise<void> {
  await writeTextExclusive(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextExclusive(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
    const existing = await readFile(path, "utf8");
    if (existing !== content) throw new Error(`Immutable evidence record already exists with different bytes: ${path}`);
  }
}

export async function writeWorkflowState(root: string, state: import("./types.js").WorkflowState): Promise<void> {
  await writeJsonAtomic(join(root, STATE_FILE), state);
}

export async function packageStatus(root: string): Promise<import("./types.js").WorkflowStatusSnapshot | undefined> {
  const state = await readWorkflowState(root);
  if (!state) return undefined;
  const current = state.phases.find((phase) => phase.status !== "completed");
  return {
    run_id: state.run_id,
    status: state.status,
    package_dir: state.package_dir,
    package_hash: state.package_hash,
    ...(current?.phase_id ? { current_phase: current.phase_id } : {}),
    completed_phases: state.phases.filter((phase) => phase.status === "completed").length,
    total_phases: state.phases.length,
    ...(state.pause_reason ? { pause_reason: state.pause_reason } : {}),
  };
}

export function formatValidationIssues(issues: PackageValidationIssue[]): string {
  if (issues.length === 0) return "No validation errors.";
  return issues.map((entry) => `- [${entry.code}] ${entry.path}: ${entry.message}`).join("\n");
}

export function formatPackageSummary(pkg: ValidatedPackage): string {
  const documents = pkg.manifest.documents.length;
  const phases = pkg.phases.map((phase) => `${phase.phase.order}:${phase.phase.id}`).join(", ");
  return [
    `Package: ${pkg.root}`,
    `Documents: ${documents}`,
    `Phases: ${pkg.phases.length} (${phases})`,
    `Golden hash: ${pkg.package_hash}`,
    "Structural validation: PASS",
  ].join("\n");
}
