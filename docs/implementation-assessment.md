# Implementation assessment

## 1. Overall

**Conditionally feasible, implemented as an opt-in Pi package.**

The deterministic Stage A contract and the phase policy/commit boundary are local code. Agent runtime, ACP transport, structured output, and same-session turns are delegated to `@automatalabs/workflows` / `AcpAgent`.

## 2. Pi Extension API

Used directly:

- `registerTool()` with `promptSnippet` and `promptGuidelines` for Main Pi awareness;
- `registerCommand()` for `/plan-execute finalize`, validation, approval, start, stop, and status;
- `sendUserMessage()` to route the slash command back into the current Main Pi session;
- `ctx.ui.select()`, `notify()`, `setWidget()` for native approval and status projection;
- `appendEntry()` for TUI-only state and escalation evidence;
- `sendMessage()` for a bounded structured pause escalation to the same Main Pi session;
- `registerEntryRenderer()` / `registerMessageRenderer()` for persisted status cards;
- `pi.exec()` for Git and acceptance commands.

The command/tool path does not create a second planner session. In non-UI modes finalization returns `awaiting_approval`; it never silently freezes.

## 3. AgentPrism

`@automatalabs/workflows@7.0.1` is a runtime dependency. The implementation reuses its `AcpAgent` lower-level API and TypeBox structured-output/repair path. No ACP client, vendor parser, generic state-machine engine, permission protocol, or generic retry engine was added.

`gate()` is not used for the executor/reviewer loop because the required same-executor-session behavior is not safe to assume from the public gate contract.

## 4. Same-session REWORK

`AgentPrismSessionPair` constructs one persistent Executor `AcpAgent` and consumes `stream()` turns; REWORK calls another turn on that same instance. Every Reviewer round constructs a fresh independent `AcpAgent` with fail-closed permissions. The controller verifies structured reports and uses `phase_id`, `round`, and `base_commit` as policy keys. A persisted running/partially-running state is reconciled only from complete immutable evidence or escalated fail-closed after process restart.

## 5. `pi-harness-delegate`

No local `pi-harness-delegate` source was present in this checkout, and it is not a dependency. Its useful concerns remain intentionally outside the runtime layer: permission vocabulary, detection/UX, cancel/transcript conventions, and normalized harness presentation. AgentPrism owns actual ACP execution here.

## 6. Minimum original implementation

- Golden Package writer and YAML structural validator;
- human freeze handoff and Pi-native status projection;
- acceptance contract runner;
- phase-scoped report policy;
- Git precondition checks and plugin-owned commit boundary;
- bounded Main Pi escalation with finding/session/report evidence;
- dedicated branch/worktree preparation and identity checks;
- immutable phase completion records and final diff evidence;
- fail-closed Reviewer workspace snapshots;
- thin AgentPrism session adapter with live-event projection and cancellation.

## 7. Directory structure

```text
extensions/index.ts          Pi entrypoint
src/package-validator.ts     manifest/acceptance/path/hash validation
src/workflow-state.ts        freeze/status state
src/agent-prism.ts           AcpAgent adapter
src/sandbox.ts               bubblewrap backend launcher and filesystem probes
src/stage-b.ts               ordered phase loop and commit policy
src/git.ts                   argv-based Git policy adapter
src/acceptance.ts            deterministic self-test reruns
src/reports.ts               structured report validation
src/glob.ts                  allowed-path matching
src/types.ts                 simple contracts
tests/                       validator and Stage B policy tests
```

## 8. Minimal PoC / self-test

The tests use real temporary Git repositories and a fake `HarnessPair`:

- a green phase creates exactly one plugin-owned commit plus completion-record payload, report, and final-diff hashes bound by immutable Git commit evidence trailers;
- forged identity-only completion records, extra/mismatched acceptance evidence, synchronized fake diffs, and unanchored recovery records are rejected or safely reconciled;
- all ignored/untracked workspace file bytes (including regular files inside `node_modules`) and unreachable Git objects are included in actor-boundary evidence; dependency content hashes are cached by inode/size/mtime/ctime, and symlink escapes fail closed;
- Executor/Reviewer/acceptance commit→reset history mutations pause without a plugin commit;
- bubblewrap integration probes exercise Reviewer write denial, Executor/acceptance worktree writes, Golden Package denial, source-tree symlink denial, and host-home/other-project/tmp canaries; the sandbox root is tmpfs rather than a read-only bind of host `/`;
- Codex/OpenCode ACP routes and acceptance shells use the same filesystem sandbox. The host Git directory is not exposed; each sandbox gets a read-only shallow mirror containing only the phase base commit and its tree, allowing Reviewer `git diff` without shared refs/history/index. The full canonical Reviewer patch is also staged read-only under Golden Package runtime with a prompt hash;
- a real temporary-repository test verifies that the mirror reproduces `git diff <base>` while excluding earlier commit objects; a real-shell acceptance escape probe is included in the bwrap integration test;
- ACP environment is cleared and rebuilt, host provider `auth.json` is copied to private run scratch for ACP startup and removed before the first turn, and untrusted/custom bwrap or ACP command overrides fail closed;
- dependency provisioning cancellation and timeout interrupt streaming copies of a single large file and remove the temporary destination;
- Executor required self-test omissions cannot reach Reviewer/commit;
- REWORK calls the same executor abstraction and fresh Reviewer prompts include previous findings even with oversized sections;
- dedicated branch/worktree identity, canonical multi-file/binary diff evidence, bounded/cancellable provisioning, cancellation, max review rounds, run-id traversal, freeze TOCTOU, completion/report tamper, multi-phase evidence protection, malformed package, phase ordering, acceptance mismatch, ignored build paths, symlink topology, and Golden hash exclusion are tested.

Round 07 local validation (after acceptance-shell isolation and read-only Git mirror changes):

```text
npm run check   PASS
npm test        45 PASS, 2 SKIP (no trusted system bwrap installed)
npm run build   PASS
PI_OFFLINE=1 pi -p --no-session -e ./extensions/index.ts "Reply with exactly OK"   PASS
```

The two skipped tests are the sandbox-config/mount probe and the actual Reviewer/Executor/acceptance bwrap probe. `npm run test:sandbox:required` sets `PI_PLAN_EXECUTE_REQUIRE_BWRAP_TESTS=1`; in that mode these cases cannot silently skip and absence of trusted bwrap is a hard test failure. Run this target in a Linux namespace-enabled security CI. `PI_PLAN_EXECUTE_BWRAP` no longer accepts downloaded or user-owned binaries; it must resolve to a root-owned non-writable `/usr/bin/bwrap` or `/usr/local/bin/bwrap`. The fake-executable regression test and unwrapped read-only Git-mirror unit test pass independently. No live Codex/OpenCode provider request, real acceptance shell under bwrap, or real Stage B run was made; the local environment cannot establish the OS namespace or ACP provider integration.

**Round 07 acceptance escape fix:** the production extension now executes each required acceptance shell inside the same fail-closed bubblewrap filesystem policy as the ACP actors, with only the dedicated worktree writable and Golden Package read-only. A real-shell source/sibling/Golden/host-`/tmp` escape probe is part of the bwrap integration test, but was skipped locally because no trusted system bwrap is installed; therefore the fix is code-reviewed/unit-covered but not OS-integration-validated, and this round must not be called PASS yet.

**Round 07 remaining limitation (historical):** ACP processes and acceptance shells shared the host network namespace; real OS/provider integration and process-level crash injection had not been run.

After the round-08 follow-up, acceptance shells request a new network namespace (`--unshare-net`); the mount/host-TCP regression is mandatory in `.github/workflows/security-sandbox.yml` and skips only in local `npm test` without trusted bwrap. ACP still requires host networking for providers, so it **fails closed by default** unless an operator explicitly acknowledges `PI_PLAN_EXECUTE_ACCEPT_ACP_NETWORK_RISK=1` for a non-sensitive project; this does **not** isolate ACP egress. `npm run test:acp:required` is an opt-in, billable real OpenCode/Codex structured-report test and fails if configured prerequisites are absent. Six real-process `SIGKILL` cases (single/second phase × commit/record/state windows) now validate restart evidence; a commit without its record cannot be accepted as complete. At that point local `npm run check`, `npm run build`, `npm test` passed (**48 pass, 2 skip**); `npm run test:sandbox:required` could not run before a trusted bwrap installation.

After installing root-owned `/usr/bin/bwrap`, the required tests exposed two real mount-policy defects: Bubblewrap bind sources must use the host scratch path for the `.git` pointer, and synthetic parent directories must be remounted read-only to prevent writes through source-path symlinks. Both were fixed and the required sandbox suite now passes **7/7 without skips** (including actual Git diff from the readonly Reviewer mount and acceptance host-TCP rejection). `npm run check`, `npm run build`, `npm test` pass (**50/50, 0 skip**). Real Codex `gpt-6-luna` Reviewer with verified `high` reasoning completed a structured PASS and left the worktree unchanged after switching permission requests to one-shot grants within the enforced readonly OS sandbox. The initially requested OpenCode `deepseek/deepseek-v4.1-flash` was independently rejected by the installed ACP backend (`model not found`), including after `opencode models deepseek --refresh`. ACP network egress is still unrestricted when explicitly opted in on a non-sensitive fixture.

**Live follow-up using the user's selected `deepseek-local/deepseek-flash`:** host `opencode models` listed this custom provider, but isolated ACP initially rejected it because the host user config was intentionally absent. Only the selected provider/model JSONC definition is now staged in private OpenCode config, and both this file and copied auth are deleted before the first turn. Tests verify unrelated provider keys are excluded and the staged credential files are removed. Real ACP OpenCode Executor and Codex `gpt-6-luna` Reviewer both passed with verified `high` reasoning; a real single-phase Stage B run independently ran sandboxed acceptance, obtained Reviewer PASS, created its phase commit, reloaded verified completion evidence, and left the source worktree unchanged. Current verification: `npm run check`, `npm run build`, `npm test` (**51/51, zero skipped**), `npm run test:sandbox:required` (**8/8, zero skipped**), and `npm run test:acp:required` with `opencode/deepseek-local/deepseek-flash` + `codex/gpt-6-luna` (**3/3, zero skipped**). Following the interactive-setup change, the installed local Pi package was smoke-tested with `pi install -l` and `pi list` in a temporary Git repository. `/plan-execute setup` now discovers available CLIs and model candidates for both OpenCode (CLI) and Codex (isolated read-only ACP catalog session, following preliminary network-risk consent), collects separate final human network-risk consent, stores a no-secret per-repository profile under the Pi agent directory, and freezes the selected models/reasoning for each run. `/plan-execute` without arguments initiates finalization; the Golden Package still requires human approval. Wizard dialogs (including pre-discovery denial and explicit manual fallback), persistence, repo replacement, model-supplied override rejection, and headless fallback are covered by independent tests. A real Codex ACP catalog probe under the synthetic sandbox returned 7 advertised choices, including `codex/gpt-6-luna`, using only a disposable fixture repository and without a model turn. Repository setup now offers explicit in-Pi `git init` when no repository exists, with a separately approved empty baseline commit and no automatic staging of user files. A nested directory or unsafe `.git` entry is refused; UI decline, empty-commit safety, staged-file preservation, and hostile Git environment overrides have independent tests. Latest local validation after four-backend discovery and project configuration cache: `npm run check`, `npm run build`, `npm test` (**71/71, zero skipped**), `npm run test:sandbox:required` (**9/9, zero skipped**). Codex/OpenCode real ACP tests were **3/3** at that point; the earlier Claude/Pi real model-turn tests were **0/4**. Subsequent proxy and Codex inner-sandbox fixes changed the current results: see `docs/v2-validation.md` (Pi 3/3, Claude 0/3, Codex/OpenCode 3/3). Neither ACP catalog availability nor shell filesystem tests can count as provider integration success. The earlier **3/3 live ACP** tests validated the same sandboxed backends and a single-phase Controller; the new user-facing Pi wizard has not yet been exercised by a human in a fresh repository. Neither these tests nor the explicit network-risk acknowledgement implement provider-only ACP network egress; do not treat this as sensitive-repository approval.

## 9. Duplicate infrastructure deliberately omitted

There is no custom ACP implementation, CLI JSONL parser, vendor session manager, generic workflow DSL, permission parser, or SQLite/event-sourcing layer. `.state.json` records only the business-level phase completion evidence; `.runtime/reports` stores the required reports and is excluded from Golden hashes and phase commits.

## 10. Phase commit boundary

The plugin is the sole commit owner. Stage B first creates/verifies a clean run-scoped branch/worktree and runs all actors and acceptance there. Before and after every harness/acceptance call it records and checks HEAD, branch refs, reflog, and index. Before committing it checks:

1. Reviewer verdict is `PASS` and has no blocking findings;
2. required acceptance commands pass again;
3. Golden Package hash is unchanged;
4. `HEAD` still equals the phase base commit;
5. no harness-staged changes exist;
6. all changed paths match the current phase contract;
7. runtime artifacts are excluded;
8. empty commits are allowed only by explicit `commit.allow_empty`;
9. final binary diff evidence is written and hashed before commit;
10. the commit message contains immutable hashes for execution/review/acceptance reports and reviewed/final diff; after commit, an exclusive completion record is written with commit SHA, timestamp, reports, acceptance results, Golden hash, and final diff hash.

A host-side reviewer snapshot includes HEAD, branch refs, reflog, unreachable Git objects, status, all ignored/untracked file names and bytes (including provisioned dependency roots), index, tracked binary diff, and changed-file bytes; unchanged file digests are cached only while inode/size/mtime/ctime remain stable. Reviewer sessions are launched with bubblewrap and their write-denial/host-canary probe runs before each session. The sandbox starts from a private rootfs, exposes only the dedicated worktree, Golden Package, runtime dependencies, and scratch, and grants Executor persistent project writes only to its disjoint worktree; private rootfs/scratch writes are per-run. Host home/source/Git paths are absent rather than mounted read-only. Only Codex/OpenCode model routes are accepted. Harness history/workspace/index changes, commit failures, Golden changes, cancellation/timeouts, and loop exhaustion pause without reset or history rewriting. Completion records validate all report/diff/acceptance bytes and hashes; prior phase evidence is revalidated before later phases and before workflow completion. A completion record and workflow state commit SHA are persisted before the next phase is entered.
