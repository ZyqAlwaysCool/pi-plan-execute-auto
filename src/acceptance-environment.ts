/**
 * The acceptance sandbox contract.
 *
 * Acceptance commands run inside the same filesystem boundary as the ACP actors, never in the host
 * shell. That boundary is deliberately minimal, and a plan author that does not know it will write
 * a gate that cannot possibly run (`go test` without `go` on the sandbox PATH). The plugin used to
 * discover that only after several executor rounds, each of which burned review budget.
 *
 * This module is the single place that describes the contract and derives the cheap preflight
 * probes. It never widens the sandbox: it only answers "can the declared command resolve here?".
 */

/** PATH order inside the acceptance sandbox (host `~/.local/bin` is mounted read-only). */
export const ACCEPTANCE_SANDBOX_PATH = [
  "<runtime-home>/.local/bin  (read-only mirror of the host's ~/.local/bin)",
  "<runtime-home>/.cargo/bin",
  "<runtime-home>/bin",
  "<runtime-node-bin>",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

/** Mount set of the acceptance sandbox. Kept in sync with `addMinimalFilesystem` in sandbox.ts. */
export const ACCEPTANCE_SANDBOX_MOUNTS = [
  "worktree root (read-write): the dedicated per-run worktree, mounted at its host absolute path",
  "worktree .git: read-only pointer into the run's Git metadata mirror",
  "run package directory (read-only): .pi-plan-execute-auto/<run-id>",
  "/tmp: private scratch directory for the acceptance command",
  "/usr, /bin, /lib, /lib64, /sbin, /usr/local, /etc/ssl/certs, /etc/hosts, /etc/passwd (read-only)",
  "/agent-runtime: the plugin's own Node runtime and the host agent CLIs",
  "<runtime-home>/.local/bin: read-only mirror of the host's ~/.local/bin",
];

export const ACCEPTANCE_SANDBOX_NOTES = [
  "HOME is a private sandbox home; TMPDIR/TMP/TEMP are /tmp inside the sandbox.",
  "The host project root, the host home directory, and any path outside the list above are NOT visible.",
  "Acceptance commands keep normal network access (same policy as the agent sessions).",
  "The sandbox removes host credentials and proxy policy differences; do not rely on host-only variables.",
  "Acceptance commands run with cwd = worktree root, so repository-relative tool paths work.",
];

/** Human-readable contract lines for pause messages, prompts, and the setup summary. */
export function describeAcceptanceSandbox(): string[] {
  return [
    "Acceptance sandbox contract:",
    ...ACCEPTANCE_SANDBOX_MOUNTS.map((line) => `- mount: ${line}`),
    ...ACCEPTANCE_SANDBOX_NOTES.map((line) => `- ${line}`),
    "- PATH order:",
    ...ACCEPTANCE_SANDBOX_PATH.map((line) => `  - ${line}`),
    "- Consequence: a self-test must resolve its tools from the sandbox PATH or a repository-relative path;"
      + " host-only absolute paths (for example a host home directory) do not exist here.",
  ];
}

export type AcceptanceProbeKind = "command" | "executable-path";

export interface AcceptanceProbe {
  test_id: string;
  /** Declared `requires` entry, or the command's own leading executable. */
  target: string;
  kind: AcceptanceProbeKind;
  source: "requires" | "command";
  /** Shell probe executed inside the acceptance sandbox. */
  command: string;
}

/** Shell keywords and builtins that must never be probed as external executables. */
const SHELL_WORDS = new Set([
  "!", ".", ":", "[", "[[", "]]", "{", "}", "(", ")",
  "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac",
  "function", "select", "time", "coproc", "in",
  "alias", "bg", "bind", "break", "builtin", "caller", "cd", "command", "compgen", "complete",
  "continue", "declare", "dirs", "disown", "echo", "enable", "eval", "exec", "exit", "export",
  "false", "fc", "fg", "getopts", "hash", "help", "history", "jobs", "kill", "let", "local",
  "logout", "mapfile", "popd", "printf", "pushd", "pwd", "read", "readarray", "readonly",
  "return", "set", "shift", "shopt", "source", "suspend", "test", "times", "trap", "true",
  "type", "typeset", "ulimit", "umask", "unalias", "unset", "wait",
  // Common wrappers whose own name resolving says nothing about the real command.
  "timeout", "env", "nohup", "nice", "ionice", "stdbuf", "sudo", "xargs",
]);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function probeFor(testId: string, target: string, source: AcceptanceProbe["source"]): AcceptanceProbe {
  const isPath = target.includes("/");
  const kind: AcceptanceProbeKind = isPath ? "executable-path" : "command";
  return {
    test_id: testId,
    target,
    kind,
    source,
    command: isPath
      ? `test -x ${shellQuote(target)}`
      : `command -v -- ${shellQuote(target)} >/dev/null 2>&1`,
  };
}

function isProbeableToken(token: string): boolean {
  if (token === "") return false;
  if (SHELL_WORDS.has(token)) return false;
  if (token.includes("=")) return false;
  if (/^["'$`#({]/.test(token)) return false;
  if (/[*?[\]~<>|&;]/.test(token)) return false;
  return true;
}

/**
 * Leading executable of a command line, skipping shell assignments, wrapper programs, and
 * prefix builtins such as `cd <dir>`. Returns `undefined` when the command is a shell construct
 * whose resolvability cannot be probed (compound shell syntax, builtins, pipelines of builtins).
 */
export function leadingExecutable(command: string): string | undefined {
  // Naive segment split: quotes are ignored, but a false positive only makes the probe stricter
  // (a declared tool is checked), which is preferable to missing an unrunnable gate.
  for (const segment of command.split(/&&|\|\||;|\||&/)) {
    const executable = segmentExecutable(segment);
    if (executable !== undefined) return executable;
  }
  return undefined;
}

/** Builtins whose operand should not be mistaken for the command that gets executed. */
const PREFIX_BUILTINS = new Set(["cd", "export", "set", "unset", "local", "declare", "readonly", "shift", "pushd", "popd"]);

/** Segment openers that never resolve an external executable themselves. */
const SEGMENT_NON_EXECUTABLES = new Set(["[[", "[", "test", "true", "false", "echo", "printf", "cd", "exit", "return", "if", "while", "until", "for", "case", "{", "("]);

function segmentExecutable(segment: string): string | undefined {
  const tokens = segment.trim().split(/\s+/).filter((token) => token !== "");
  const opener = tokens.find((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
  if (opener !== undefined && SEGMENT_NON_EXECUTABLES.has(opener)) return undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) return undefined;
    if (token.includes("=") && !token.startsWith("-") && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    if (PREFIX_BUILTINS.has(token)) return undefined;
    if (SHELL_WORDS.has(token)) {
      if (token === "timeout") {
        // `timeout 7200 bash ...`: skip the duration operand and keep looking.
        const next = tokens[index + 1];
        if (next !== undefined && /^[0-9]+[smhd]?$/.test(next)) index += 1;
      }
      continue;
    }
    if (token.startsWith("-")) continue;
    return isProbeableToken(token) ? token : undefined;
  }
  return undefined;
}

/**
 * Preflight probes for a phase contract.
 *
 * Explicit `requires` entries are always probed. Every other required self-test contributes an
 * implicit probe of its leading executable, which is what turns "command not found on every round"
 * into a single actionable pause before the executor is even started.
 */
export function planAcceptanceProbes(
  selfTests: readonly { id: string; command: string; required: boolean; requires?: string[] }[],
  options?: { maxProbes?: number },
): AcceptanceProbe[] {
  const maxProbes = options?.maxProbes ?? 24;
  const probes: AcceptanceProbe[] = [];
  const seen = new Set<string>();
  const push = (probe: AcceptanceProbe): void => {
    const key = `${probe.kind}:${probe.target}`;
    if (seen.has(key)) return;
    seen.add(key);
    probes.push(probe);
  };
  for (const test of selfTests) {
    if (!test.required) continue;
    for (const requirement of test.requires ?? []) {
      const target = requirement.trim();
      if (target !== "") push(probeFor(test.id, target, "requires"));
    }
    const executable = leadingExecutable(test.command);
    if (executable !== undefined) push(probeFor(test.id, executable, "command"));
    if (probes.length >= maxProbes) break;
  }
  return probes.slice(0, maxProbes);
}
