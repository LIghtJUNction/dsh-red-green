import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { defineTool, type ToolExecution, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import { inside, workspace } from './support.js';
import { run } from './process.js';

export const name = 'dsh-red-green';
export const inject = ['tools', 'workingDirectory', 'agents'];
export interface Config { root?: string; timeoutMs: number }
export const Config: Schema<Config> = Schema.object({
  root: Schema.string().description('Explicit host-local workspace; otherwise agent working directory.'),
  timeoutMs: Schema.number().min(100).max(600000).default(120000),
});

type Phase = 'red' | 'green' | 'refactor' | 'complete';
type Cycle = { phase: Phase; task: string; command: string[]; tests: string[]; files: string[]; lockedTests: string | null; evidence: string | null };
type Entry = { revision: number; busy: boolean; cycle: Cycle | null };
const output = {
  schema: { type: 'object', additionalProperties: false, properties: {
    revision: { type: 'integer', required: true }, phase: { type: 'string', required: true },
    task: { type: 'string', required: true }, stale: { type: 'boolean', required: true },
    message: { type: 'string', required: true },
  } },
  render: (_args: unknown, value: { revision: number; phase: string; task: string; stale: boolean; message: string }) => [{ type: 'text' as const, text: JSON.stringify(value) }],
} as const;

async function fingerprint(root: string, paths: string[]) {
  const hash = createHash('sha256');
  for (const path of paths) {
    const canonical = await inside(root, path);
    const bytes = await readFile(canonical);
    if (await inside(root, path) !== canonical) throw new Error('Tracked file changed its symlink target');
    hash.update(path).update('\0').update(canonical).update('\0').update(bytes).update('\0');
  }
  return hash.digest('hex');
}

export function apply(ctx: Context, config: Config) {
  const entries = new Map<string, Entry>();
  const lifetime = new AbortController();
  const pending = new Set<Promise<unknown>>();
  let disposed = false;
  const key = (exec: Pick<ToolRunContext, 'agent'>, root: string) => `${exec.agent?.id ?? 'host'}\0${root}`;
  const entry = async (exec: ToolRunContext) => {
    exec.signal.throwIfAborted();
    if (disposed) throw new Error('Plugin disposed');
    const root = await realpath(workspace(ctx, exec, config.root));
    const id = key(exec, root);
    let state = entries.get(id);
    if (!state) { state = { revision: 0, busy: false, cycle: null }; entries.set(id, state); }
    return { root, state };
  };
  const view = async (root: string, state: Entry, message: string) => {
    const cycle = state.cycle;
    let stale = false;
    if (cycle?.evidence) {
      try { stale = cycle.evidence !== await fingerprint(root, cycle.files); } catch { stale = true; }
    }
    return { revision: state.revision, phase: cycle?.phase ?? 'idle', task: cycle?.task ?? '', stale, message };
  };
  const assertRevision = (state: Entry, revision: number) => {
    if (state.busy) throw new Error('A test run is in progress');
    if (revision !== state.revision) throw new Error(`Stale revision: expected ${state.revision}`);
  };
  ctx.effect(() => async () => {
    disposed = true; lifetime.abort();
    await Promise.allSettled([...pending]); entries.clear();
  });
  ctx.on('agent/disposed', ({ agent }) => {
    for (const id of entries.keys()) if (id.startsWith(`${agent.id}\0`)) entries.delete(id);
  });
  ctx.tools.guard((exec: Readonly<ToolExecution>) => {
    if (exec.name.startsWith('tdd_')) return;
    // Synchronous guard uses session identity; a configured host root has a host-only entry.
    const active = [...entries].filter(([id, value]) => id.startsWith(`${exec.agent?.id ?? 'host'}\0`) && value.cycle?.phase === 'red');
    if (!active.length || !/write|edit|patch|bash|shell|exec|terminal/i.test(exec.name)) return;
    const args = exec.arguments;
    const path = args && typeof args === 'object' && 'path' in args && typeof args.path === 'string' ? args.path : null;
    if (path && active.every(([, state]) => state.cycle?.tests.includes(path)) && !/bash|shell|exec|terminal/i.test(exec.name)) return;
    return 'TDD RED: edit only declared tests; run tdd_run to observe a failing test before implementation. Use tdd_reset to leave the explicitly started cycle.';
  });
  ctx.tools.register(defineTool({ name: 'tdd_status', description: 'Read this agent/workspace TDD state. Idle by default; never start TDD without an explicit user request.', parameters: {}, output,
    async execute(_args, exec) { const { root, state } = await entry(exec); return view(root, state, 'Host-local, process-local cycle; no implicit TDD enforcement.'); },
  }));
  ctx.tools.register(defineTool({ name: 'tdd_start', description: 'Only after the user explicitly requests TDD: start RED with existing tracked test/source files and a host-local test command argv. No shell expansion. Read tdd_status for revision first.',
    parameters: { revision: { type: 'integer', required: true }, userRequested: { type: 'boolean', const: true, required: true }, task: { type: 'string', required: true }, command: { type: 'array', items: { type: 'string' }, required: true }, tests: { type: 'array', items: { type: 'string' }, required: true }, files: { type: 'array', items: { type: 'string' }, required: true } }, output,
    async execute(args, exec) {
      const { root, state } = await entry(exec); assertRevision(state, args.revision);
      if (state.cycle) throw new Error('Reset the current cycle first');
      if (!args.task.trim() || !args.command[0] || !args.tests.length) throw new Error('Task, command and at least one existing test are required');
      state.busy = true;
      try {
        const files = [...new Set([...args.tests, ...args.files])];
        await fingerprint(root, files); exec.signal.throwIfAborted(); lifetime.signal.throwIfAborted();
        state.cycle = { phase: 'red', task: args.task, command: args.command, tests: args.tests, files, lockedTests: null, evidence: null }; state.revision++;
        return view(root, state, 'RED started by explicit request. Write a failing assertion, then call tdd_run.');
      } finally { state.busy = false; }
    },
  }));
  ctx.tools.register(defineTool({ name: 'tdd_run', description: 'Execute the declared test argv on the DSH host. RED advances only on recognized test failure output; passing GREEN advances to REFACTOR, then another passing run completes. Tests must remain unchanged after RED.',
    parameters: { revision: { type: 'integer', required: true } }, output,
    async execute(args, exec) {
      const { root, state } = await entry(exec); assertRevision(state, args.revision);
      const cycle = state.cycle;
      if (!cycle || cycle.phase === 'complete') throw new Error('No active cycle');
      state.busy = true;
      const operation = (async () => {
        const signal = AbortSignal.any([exec.signal, lifetime.signal]);
        const before = await fingerprint(root, cycle.files);
        const tests = await fingerprint(root, cycle.tests);
        if (cycle.lockedTests && tests !== cycle.lockedTests) throw new Error('Tests changed since RED evidence; reset and establish a new cycle');
        const result = await run(cycle.command, root, signal, config.timeoutMs);
        const after = await fingerprint(root, cycle.files);
        signal.throwIfAborted();
        if (before !== after) throw new Error('Tracked files changed while tests ran; evidence discarded');
        const failedAssertion = /not ok\b|AssertionError|\bFAIL(?:ED)?\b|[1-9]\d* failed/i.test(result.output);
        if (cycle.phase === 'red' && result.code !== 0 && failedAssertion && !/SyntaxError|command not found|ERR_MODULE_NOT_FOUND/.test(result.output)) {
          cycle.phase = 'green'; cycle.lockedTests = tests;
        } else if (cycle.phase === 'green' && result.code === 0) cycle.phase = 'refactor';
        else if (cycle.phase === 'refactor' && result.code === 0) cycle.phase = 'complete';
        cycle.evidence = after; state.revision++;
        return view(root, state, `exit=${result.code}\n${result.output}`);
      })();
      pending.add(operation);
      try { return await operation; } finally { pending.delete(operation); state.busy = false; }
    },
  }));
  ctx.tools.register(defineTool({ name: 'tdd_reset', description: 'Explicitly stop this cycle and remove its workflow guard. Requires current revision; cannot reset during a test run.', parameters: { revision: { type: 'integer', required: true } }, output,
    async execute(args, exec) { const { root, state } = await entry(exec); assertRevision(state, args.revision); state.cycle = null; state.revision++; return view(root, state, 'Cycle stopped.'); },
  }));
}
