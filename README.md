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

The process continues until all phases have development, self-test, independent review, final acceptance, and a phase commit.

Only integrity/execution failures that genuinely require human attention are persisted as `paused`—for example package/evidence tampering, worktree identity mismatch, broken completion evidence, or an execution process restart that would violate the same-session invariant. Ordinary start prerequisites remain retryable with `/plan-execute start <run-id>`.

## Commands

The normal command surface is intentionally small:

```text
/plan-execute
/plan-execute setup
/plan-execute start <run-id>
/plan-execute stop <run-id>
/plan-execute status <run-id>
```

- `/plan-execute` formalizes the current planning discussion into a draft and opens Review & Approval.
- `setup` configures Executor/Reviewer CLI routes, reasoning levels, review limit, and permission mode.
- `start <run-id>` reviews/approves a draft when needed, or retries an already-approved run whose start prerequisite has since been fixed.
- `stop <run-id>` requests a safe stop of an active execution.
- `status <run-id>` shows a compact status summary plus the workflow-timeline path and latest Executor/Reviewer transcript paths. In interactive Pi it also offers previews of those diagnostic files.

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
  diffs/...
  completions/...
```

Diagnostics are intentionally layered rather than capturing every ACP event. `.runtime/events.jsonl` is a **compact workflow timeline** only: plan revisions/review choices, approval, phase/round transitions, start blockers, and pause/completion state. Agent internals do not duplicate into that global file.

`.runtime/main-pi-session.json` is also diagnostic rather than authoritative evidence. It stores only a bounded recent snapshot of the Main Pi branch (at most 120 compacted entries and 512 KiB), with source/retained entry counts and a truncation flag. Large strings, nested collections, and older entries are deliberately omitted instead of mirroring the entire conversation.

Each Executor/Reviewer session has a small transcript under `.runtime/sessions/executor/` or `.runtime/sessions/reviewer/`. A session transcript keeps only information useful for reconstruction: session start/close metadata, the plugin prompt for each turn, permission decisions, and the final terminal/structured turn with aggregate event counts. Raw thought/message chunks, usage-update streams, and other high-frequency ACP stream traffic are not persisted. Structured execution/review reports, acceptance outputs, immutable diffs, and completion records remain the authoritative evidence. JSONL appends are serialized per file to prevent concurrent diagnostic writes from corrupting records.

Before diagnostic JSON is written, known host credential environment values and credential-shaped fields are redacted. The plugin does **not intentionally log provider credentials or copied authentication state** into the run diagnostics. This is defense in depth rather than a claim that arbitrary agent output can never contain sensitive project data: the bundle can contain source snippets, prompts, model/tool outputs, commands, and other project-sensitive material, so treat a copied run directory as sensitive debugging data.

The main UI is deliberately compact: current run/phase/round and high-level state stay visible, while detailed diagnostics live in the run directory. A normal start blocker does not trigger an automatic Main Pi diagnostic turn.

## Full native Agent CLI sessions

Built-in routes:

- `claude/<selector>`
- `codex/<model>`
- `opencode/<provider>/<model>`
- `pi/<provider>/<model>`

Executor and Reviewer are real independent ACP/CLI processes, not Main Pi subagents. The plugin preserves the selected CLI's normal model routing, gateway/provider environment, native user configuration, plugins/MCP/tool configuration, shell tools, proxies, and normal network access inside a private runtime copy.

For example, `claude/sonnet` means “use the Claude CLI and select its `sonnet` slot”. If the user's Claude configuration maps that slot to another gateway model, that native mapping remains valid.

The plugin does **not** disable Claude Agent/Task/WebSearch/WebFetch and does not force Claude Code's native Bash sandbox. It therefore does **not** require `socat` by itself. If your own Claude Code configuration enables its native Bash sandbox (for example `sandbox.enabled: true` or `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`), Claude Code may require `socat` on Linux/WSL; setup detects this condition and explains that it is a Claude Code dependency rather than a plugin dependency.

## Setup UX

Run:

```bash
/plan-execute setup
```

Setup is **project-scoped**, not Pi-session-scoped. A new Pi conversation in the same Git project automatically reuses the previously approved setup; you do not need to run setup again just because the conversation changed.

If `/plan-execute setup` is run again and the existing project setup is valid, the plugin first shows the current Executor/Reviewer routes, reasoning levels, review limit, permission mode, and approval time, then offers:

- **Keep current setup** — exits immediately without CLI discovery, model probing, provider calls, or config writes;
- **Run health check** — optionally sends the small potentially-billable READY probes through the currently saved routes; pass, failure, or skip never rewrites the saved setup;
- **Reconfigure** — warns about frozen-run compatibility and only then enters the full setup wizard;
- **Cancel** — leaves everything unchanged.

Reconfiguration changes the project default for future plans/runs. Existing approved runs keep their own frozen settings and never silently switch to the newly selected agents; a frozen run with mismatched settings must use a matching setup again or be replaced by a new run.

Setup performs an environment preflight before saving configuration:

- Git initialization is offered only if the directory is not already a repository and still requires explicit consent;
- plugin runtime/config is ignored through repository-local `.git/info/exclude`; setup does **not** create or modify project `.gitignore`, stage files, or create a project diff;
- trusted Linux `bubblewrap` is available;
- unprivileged user namespaces work;
- installed Agent CLIs and their versions are shown; slow CLI/ACP model discovery, reasoning-level discovery, and connectivity probes show a live progress spinner in Pi;
- Executor model/reasoning and Reviewer model/reasoning are chosen independently;
- an optional live connectivity check is offered for each selected model/effort pair and is clearly marked as potentially billable; choosing **No** skips the check and setup still completes normally;
- if Claude is selected, the wizard checks whether the user's own Claude native Bash sandbox is enabled and conditionally verifies `socat`;
- review-loop limit and permission handling are explained and selected;
- the final networking behavior is shown before consent is saved.

### Review-loop limit

The configured number is the maximum **Executor → Reviewer cycles per phase**. The remaining budget is injected into both agents every round so they can converge rather than defer work or findings until later rounds.

Default: **5 rounds per phase**.

If the limit is exhausted without Reviewer `PASS`, the workflow pauses for the user instead of looping indefinitely.

### Agent permission handling

Two modes are available:

- **Autonomous** — keeps all CLI tools available, prefers a one-time allow option, and falls back to another CLI-advertised allow option when necessary. This is intended for trusted repositories and unattended execution.
- **Ask me** — keeps the same CLI capabilities but pauses on each ACP permission request and displays the exact options advertised by that CLI in Pi. The user's selected option ID is returned unchanged.

The selected permission mode and review limit are frozen into each approved run. Changing setup later cannot silently change an active/frozen run.

## Isolation model

The common `IsolationProvider` currently has a Linux bubblewrap implementation. Its job is **containment**, not capability reduction.

It provides:

- a run-scoped dedicated branch/worktree;
- Executor project access as read/write;
- Reviewer project access as read-only;
- Golden plan/acceptance files as read-only;
- a private runtime HOME/tmp/config copy instead of exposing the host HOME directly;
- native Agent CLI state copied into run-private scratch;
- unrelated host files/directories hidden;
- trusted system/runtime binaries mounted read-only;
- normal Agent CLI and acceptance-command networking.

Acceptance commands use the same filesystem/worktree boundary and normal networking, so integration tests that need localhost or external services are not artificially broken.

The plugin-owned phase commit is cross-checked against the phase base, expected commit subject/evidence, Reviewer-approved diff hash, final acceptance evidence, and completion record.

## Requirements

Linux or WSL with:

- Node.js 22+
- Git
- `bubblewrap`
- whichever Agent CLIs you plan to select

Ubuntu/WSL:

```bash
sudo apt-get update
sudo apt-get install -y bubblewrap

which bwrap
unshare -Ur true
```

No extra firewall, proxy, provider-specific daemon, or `socat` is required by this plugin itself.

Claude-specific exception: if **your own Claude Code settings** enable Claude's native Bash sandbox, Linux/WSL Claude Code may require `socat`. In that case setup reports the exact reason and you can install it with:

```bash
sudo apt-get install -y socat
```

Installing `socat` in that case preserves your chosen native Claude behavior; the plugin does not enable that sandbox on your behalf.

## Development validation

```bash
npm ci
npm run check
npm run build
npm run test:sandbox:required
npm test
```

Real provider validation is intentionally separate because it can incur charges:

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

- `PI_PLAN_EXECUTE_EXECUTOR_REASONING_EFFORT=low|medium|high|max` and `PI_PLAN_EXECUTE_REVIEWER_REASONING_EFFORT=low|medium|high|max` (independent, optional); legacy `PI_PLAN_EXECUTE_REASONING_EFFORT` applies to both roles and cannot be combined with per-role overrides;
- `PI_PLAN_EXECUTE_PERMISSION_MODE=autonomous|ask`;
- `PI_PLAN_EXECUTE_MAX_REVIEW_ROUNDS=1..100`.

Interactive setup remains the normal workflow.

## Validation status

The native-session architecture previously passed real WSL validation for OpenCode Executor + Codex Reviewer (**3/3**) and Pi (**3/3**). Claude reached **2/3** before the plugin-forced Claude inner-sandbox issue was removed. After workflow/UX changes, rerun real provider gates on the current head before treating earlier provider results as validation of the new head.

Non-billable CI is necessary but does not replace a real provider-call test for the selected CLI/model/gateway.
