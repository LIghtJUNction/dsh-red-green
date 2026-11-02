# Upstream and migration

- Project: [MattDevy/pi-extensions, packages/pi-red-green](https://github.com/MattDevy/pi-extensions/tree/86cbbbb1d65eeca88ce2f820dd958301625e394c/packages/pi-red-green).
- Examined repository commit: `86cbbbb1d65eeca88ce2f820dd958301625e394c`.
- License: MIT, Copyright (c) 2026 Matt Devy. Full attribution/license: [NOTICE](NOTICE).
- Read real upstream `src/index.ts`, `state-machine.ts`, `types.ts`, `tdd-tools.ts`, and `tdd-injector.ts` through pinned GitHub raw/API sources before implementation.

This is an independent DSH implementation of the RED → GREEN → REFACTOR → COMPLETE workflow, not a Pi API adapter. It replaces Pi session/tool events and `/tdd` commands with Schemastery config, actual DSH `defineTool` output contracts, a ToolRuntime guard, and per-agent/workspace in-memory cycles.

DSH `tdd_start` requires explicit user-request acknowledgment and current revision. Instead of trusting parsed tool result strings or manual phase advancement, `tdd_run` runs fixed host-local argv, records content fingerprints and exit/output evidence, and locks the tests after RED. Revision conflicts and concurrent runs fail. The command group is aborted/reaped on timeout, abort or unload; paths are confined through canonical workspace checks. This is host-local execution, not a remote DSH world integration or an OS sandbox.

Upstream disk persistence/history, file classifiers, coverage knobs, turn-index staleness, Pi status bar/menus/slash commands, prompt injection modes, automatic Bash-result interception, and manual advancement escape hatches are not implemented. Failure-output recognition is intentionally limited and documented in README. All tracked files must exist; revisions/state are process-local. The first release claims no Pi TUI parity.
