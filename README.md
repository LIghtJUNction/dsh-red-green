# dsh-red-green

Opt-in RED → GREEN → REFACTOR → COMPLETE for DSH **0.2.1-rc.2**, Node **24+**. Real ToolRuntime tools run a fixed test command and keep evidence tied to file content. Loading the plugin leaves every session idle; only start it after the user explicitly requests TDD.

## Install

After a release is published, install its GitHub release tarball (the command below is an installation pattern, not a claim that this release already exists):

```sh
dsh plugin --profile headless add https://github.com/LIghtJUNction/dsh-red-green/releases/download/v0.1.0/lightjunction-dsh-red-green-0.1.0.tgz
```

The package includes a `dsh.bundle` patch. Restart DSH after installation if your profile does not enable HMR. Optional configuration in the profile patch:

```yaml
- id: dsh-red-green
  name: '@lightjunction/dsh-red-green'
  config:
    root: /absolute/host/project
    timeoutMs: 120000
```

`root` defaults to the calling agent's working directory; agent-less calls require `root`. `timeoutMs` is 100–600000 ms. Direct TypeScript registration uses `import * as plugin` and `await ctx.plugin(plugin, { root, timeoutMs: 120000 })`.

## Example

Create the test file first. After the user says “use TDD”, call:

```text
tdd_status {}
tdd_start {"revision":0,"userRequested":true,"task":"return one","command":["node","--test","test/example.test.cjs"],"tests":["test/example.test.cjs"],"files":["src/example.cjs"]}
tdd_run {"revision":1}
```

Use the revision returned by each result for the next mutation. A recognized failing assertion advances RED to GREEN and locks the test content. Implement the behavior, run `tdd_run` again to enter REFACTOR, refactor, and run again to complete. `tdd_status` reports whether tracked files have changed since the last evidence. `tdd_reset {"revision":4}` stops the cycle and removes its guard; it never rewinds files.

Each cycle is scoped to an agent and canonical workspace. A workspace has a separate agent-less state. Calls reject stale revisions and overlapping mutations. Tests, sources, and in-root symlink targets are fingerprinted; traversal and symlinks escaping the root are rejected. Changing tracked files during the command discards the result. Changing tests after observed RED requires reset. Abort, timeout, and unload terminate and reap the Unix process group. Agent disposal removes its cycle.

## Limits

- **Host-local Node filesystem and child processes only.** A remote DSH world/sandbox is not supported. The command inherits the DSH host environment and runs with host privileges; it is not sandboxed. No shell expansion; explicitly invoking a shell executes that shell with the same privileges.
- All tracked files must already exist. Declare every relevant source/test fixture; untracked dependencies and concurrent edits restored before the final snapshot are not detected. File snapshots are content checks, not an OS filesystem transaction or protection against hostile symlink races.
- RED guards tools whose names contain `write`, `edit`, `patch`, `bash`, `shell`, `exec` or `terminal`. Only an exact declared `path` is allowed for test-only edits; implementation and shell tools are denied until a failing test is observed. Custom tool aliases, direct host writes, and edits through other plugins are not a security boundary. Outside RED, workflow enforcement is advisory. No default TDD prompts or forced TDD.
- `userRequested: true` is a protocol assertion by the caller; the plugin cannot prove a human requested it. The tool description instructs the model to require the explicit request.
- Nonzero exit plus recognized failure text (`not ok`, `AssertionError`, `FAIL`/`FAILED`, or a failed count) is a heuristic, not a full test report parser. Syntax/module errors do not advance RED. GREEN/REFACTOR use exit code zero; configure a real test runner, never a no-op command. Output retains only the last 64 KiB and may contain test output; avoid commands that print secrets.
- State is in memory and disappears on unload; no disk history, coverage measurement, Pi TUI, slash commands, or manual evidence bypass. Unix only; Windows process lifecycle is not implemented.

## Verification

```sh
npm run check --workspace @lightjunction/dsh-red-green
```

Tests use the real DSH ToolRuntime, local subprocesses and temporary files: full phase progression, explicit opt-in, guards, stale revisions/evidence, locked tests, escaping symlinks, concurrent mutation, cancellation, timeout and plugin unload with PID death verification. Tests do not contact a live model service. See [UPSTREAM.md](UPSTREAM.md) and [NOTICE](NOTICE).
