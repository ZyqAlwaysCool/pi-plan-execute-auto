# Claude / unified Agent CLI integration assessment

## Current architecture

The current design treats Claude, Codex, OpenCode and Pi as **complete Agent CLI harnesses**.

A route such as `claude/sonnet` chooses the Claude CLI plus a Claude-native model selector. It does not require the underlying gateway model to be Anthropic-branded. Host CLI model aliases, custom gateways, MCP/plugin settings and other native CLI configuration are preserved in a run-private copy.

All four backends use the same high-level isolation contract:

- independent ACP/CLI process and session per actor;
- Executor worktree read/write;
- Reviewer worktree read-only;
- Golden plan/acceptance package read-only;
- private runtime HOME/tmp/config state;
- unrelated host files hidden;
- normal CLI/tool network access;
- native CLI configuration copied into the private runtime rather than mounting the host HOME.

Within a phase, the Executor session stays alive across REWORK rounds. Every Reviewer round receives a fresh independent CLI session. A new Executor session is created for the next phase.

## Claude-specific changes from the earlier relay design

The previous restricted Claude credential-relay architecture has been superseded.

The current architecture intentionally does **not**:

- disable Agent/Task/WebSearch/WebFetch;
- apply a Claude command no-network sandbox;
- require `socat`;
- require a loopback/HTTPS relay endpoint;
- replace the user's gateway/model mapping with plugin-specific model-family pinning.

Claude instead receives its normal Claude-specific provider/model environment plus a private copy of its configured CLI state. `CLAUDE_CONFIG_DIR` inside the sandbox points to that private copy, not the host directory.

This is consistent with the product goal: the Reviewer/Executor should behave like a newly opened normal Claude CLI session while still being contained to the workflow worktree and run-private host-state copy.

## Permission handling

Permissions are an orchestration choice rather than a tool-capability restriction.

- **Autonomous:** one-time allow options are automatically selected so the full CLI can continue unattended.
- **Ask me:** the ACP permission request is forwarded to Pi UI and the user chooses one of the exact options advertised by that CLI.

Both modes keep native CLI tools and networking available.

## Review-loop control

Setup chooses a per-phase review limit. Each Executor and Reviewer prompt receives:

- total review limit;
- rounds remaining including the current round;
- rounds remaining after the current round.

The intent is to make the finite budget explicit so Executor and Reviewer converge instead of drip-feeding changes/findings. Exhausting the budget pauses for the human rather than silently continuing.

## Remaining validation

Non-billable unit/sandbox CI can validate mount policy, configuration projection, permission routing and workflow evidence rules, but it cannot prove provider compatibility.

After this architecture change, fresh real-provider validation is required for each selected backend:

1. standalone Executor;
2. standalone Reviewer;
3. complete one-phase Execution & Review cycle with acceptance and plugin-owned phase commit.

Do not reuse the old Claude relay 0/3 or previous provider results as proof of the new native-session runtime.
