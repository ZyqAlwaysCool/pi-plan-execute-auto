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

function json(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === "bigint") return item.toString();
    if (item instanceof Error) return { name: item.name, message: item.message, stack: item.stack };
    if (item && typeof item === "object") {
      if (seen.has(item as object)) return "[Circular]";
      seen.add(item as object);
    }
    return item;
  });
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
