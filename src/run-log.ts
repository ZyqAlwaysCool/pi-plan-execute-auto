import { mkdir, appendFile, writeFile, rename } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

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
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${json({ at: new Date().toISOString(), type, ...details })}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function writeRunJson(runRoot: string, relative: string, value: unknown): Promise<void> {
  const path = auditPath(runRoot, relative);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${json(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

export async function captureMainPiSession(
  runRoot: string,
  entries: unknown,
): Promise<void> {
  await writeRunJson(runRoot, ".runtime/main-pi-session.json", {
    captured_at: new Date().toISOString(),
    entries,
  });
}

export function runtimePath(runRoot: string, ...parts: string[]): string {
  return join(runRoot, ".runtime", ...parts);
}
