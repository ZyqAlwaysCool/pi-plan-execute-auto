# pi-plan-execute-auto

Pi-native phased planning, execution, independent review, acceptance, and phase-commit workflow.

The plugin keeps **Main Pi** as the planning partner. The user decides when planning is mature enough to formalize by running `/plan-execute`. The resulting phased plan stays editable until the human explicitly approves it; only then does automated Execution & Review begin.

## Workflow

### Planning & Approval

1. The user and Main Pi discuss the task normally for as many turns as needed.
2. The user explicitly runs `/plan-execute`.
3. Main Pi produces a validated draft package with ordered phases, phase specs, allowed paths, required self-tests, acceptance contracts, and phase commit messages.
4. The human can:
   - **Review Plan** — inspect the current draft;
   - **Request Changes** — describe revisions in an editor; Main Pi regenerates the complete draft package and the plugin validates it again;
   - **Approve & Start** — freeze the exact reviewed package hash and start execution;
   - **Cancel**.
5. Plan revision can repeat as many times as needed before approval. Previous draft revisions are retained under the run's `.runtime/planning/revisions/` directory. Draft creation/revision tools only write and validate the draft; the human **Plan Review & Approval** dialog is opened after the Main Pi turn finishes, so a tool call can never silently cross the `draft → frozen` boundary.

The AI cannot silently approve or start execution. A revision request is handled only by Main Pi in the Planning & Approval stage: it never creates an Executor/Reviewer session, never runs acceptance, never creates the execution worktree, and never modifies project deliverables. The Execution & Review controller also refuses to run while workflow state is still `draft`, providing a second hard boundary below the UI/tool layer.

Before **Approve & Start**, the plugin runs a readiness check. Normal fixable prerequisites—such as a dirty main worktree, missing Git baseline commit, unavailable isolation runtime, or a stale worktree path—do not turn the run into a failed/paused execution. The plan remains editable/retryable until the prerequisite is fixed.

### Execution & Review

For every phase:

1. A full independent **Executor Agent CLI session** implements the current phase and runs its required self-tests.
2. The plugin runs deterministic acceptance commands.
3. A fresh full independent **Reviewer Agent CLI session** inspects the implementation.
4. On `REWORK`, feedback returns to the **same Executor session** for that phase.
5. A new Reviewer session checks the next round.
6. On Reviewer `PASS`, the plugin reruns final acceptance and creates exactly one validated phase commit.
7. The next phase starts with a **new Executor session**.

Before any Executor turn on **every start/resume**, the plugin opens disposable sessions for **both roles**, verifies the OS boundary and exact advertised model/mode/reasoning configuration, then closes them without sending a prompt. This uses normal CLI networking/authentication but makes no model turn. A bounded configuration failure pauses at `stage: preflight` without consuming another review round or rerunning expensive acceptance. Preflight also checks that CLI initialization did not change project deliverables or Git history. Actual sessions repeat the same checks because runtime/catalog/auth state can change after preflight.

The process continues until all phases have development, self-test, independent review, final acceptance, and a phase commit.

Only integrity/execution failures that genuinely require human attention are persisted as `paused`—for example package/evidence tampering, worktree identity mismatch, broken completion evidence, or an execution process restart that would violate the same-session invariant. Ordinary start prerequisites remain retryable with `/plan-execute start <run-id>`.

Gitignored dependency and build artifacts (for example `node_modules/` and `dist/`) are outside the phase commit boundary. Executor installs/builds and deterministic acceptance may create or update them without pausing the run, and the Executor's ignored-tree summary is surfaced to the Reviewer as advisory evidence. Git history, branch refs, reflogs, unreachable objects, the index, and every Reviewer workspace byte (including ignored files) remain fail-closed. Symlinks stay fail-closed as well, with two narrow exceptions: `bin/python*` entries that resolve to an executable system interpreter in `/usr/bin`, `/usr/local/bin`, `/bin`, or `/opt/homebrew/bin` (standard virtualenv/uv layouts), and absolute links that resolve back inside the dedicated worktree (for example uv cache entries). Any other external target fails with `WORKSPACE_SYMLINK_ESCAPE`.

## Commands

The normal command surface is intentionally small:

```text
/plan-execute
/plan-execute setup
/plan-execute settings [run-id]
/plan-execute start <run-id>
/plan-execute resume <run-id>
/plan-execute stop <run-id>
/plan-execute status <run-id>
```

- `/plan-execute` formalizes the current planning discussion into a draft and opens Review & Approval.
- `setup` configures Executor/Reviewer CLI routes, reasoning levels, review limit, permission mode, and the whole-run execution timeout in one full wizard.
- `settings [run-id]` reopens only the individual settings as a menu, without repeating the whole wizard. With no run id it targets project defaults; with a run id it also syncs that frozen run's persisted settings so an explicit resume stays allowed. Model/effort changes apply to sessions created after the next resume; the timeout is operational and never invalidates a frozen run.
- `start <run-id>` reviews/approves a draft when needed, or retries an already-approved run whose start prerequisite has since been fixed.
- `resume <run-id>` rebuilds fresh Executor/Reviewer sessions from a persisted, resumable pause checkpoint. Repairable evidence pauses (currently `WORKSPACE_SYMLINK_ESCAPE`) re-verify the exact reported evidence before resuming and stay paused with a `workflow_repair_failed` event when it still fails. A `MAX_REVIEW_ROUNDS` pause becomes resumable after a human-approved settings change (`/plan-execute settings <run-id>`) raises `review_round_limit` above the rounds the phase already consumed; the plugin re-verifies the checkpoint, reopens the persisted pause without hand-edited state, and continues with the remaining rounds in the same run.
- `stop <run-id>` (or the `Ctrl+Shift+X` shortcut) requests a safe stop of an active execution and pauses without committing.
- `status <run-id>` shows a compact status summary plus the workflow-timeline path and latest Executor/Reviewer transcript paths. In interactive Pi it also offers previews of those diagnostic files.

`start` and `resume` run Execution & Review in the background instead of holding Pi's input loop, so chat, `/plan-execute status`, and the stop command/shortcut stay usable while a run is live. Stopping, timing out, or quitting Pi aborts the active harness and records a resumable pause (session shutdown gets a short bounded drain to persist it).

Structural validation, approval hashing, commit validation, and configuration integrity checks are automatic; they are not separate day-to-day commands.

## Run-local diagnostics

Each run is self-contained under:

```text
.pi-plan-execute-auto/<run-id>/
```

The directory contains the Golden Plan plus local diagnostic material under `.runtime/`. Copying the whole run directory is intended to provide enough context to diagnose most failures without scraping the main Pi UI.

Typical contents include:

```text
manifest.yaml
plan/...
.state.json
.runtime/
  events.jsonl
  main-pi-session.json
  sessions/
    executor/<session-id>.jsonl
    reviewer/<session-id>.jsonl
  planning/
    revisions/
      revision-001/package/...
  reports/...
  review-diffs/...
  final-diffs/...
  completions/...
```

Diagnostics are intentionally layered rather than capturing every ACP event. `.runtime/events.jsonl` is a **compact workflow timeline** only: plan revisions/review choices, approval, phase/round transitions, start blockers, and pause/completion state. Low-frequency initialization events (`agent_runtime_selected`, `agent_configuration_verified`, `agent_setup_failed`) record role, purpose (`preflight` or `execution`), configuration operation, and the actual Codex executable/version/adapter. These events exist even when initialization fails before a session ID or prompt. High-frequency agent internals do not duplicate into that global file.

`.runtime/main-pi-session.json` is also diagnostic rather than authoritative evidence. It stores only a bounded recent snapshot of the Main Pi branch (at most 120 compacted entries and 512 KiB), with source/retained entry counts and a truncation flag. Large strings, nested collections, and older entries are deliberately omitted instead of mirroring the entire conversation.

Each Executor/Reviewer session has a small transcript under `.runtime/sessions/executor/` or `.runtime/sessions/reviewer/`. A session transcript keeps only information useful for reconstruction: session start/close metadata, a prompt digest with bounded head/tail (the full prompt is reproducible from the frozen package plus persisted diffs and reports), human permission decisions (autonomous auto-approvals are not recorded), and the terminal turn's bounded text plus a digest and identity of its structured report. Raw thought/message chunks, usage-update streams, and other high-frequency ACP stream traffic are not persisted. Structured execution/review reports under `.runtime/reports/`, acceptance outputs, immutable diffs, and completion records remain the authoritative evidence. JSONL appends are serialized per file to prevent concurrent diagnostic writes from corrupting records.

Before diagnostic JSON is written, known host credential environment values and credential-shaped fields are redacted. The plugin does **not intentionally log provider credentials or copied authentication state** into the run diagnostics. This is defense in depth rather than a claim that arbitrary agent output can never contain sensitive project data: the bundle can contain source snippets, prompts, model/tool outputs, commands, and other project-sensitive material, so treat a copied run directory as sensitive debugging data.

The main UI is deliberately compact: the live widget keeps the run id, `N/M phases` progress, a full phase-name checklist (`✓` completed, `▶` current, `⏸` paused, `○` pending) with the current review round, the whole-run budget, the latest ACP activity (spinner + `evt/s`), and the latest status message, while detailed diagnostics live in the run directory. Each completed phase also appends a durable `Phase N/M … committed` entry to the session, so progress survives even when the live widget is missed. The pinned widget only exists while a run is actionable (running or paused); a completed or cancelled run releases it and leaves a chat summary with the run id, phase count, and branch, so the same Main Pi session stays clean for the next plan. A normal start blocker does not trigger an automatic Main Pi diagnostic turn.

## Full native Agent CLI sessions

Built-in routes:

- `claude/<selector>`
- `codex/<model>`
- `opencode/<provider>/<model>`
- `pi/<provider>/<model>`

Executor and Reviewer are real independent ACP/CLI processes, not Main Pi subagents. The plugin preserves the selected CLI's normal model routing, gateway/provider environment, native user configuration, plugins/MCP/tool configuration, shell tools, proxies, and normal network access inside a private runtime copy.

For example, `claude/sonnet` means “use the Claude CLI and select its `sonnet` slot”. If the user's Claude configuration maps that slot to another gateway model, that native mapping remains valid.

For Codex, the isolated session runs the host `codex` CLI's native app-server when a trusted install is found on `PATH`. The model catalog — including account-gated models — therefore matches the CLI you use interactively, and the setup "codex model" list is built from that catalog. The plugin mounts the resolved platform vendor tree read-only so Codex keeps its own bundled tools (for example `rg`). If the host CLI is missing, or its runtime tree fails provenance validation (for example a `codex` installed inside the sandboxed project tree), the isolated session keeps the Codex app-server bundled with the pinned ACP adapter instead. A `CODEX_PATH` value from your shell is never forwarded into the sandbox; when a host CLI is used, the plugin sets `CODEX_PATH` to its own verified read-only mount.

The authoritative `PATH` is the **running Pi process's environment**, which can differ from a newly opened terminal (for example an old npm global prefix ahead of NVM). The plugin preserves PATH priority; it never silently selects the newest installation or substitutes another model. Diagnostics include the exact mounted CLI path and version, host/bundled selection and fallback reason, ACP adapter version, and deduplicated PATH candidates. To fix a stale first installation, update/remove it or correct PATH and restart Pi.

Model selection is validated against the runtime's ACP **model config-option catalog**, not guessed from version numbers or legacy model+effort IDs. An unavailable model is rejected before sending the selection RPC, with the requested ID, available IDs, CLI identity and PATH advice. Backend errors retain the failing configuration operation rather than just `Invalid params`. The same validation is used by setup catalog/health checks, start/resume preflight, and actual execution.

The plugin does **not** disable Claude Agent/Task/WebSearch/WebFetch and does not force Claude Code's native Bash sandbox. It therefore does **not** require `socat` by itself. If your own Claude Code configuration enables its native Bash sandbox (for example `sandbox.enabled: true` or `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`), Claude Code may require `socat` on Linux/WSL; setup detects this condition and explains that it is a Claude Code dependency rather than a plugin dependency.

## Setup UX

Run:

```bash
/plan-execute setup
```

Setup is **project-scoped**, not Pi-session-scoped. A new Pi conversation in the same Git project automatically reuses the previously approved setup; you do not need to run setup again just because the conversation changed.

If `/plan-execute setup` is run again and the existing project setup is valid, the plugin first shows the current Executor/Reviewer routes, reasoning levels, review limit, permission mode, execution timeout, and approval time, then offers:

- **Keep current setup** — exits immediately without CLI discovery, model probing, provider calls, or config writes;
- **Run health check** — optionally sends the small potentially-billable READY probes through the currently saved routes; pass, failure, or skip never rewrites the saved setup;
- **Reconfigure** — warns about frozen-run compatibility and only then enters the full setup wizard;
- **Cancel** — leaves everything unchanged.

Reconfiguration changes the project default for future plans/runs. Existing approved runs keep their own frozen settings and never silently switch to the newly selected agents; a frozen run with mismatched settings must use a matching setup again or be replaced by a new run. The execution timeout is an operational policy rather than frozen provenance, so raising it takes effect the next time a paused run is started or resumed.

Setup performs an environment preflight before saving configuration:

- Git initialization is offered only if the directory is not already a repository and still requires explicit consent;
- plugin runtime/config is ignored through repository-local `.git/info/exclude`; setup does **not** create or modify project `.gitignore`, stage files, or create a project diff;
- a trusted platform-native isolation provider is available:
  - Linux/WSL: root-owned `bubblewrap` plus usable unprivileged user namespaces;
  - macOS: Apple's system `/usr/bin/sandbox-exec` Seatbelt launcher;
- the selected isolation provider passes its preflight before any Executor/Reviewer session can start;
- installed Agent CLIs and their versions are shown; slow CLI/ACP model discovery, reasoning-level discovery, and connectivity probes show a live progress spinner in Pi;
- Executor model/reasoning and Reviewer model/reasoning are chosen independently. The reasoning list is the model's **own advertised catalog**, discovered by ACP category (`thought_level`) rather than by a fixed option id, and shown cheapest to deepest. Current catalogs:

  | Backend | Effort option | Advertised levels (observed) |
  | --- | --- | --- |
  | `codex/*` | `reasoning_effort` | low, medium, high, xhigh, max, ultra |
  | `claude/*` | `effort` | default, low, medium, high, xhigh, max |
  | `opencode/*` | `effort` | default, high, max, non-think (model-specific) |
  | `pi/*` | `thinkingLevel` | off, minimal, low, medium, high, xhigh, max |

  The plugin no longer hardcodes `low/medium/high/max`, and it does not invent levels a runtime did not advertise. When the catalog already contains a literal `default` level (Claude, OpenCode), the dialog does not add a second, equivalent "backend default" entry;
- an optional live connectivity check is offered for each selected model/effort pair and is clearly marked as potentially billable; choosing **No** skips the check and setup still completes normally;
- if Claude is selected, the wizard checks whether the user's own Claude native Bash sandbox is enabled and conditionally verifies `socat`;
- review-loop limit and permission handling are explained and selected;
- the whole-run execution timeout is selected from 5 minutes, 15 minutes, 30 minutes (recommended default), a custom 1–1440 minute value, or no timeout at all;
- the final networking behavior is shown before consent is saved.

### Review-loop limit

The configured number is the maximum **Executor → Reviewer cycles per phase**. The remaining budget is injected into both agents every round so they can converge rather than defer work or findings until later rounds.

Default: **5 rounds per phase**.

The setup dialog offers the presets `3 / 5 / 8 / 12 / 20` plus **Custom…**, which accepts any whole number from **1 to 100** (`0` is rejected: a phase needs at least one executor round — bound unattended runs with the execution timeout instead). `/plan-execute settings <run-id>` uses the same dialog for a frozen run.

If the limit is exhausted without Reviewer `PASS`, the workflow pauses for the user instead of looping indefinitely. Raise the limit through `/plan-execute settings <run-id>` and run `/plan-execute resume <run-id>` to continue in the same run: the checkpoint is re-verified and the persisted round-limit pause is reopened for the remaining rounds.

### Agent permission handling

Two modes are available:

- **Autonomous** — keeps all CLI tools available, prefers a one-time allow option, and falls back to another CLI-advertised allow option when necessary. This is intended for trusted repositories and unattended execution.
- **Ask me** — keeps the same CLI capabilities but pauses on each ACP permission request and displays the exact options advertised by that CLI in Pi. The user's selected option ID is returned unchanged.

The selected permission mode and review limit are frozen into each approved run. Changing setup later cannot silently change an active/frozen run.

### Execution timeout

The execution timeout is the total Execution & Review budget for the whole run across every phase, including Executor, Reviewer, and acceptance work. The recommended default is **30 minutes**; setup also offers 5 minutes, 15 minutes, a custom 1–1440 minute value, and no timeout.

When the budget expires, the run pauses as a resumable `TIMEOUT` checkpoint instead of running unattended without a bound. Raising the timeout through a new human-approved `/plan-execute setup` takes effect for the next start or resume of a paused run; it is an operational resource policy and is not part of the frozen artifact provenance. Headless runs without a project profile can set `PI_PLAN_EXECUTE_STAGE_B_TIMEOUT_MS` explicitly (`0`, `none`, `unlimited`, or `off` mean no timeout).

Every pause is classified in the persisted state and the `workflow_paused` run event: `TIMEOUT`, `HUMAN_STOP`, `SESSION_ABORT`, `PROCESS_RESTART`, `HARNESS_ERROR`, evidence/safety failures, and so on, together with `stage`, `round`, and whether the checkpoint is resumable. Repairable evidence pauses advertise a repair-and-resume path instead of outright refusal; a verified repair records `workflow_repair_verified` and an `EVIDENCE_REPAIRED` resumable checkpoint. `/plan-execute status` and the Pi state entry show the code; the live widget also shows the remaining budget (`12m left`) so a timeout is visible before it fires.

### Acceptance command contract

Every phase acceptance self-test runs inside the same containment boundary as the agents — not in the host shell — with `cwd` set to the run's dedicated worktree. A gate that works in your terminal can still be unrunnable there, so the contract is documented instead of discovered:

- **Mounted read-write:** the dedicated per-run worktree (at its host absolute path).
- **Mounted read-only:** the run package directory (`.pi-plan-execute-auto/<run-id>`), the worktree's `.git` pointer into the run's Git metadata mirror, `/usr`, `/bin`, `/lib`, `/lib64`, `/sbin`, `/usr/local`, `/etc/ssl/certs`, `/etc/hosts`, `/etc/passwd`, the plugin runtime under `/agent-runtime`, and a mirror of the host `~/.local/bin` as `<runtime-home>/.local/bin`.
- **Mounted as private scratch:** `/tmp`.
- **Hidden:** the host project root, the host home directory, and every other host path.
- **PATH order:** `<runtime-home>/.local/bin`, `<runtime-home>/.cargo/bin`, `<runtime-home>/bin`, `/agent-runtime/node-bin`, `/usr/local/bin`, `/usr/bin`, `/bin`, `/usr/sbin`, `/sbin`.
- **Environment:** private `HOME`, `TMPDIR=/tmp`, cleared host credentials, normal network access.

Consequences for plan authors:

1. Prefer repository-relative tool paths (`./.cache/go-toolchain/bin/go test ...`) over bare host commands.
2. Declare every non-obvious tool in `self_tests[].requires`; the plugin probes each declared entry (and each command's leading executable) inside the real sandbox **before** the first executor round, and pauses with `ACCEPTANCE_ENVIRONMENT_MISSING` (resumable, with the mount list in the detail) instead of burning review rounds on `command not found`.
3. Give genuinely slow gates an explicit `self_tests[].timeout_ms`. The plugin budget defaults to **10 minutes per command** and is overridable globally.

```yaml
self_tests:
  - id: race
    command: bash scripts/test-agent.sh race
    required: true
    timeout_ms: 900000      # 15 minutes; integers only, 5s..2h
    requires:               # sandbox PATH command names or relative/absolute paths
      - bash
      - ./.cache/go-toolchain/bin/go
```

Both new fields are optional, so packages frozen by earlier plugin versions keep validating and resuming unchanged.

A command killed by its budget is reported as `timed_out: true` with the effective `timeout_ms`, never as an anonymous signal death. If the same structural acceptance failure (same failing tests, same exit codes/timeouts) repeats `PI_PLAN_EXECUTE_ACCEPTANCE_REPEAT_LIMIT` times (default **3**), the run pauses as a resumable `ACCEPTANCE_BLOCKED_REPEAT` instead of spending its remaining rounds on an outcome the executor cannot change.

## Isolation model

The common `IsolationProvider` is platform-native. Linux/WSL uses `bubblewrap`; macOS uses Apple's Seatbelt policy through the system-owned `/usr/bin/sandbox-exec`. Its job is **containment**, not capability reduction.

Both providers fail closed: if the trusted OS sandbox is unavailable or the boundary self-test fails, Execution & Review does not start. The macOS `sandbox-exec` command is deprecated by Apple, so it is treated as an implementation detail rather than a permanent API contract; the provider validates the system binary and actual read/write boundary on every execution path instead of silently falling back to unsandboxed agents.

It provides:

- a run-scoped dedicated branch/worktree;
- Executor project access as read/write;
- Reviewer project access as read-only;
- Golden plan/acceptance files as read-only;
- a read-only Git metadata mirror of the run's own history (planning baseline through the current phase base) for agent and acceptance commands, never the shared host Git directory or unrelated pre-run history;
- a private runtime HOME/tmp/config copy instead of exposing the host HOME directly;
- native Agent CLI state copied into run-private scratch;
- unrelated host files/directories hidden;
- trusted system/runtime binaries mounted read-only;
- normal Agent CLI and acceptance-command networking.

Acceptance commands use the same filesystem/worktree boundary and normal networking, so integration tests that need localhost or external services are not artificially broken.

The plugin-owned phase commit is cross-checked against the phase base, expected commit subject/evidence, Reviewer-approved diff hash, final acceptance evidence, and completion record.

## Requirements

Supported hosts:

- Linux / WSL
- macOS
- Node.js 22+
- Git
- whichever Agent CLIs you plan to select

Linux/WSL additionally requires `bubblewrap` and usable unprivileged user namespaces:

```bash
sudo apt-get update
sudo apt-get install -y bubblewrap

which bwrap
unshare -Ur true
```

macOS uses the system Seatbelt launcher and does not require Homebrew or a third-party sandbox package:

```bash
test -x /usr/bin/sandbox-exec
/usr/bin/sandbox-exec -p '(version 1) (allow default)' /usr/bin/true
```

The macOS provider uses a default-deny Seatbelt profile, keeps the dedicated Executor worktree writable, mounts no host filesystem root, keeps the Reviewer worktree and Golden Package read-only, uses a run-private HOME/tmp/config area, exposes only required system/runtime paths, and preserves normal Agent CLI networking. If a future macOS release removes or disables `sandbox-exec`, the plugin fails closed until another macOS provider is available.

No extra firewall, proxy, provider-specific daemon, or `socat` is required by this plugin itself.

Claude-specific exception: if **your own Claude Code settings** enable Claude's native Bash sandbox, Linux/WSL Claude Code may require `socat`. In that case setup reports the exact reason and you can install it with:

```bash
sudo apt-get install -y socat
```

On macOS this Linux-specific `socat` preflight is not applied. The plugin does not enable Claude's native sandbox on your behalf.

## Development validation

Common checks:

```bash
npm ci
npm run check
npm run build
npm test
```

Linux/WSL sandbox gate:

```bash
npm run test:sandbox:required
```

macOS sandbox gate:

```bash
npm run test:sandbox:macos:required
```

GitHub Actions runs both OS-specific sandbox gates on their native hosts.

The real configuration-only gate opens both native roles and checks an unavailable-model failure, without sending a model prompt. It requires explicit network consent, disposable fixture directories and your normal CLI authentication:

```bash
PI_PLAN_EXECUTE_ACCEPT_ACP_NETWORK_RISK=1 \
PI_PLAN_EXECUTE_ACP_TEST_EXECUTOR_MODEL=pi/<provider>/<model> \
PI_PLAN_EXECUTE_ACP_TEST_REVIEWER_MODEL=codex/<model> \
PI_PLAN_EXECUTE_ACP_TEST_PATH="$PATH" \
npm run test:acp:preflight:required
```

`PI_PLAN_EXECUTE_ACP_TEST_PATH` is a test-only override to retain the caller's PATH: `npm run` otherwise prepends `node_modules/.bin`, which can itself contain an older transitive Codex install. Production runtime selection never rewrites PATH.

Real provider **turn** validation is intentionally separate because it can incur charges:

```bash
# OpenCode Executor + Codex Reviewer
PI_PLAN_EXECUTE_ACCEPT_ACP_NETWORK_RISK=1 \
PI_PLAN_EXECUTE_ACP_TEST_EXECUTOR_MODEL=opencode/<provider>/<model> \
PI_PLAN_EXECUTE_ACP_TEST_REVIEWER_MODEL=codex/<model> \
npm run test:acp:required

# Claude
PI_PLAN_EXECUTE_ACCEPT_ACP_NETWORK_RISK=1 \
PI_PLAN_EXECUTE_ACP_TEST_CLAUDE_MODEL=claude/<selector> \
npm run test:acp:claude:required

# Pi
PI_PLAN_EXECUTE_ACCEPT_ACP_NETWORK_RISK=1 \
PI_PLAN_EXECUTE_ACP_TEST_PI_MODEL=pi/<provider>/<model> \
npm run test:acp:pi:required
```

Headless execution can additionally set:

- `PI_PLAN_EXECUTE_EXECUTOR_REASONING_EFFORT=<label>` and `PI_PLAN_EXECUTE_REVIEWER_REASONING_EFFORT=<label>` (independent, optional); legacy `PI_PLAN_EXECUTE_REASONING_EFFORT` applies to both roles and cannot be combined with per-role overrides. `<label>` is any level the selected model advertises (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra` on current Codex builds). A label the runtime does not advertise is refused at start/resume preflight rather than downgraded;
- `PI_PLAN_EXECUTE_PERMISSION_MODE=autonomous|ask`;
- `PI_PLAN_EXECUTE_MAX_REVIEW_ROUNDS=1..100`;
- `PI_PLAN_EXECUTE_ACCEPTANCE_TIMEOUT_MS=<milliseconds>` — default per-command acceptance budget (default 600000, clamped to 5000..7200000). Contract-level `self_tests[].timeout_ms` wins for that test;
- `PI_PLAN_EXECUTE_ACCEPTANCE_REPEAT_LIMIT=1..20` — consecutive identical structural acceptance failures tolerated before a resumable `ACCEPTANCE_BLOCKED_REPEAT` pause (default 3; `1` disables the guard).

Interactive setup remains the normal workflow.

Non-billable CI is necessary but does not replace a real provider-call test for the selected CLI/model/gateway. Real provider gates may incur charges; rerun them on the current head before relying on earlier validation results.
