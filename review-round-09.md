# Review round 09 — historical note

This file records an earlier Claude relay hardening round.

That relay architecture has since been **superseded** by the full-native Agent CLI design. The earlier conclusions about requiring `socat`, forcing Claude command networking off, rejecting non-loopback HTTP gateway use, or requiring the plugin relay are no longer current requirements.

The security findings that remain generally useful are:

- do not trust project-provided executable replacements;
- keep run worktrees physically separate from the source worktree;
- keep Reviewer project access read-only;
- avoid mounting unrelated host HOME/system paths;
- validate immutable review/acceptance/commit evidence;
- fail closed when the required filesystem isolation provider is unavailable.

Current behavior and prerequisites are documented in `README.md` and `docs/claude-unified-access-assessment.md`.

For the current architecture, Claude/Codex/OpenCode/Pi are treated as complete native CLI sessions with normal tools/networking inside the common worktree/filesystem isolation boundary. Fresh live-provider validation is required after the redesign.
