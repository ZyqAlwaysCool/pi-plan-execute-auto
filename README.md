# pi-plan-execute-auto

Pi-native phased planning, execution, independent review, acceptance, and phase-commit workflow.

The plugin keeps **Main Pi** as the planning partner. When the user decides the discussion is ready, `/plan-execute` turns the agreed plan into a phased execution/acceptance package, asks the human to review it, and starts automated execution only after **Approve & Start**.

## Workflow

### Planning & Approval

1. The user and Main Pi discuss the task normally for as many turns as needed.
2. The user explicitly runs `/plan-execute` when the plan is ready to be formalized.
3. Main Pi produces a validated package with ordered phases, phase specs, allowed paths, required self-tests, acceptance contracts, and phase commit messages.
4. The human reviews the package and chooses **Approve & Start**.

The AI cannot silently approve or start execution.

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

## Full native Agent CLI sessions

Built-in routes:

- `claude/<selector>`
- `codex/<model>`
- `opencode/<provider>/<model>`
- `pi/<provider>/<model>`

Executor and Reviewer are real independent ACP/CLI processes, not Main Pi subagents. The plugin preserves the selected CLI's normal model routing, gateway/provider environment, native user configuration, plugins/MCP/tool configuration, shell tools, and normal network access inside a private runtime copy.

For example, `claude/sonnet` means “use the Claude CLI and select its `sonnet` slot”. If the user's Claude configuration maps that slot to another gateway model, that native mapping remains valid.

The plugin does **not** disable Claude Agent/Task/WebSearch/WebFetch and does not force Claude Code's native Bash sandbox. It therefore does **not** require `socat` by itself. If your own Claude Code configuration enables its native Bash sandbox (for example `sandbox.enabled: true` or `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`), Claude Code may require `socat` on Linux/WSL; setup detects this condition and explains that it is a Claude Code dependency rather than a plugin dependency.

## Setup UX

Run:

```bash
/plan-execute setup
```

Setup performs an environment preflight before saving configuration:

- Git initialization is offered only if the directory is not already a repository (it still requires explicit consent); once at the repository root, setup creates or appends `.pi-plan-execute-auto/` in `.gitignore` when that directory is not already ignored. Existing ignore rules are preserved. Setup never stages or commits `.gitignore`: review and commit it yourself before **Approve & Start**, and keep generated package/config files out of Git;
- trusted Linux `bubblewrap` is available;
- unprivileged user namespaces work;
- installed Agent CLIs and their versions are shown; slow CLI/ACP model discovery, reasoning-level discovery, and connectivity probes show a live progress spinner in Pi (cleared on success or failure);
- Executor model and its advertised reasoning level are selected together, then Reviewer model and its own advertised reasoning level are selected (for example Executor `medium`, Reviewer `high`); each selection is rechecked at Stage B start;
- a live connectivity check is offered for each selected model/effort pair and is clearly marked as potentially billable;
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

- `PI_PLAN_EXECUTE_EXECUTOR_REASONING_EFFORT=low|medium|high|max` and `PI_PLAN_EXECUTE_REVIEWER_REASONING_EFFORT=low|medium|high|max` (independent, optional); legacy `PI_PLAN_EXECUTE_REASONING_EFFORT` applies to both roles and cannot be combined with per-role overrides
- `PI_PLAN_EXECUTE_PERMISSION_MODE=autonomous|ask`
- `PI_PLAN_EXECUTE_MAX_REVIEW_ROUNDS=1..100`

Interactive setup remains the normal workflow.

## Validation status

- **Codex/OpenCode:** real WSL validation on head `4768b81` passed Executor, Reviewer, and a complete one-phase workflow (**3/3**).
- **Pi:** real WSL validation on head `4768b81` passed Executor, Reviewer, and a complete one-phase workflow (**3/3**).
- **Claude:** the same pre-fix run reached **2/3**. The complete workflow failed when the plugin still forced `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, which made Claude Code require `socat` for Bash self-tests. That plugin-forced setting has now been removed. Claude must be rerun on the new head before **3/3** live validation is claimed; `socat` is only expected when the user's own Claude native sandbox configuration requires it.

Non-billable CI is necessary but does not replace a real provider-call test for the selected CLI/model/gateway.
