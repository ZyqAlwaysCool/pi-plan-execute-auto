import { mkdir, appendFile, writeFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve, sep } from "node:path";

function inside(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolved = resolve(candidate);
  return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${sep}`);
}

function auditPath(runRoot: string, relative: string): string {
  const path = resolve(runRoot, relative);
  if (!inside(runRoot, path)) throw new Error(`Run audit path escapes run root: ${relative}`);
  return path;
}

const SECRET_ENV_KEY = /(?:^|_)(?:API_?KEY|AUTH_?TOKEN|ACCESS_?TOKEN|REFRESH_?TOKEN|SECRET|PASSWORD|BEARER)(?:$|_)/iu;

function knownSecretValues(): string[] {
  return [...new Set(Object.entries(process.env)
    .filter(([key, value]) => Boolean(value) && SECRET_ENV_KEY.test(key))
    .map(([, value]) => value!)
    .filter((value) => value.length >= 8))]
    .sort((a, b) => b.length - a.length);
}

function redactSerialized(text: string): string {
  let redacted = text;
  for (const secret of knownSecretValues()) redacted = redacted.split(secret).join("[REDACTED_HOST_CREDENTIAL]");
  redacted = redacted
    .replace(/(authorization\\?["']?\s*[:=]\s*\\?["']?bearer\s+)[^\\\s"']+/giu, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|password|secret)\\?["']?\s*[:=]\s*\\?["'])[^"']+/giu, "$1[REDACTED]");
  return redacted;
}

const appendQueues = new Map<string, Promise<void>>();

async function appendJsonLine(path: string, line: string): Promise<void> {
  const previous = appendQueues.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  appendQueues.set(path, tail);
  try {
    await previous;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await appendFile(path, line, { encoding: "utf8", mode: 0o600 });
  } finally {
    release();
    if (appendQueues.get(path) === tail) appendQueues.delete(path);
  }
}

function json(value: unknown): string {
  const seen = new WeakSet<object>();
  const serialized = JSON.stringify(value, (key, item) => {
    if (SECRET_ENV_KEY.test(key) && typeof item === "string") return "[REDACTED_CREDENTIAL_FIELD]";
    if (typeof item === "bigint") return item.toString();
    if (item instanceof Error) return { name: item.name, message: item.message, stack: item.stack };
    if (item && typeof item === "object") {
      if (seen.has(item as object)) return "[Circular]";
      seen.add(item as object);
    }
    return item;
  });
  return redactSerialized(serialized);
}

export async function appendRunEvent(
  runRoot: string,
  type: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  const path = auditPath(runRoot, ".runtime/events.jsonl");
  await appendJsonLine(path, `${json({ at: new Date().toISOString(), type, ...details })}\n`);
}

function safeSessionSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160);
  if (!safe || safe === "." || safe === "..") throw new Error("Invalid Agent session id for transcript path.");
  return safe;
}

export function agentSessionTranscriptRelativePath(
  role: "executor" | "reviewer",
  sessionId: string,
): string {
  return `.runtime/sessions/${role}/${safeSessionSegment(sessionId)}.jsonl`;
}

const MAX_AUDIT_TEXT_BYTES = 24_000;
const MAX_PROMPT_HEAD_BYTES = 2_000;
const MAX_PROMPT_TAIL_BYTES = 600;

/** Longest prefix whose UTF-8 length stays within `maxBytes`; never splits a code point. */
function headWithinBytes(value: string, maxBytes: number): string {
  let end = value.length;
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) end -= 1;
  return value.slice(0, end);
}

/** Longest suffix whose UTF-8 length stays within `maxBytes`; never splits a code point. */
function tailWithinBytes(value: string, maxBytes: number): string {
  let start = 0;
  while (start < value.length && Buffer.byteLength(value.slice(start), "utf8") > maxBytes) start += 1;
  return value.slice(start);
}

/**
 * Prompts are long but reproducible from the frozen package plus persisted diffs and reports.
 * Diagnostics keep a digest plus bounded head/tail instead of duplicating the full prompt.
 */
export function summarizeAgentPrompt(prompt: string): Record<string, unknown> {
  const bytes = Buffer.byteLength(prompt, "utf8");
  const result: Record<string, unknown> = {
    prompt_sha256: createHash("sha256").update(prompt).digest("hex"),
    prompt_bytes: bytes,
    prompt_head: headWithinBytes(prompt, MAX_PROMPT_HEAD_BYTES),
  };
  if (bytes > MAX_PROMPT_HEAD_BYTES + MAX_PROMPT_TAIL_BYTES) {
    result.prompt_tail = tailWithinBytes(prompt, MAX_PROMPT_TAIL_BYTES);
  }
  return result;
}

/**
 * Structured reports are authoritative under `.runtime/reports/`; the transcript keeps the bounded
 * agent text plus a digest and identity of the structured report instead of a second full copy.
 */
export function summarizeAgentTurn(text: string, structured: unknown): Record<string, unknown> {
  const textBytes = Buffer.byteLength(text, "utf8");
  const result: Record<string, unknown> = {
    text: textBytes <= MAX_AUDIT_TEXT_BYTES
      ? text
      : `${headWithinBytes(text, MAX_AUDIT_TEXT_BYTES)}\n[audit text truncated; ${textBytes} bytes total]`,
    text_sha256: createHash("sha256").update(text).digest("hex"),
    text_bytes: textBytes,
  };
  if (structured !== undefined) {
    const serialized = JSON.stringify(structured) ?? "undefined";
    result.structured_sha256 = createHash("sha256").update(serialized).digest("hex");
    result.structured_bytes = Buffer.byteLength(serialized, "utf8");
    if (structured && typeof structured === "object" && !Array.isArray(structured)) {
      const record = structured as Record<string, unknown>;
      for (const key of ["phase_id", "round", "status", "verdict"] as const) {
        const entry = record[key];
        if (typeof entry === "string" || typeof entry === "number") result[`structured_${key}`] = entry;
      }
    }
  }
  return result;
}

export async function appendAgentSessionEvent(
  runRoot: string,
  role: "executor" | "reviewer",
  sessionId: string,
  type: string,
  details: Record<string, unknown> = {},
): Promise<string> {
  const relative = agentSessionTranscriptRelativePath(role, sessionId);
  const path = auditPath(runRoot, relative);
  await appendJsonLine(path, `${json({ at: new Date().toISOString(), type, role, session_id: sessionId, ...details })}\n`);
  return relative;
}

export async function writeRunJson(runRoot: string, relative: string, value: unknown): Promise<void> {
  const path = auditPath(runRoot, relative);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${json(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

export const MAX_MAIN_PI_SESSION_BYTES = 512 * 1024;
const MAX_MAIN_PI_SESSION_ENTRIES = 120;
const MAX_MAIN_PI_ENTRY_NODES = 256;
const MAX_MAIN_PI_STRING_BYTES = 8 * 1024;
const MAX_MAIN_PI_ARRAY_ITEMS = 24;
const MAX_MAIN_PI_OBJECT_KEYS = 32;
const MAX_MAIN_PI_DEPTH = 5;

function truncateDiagnosticString(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= MAX_MAIN_PI_STRING_BYTES) return value;
  const marker = "\n[diagnostic string truncated]";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const bytes = Buffer.from(value, "utf8");
  return `${bytes.subarray(0, Math.max(0, MAX_MAIN_PI_STRING_BYTES - markerBytes)).toString("utf8")}${marker}`;
}

function compactDiagnosticValue(
  value: unknown,
  budget: { nodes: number; seen: WeakSet<object> },
  depth = 0,
): unknown {
  if (budget.nodes >= MAX_MAIN_PI_ENTRY_NODES) return "[diagnostic node limit reached]";
  budget.nodes += 1;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return truncateDiagnosticString(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) {
    return compactDiagnosticValue(
      { name: value.name, message: value.message, stack: value.stack },
      budget,
      depth,
    );
  }
  if (!value || typeof value !== "object") return `[${typeof value}]`;
  if (budget.seen.has(value as object)) return "[Circular]";
  if (depth >= MAX_MAIN_PI_DEPTH) return "[diagnostic depth limit reached]";
  budget.seen.add(value as object);

  if (Array.isArray(value)) {
    if (value.length <= MAX_MAIN_PI_ARRAY_ITEMS) {
      return value.map((entry) => compactDiagnosticValue(entry, budget, depth + 1));
    }
    const edge = Math.floor(MAX_MAIN_PI_ARRAY_ITEMS / 2);
    return [
      ...value.slice(0, edge).map((entry) => compactDiagnosticValue(entry, budget, depth + 1)),
      `[${value.length - (edge * 2)} array item(s) omitted]`,
      ...value.slice(-edge).map((entry) => compactDiagnosticValue(entry, budget, depth + 1)),
    ];
  }

  const result: Record<string, unknown> = {};
  const objectEntries = Object.entries(value as Record<string, unknown>);
  for (const [key, entry] of objectEntries.slice(0, MAX_MAIN_PI_OBJECT_KEYS)) {
    result[key.slice(0, 256)] = compactDiagnosticValue(entry, budget, depth + 1);
  }
  if (objectEntries.length > MAX_MAIN_PI_OBJECT_KEYS) {
    result.__omitted_keys = objectEntries.length - MAX_MAIN_PI_OBJECT_KEYS;
  }
  return result;
}

function compactMainPiEntry(entry: unknown): unknown {
  return compactDiagnosticValue(entry, { nodes: 0, seen: new WeakSet<object>() });
}

function mainPiSessionSnapshot(entries: unknown): Record<string, unknown> {
  const sourceEntries = Array.isArray(entries) ? entries : [];
  const candidates = sourceEntries.slice(-MAX_MAIN_PI_SESSION_ENTRIES).map(compactMainPiEntry);
  const capturedAt = new Date().toISOString();
  let retained = candidates;
  for (;;) {
    const snapshot = {
      captured_at: capturedAt,
      source_entry_count: sourceEntries.length,
      retained_entry_count: retained.length,
      truncated: !Array.isArray(entries) || retained.length < sourceEntries.length,
      entries: retained,
    };
    if (Buffer.byteLength(json(snapshot), "utf8") + 1 <= MAX_MAIN_PI_SESSION_BYTES || retained.length === 0) {
      return snapshot;
    }
    retained = retained.slice(1);
  }
}

export async function captureMainPiSession(
  runRoot: string,
  entries: unknown,
): Promise<void> {
  await writeRunJson(runRoot, ".runtime/main-pi-session.json", mainPiSessionSnapshot(entries));
}
