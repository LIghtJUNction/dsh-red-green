import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import * as plugin from '../src/index.js';
import { createHost } from './host.js';

test('real ToolRuntime: opt-in RED/GREEN/REFACTOR, guard, stale state and locked tests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-red-green-'));
  const host = await createHost(root);
  try {
    await writeFile(join(root, 'impl.js'), 'module.exports = 0;');
    await writeFile(join(root, 'spec.cjs'), "const assert = require('node:assert/strict'); assert.equal(require('./impl.js'), 1);");
    await host.ctx.plugin(plugin, { root, timeoutMs: 10000 });
    let edits = 0;
    host.ctx.tools.register(defineTool({ name: 'write_file', description: 'Fixture mutation', parameters: { path: { type: 'string', required: true } }, output: { schema: { type: 'string' }, render: (_a, value) => [{ type: 'text', text: value }] }, async execute() { edits++; return 'written'; } }));
    const status = await host.execute('tdd_status', {});
    assert(!status.isError); assert.match(JSON.stringify(status.value), /idle/);
    assert(!(await host.execute('write_file', { path: 'impl.js' })).isError);
    const start = await host.execute('tdd_start', { revision: 0, userRequested: true, task: 'return one', command: [process.execPath, 'spec.cjs'], tests: ['spec.cjs'], files: ['impl.js'] });
    assert(!start.isError); assert.match(JSON.stringify(start.value), /"phase":"red"/);
    assert((await host.execute('write_file', { path: 'impl.js' })).isError);
    assert(!(await host.execute('write_file', { path: 'spec.cjs' })).isError); assert.equal(edits, 2);
    assert((await host.execute('tdd_run', { revision: 0 })).isError);
    const red = await host.execute('tdd_run', { revision: 1 });
    assert(!red.isError); assert.match(JSON.stringify(red.value), /"phase":"green"/);
    await writeFile(join(root, 'impl.js'), 'module.exports = 1;');
    const stale = await host.execute('tdd_status', {}); assert(!stale.isError); assert.match(JSON.stringify(stale.value), /"stale":true/);
    const green = await host.execute('tdd_run', { revision: 2 }); assert(!green.isError); assert.match(JSON.stringify(green.value), /refactor/);
    const done = await host.execute('tdd_run', { revision: 3 }); assert(!done.isError); assert.match(JSON.stringify(done.value), /complete/);
    assert(!(await host.execute('tdd_reset', { revision: 4 })).isError);
    assert(!(await host.execute('tdd_start', { revision: 5, userRequested: true, task: 'again', command: [process.execPath, 'spec.cjs'], tests: ['spec.cjs'], files: ['impl.js'] })).isError);
    await writeFile(join(root, 'impl.js'), 'module.exports = 0;');
    assert(!(await host.execute('tdd_run', { revision: 6 })).isError);
    await writeFile(join(root, 'spec.cjs'), 'process.exit(0)');
    const changed = await host.execute('tdd_run', { revision: 7 }); assert(changed.isError); assert.match(JSON.stringify(changed.content), /Tests changed/);
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});

test('real ToolRuntime rejects symlink escapes, unrequested start, and aborted work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-red-green-'));
  const outside = await mkdtemp(join(tmpdir(), 'dsh-red-outside-'));
  const host = await createHost(root);
  try {
    await writeFile(join(outside, 'secret'), 'fixture'); await symlink(join(outside, 'secret'), join(root, 'test'));
    await host.ctx.plugin(plugin, { root, timeoutMs: 10000 });
    const args = { revision: 0, userRequested: true, task: 'x', command: [process.execPath, '-e', 'process.exit(1)'], tests: ['test'], files: [] };
    assert((await host.execute('tdd_start', { ...args, userRequested: false })).isError);
    const escaped = await host.execute('tdd_start', args); assert(escaped.isError); assert.match(JSON.stringify(escaped.content), /escapes workspace/);
    await rm(join(root, 'test')); await writeFile(join(root, 'test'), 'fixture');
    assert(!(await host.execute('tdd_start', { ...args, command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'] })).isError);
    const controller = new AbortController();
    const running = host.execute('tdd_run', { revision: 1 }, controller.signal);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert((await host.execute('tdd_reset', { revision: 1 })).isError);
    controller.abort(); const cancelled = await running;
    assert(cancelled.isError); assert.match(cancelled.error.message, /abort/i);
    const status = await host.execute('tdd_status', {}); assert(!status.isError); assert.match(JSON.stringify(status.value), /"revision":1/);
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('dispose aborts and reaps a running test process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-red-green-'));
  const host = await createHost(root);
  try {
    await writeFile(join(root, 'spec'), 'fixture');
    await host.ctx.plugin(plugin, { root, timeoutMs: 10000 });
    assert(!(await host.execute('tdd_start', { revision: 0, userRequested: true, task: 'dispose', command: [process.execPath, '-e', "require('node:fs').writeFileSync('pid', String(process.pid)); setInterval(() => {}, 1000)"], tests: ['spec'], files: [] })).isError);
    const running = host.execute('tdd_run', { revision: 1 });
    let pid = 0;
    for (let i = 0; i < 100; i++) { try { pid = Number(await readFile(join(root, 'pid'), 'utf8')); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); } }
    assert(pid > 0); await host.close(); assert((await running).isError);
    assert.throws(() => process.kill(pid, 0));
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});

test('command errors do not advance RED, and concurrent file changes invalidate evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-red-green-'));
  const host = await createHost(root);
  try {
    await writeFile(join(root, 'spec'), 'fixture');
    await host.ctx.plugin(plugin, { root, timeoutMs: 100 });
    const base = { userRequested: true, task: 'errors', tests: ['spec'], files: [] };
    assert(!(await host.execute('tdd_start', { ...base, revision: 0, command: [process.execPath, '-e', 'throw new SyntaxError("broken")'] })).isError);
    const syntax = await host.execute('tdd_run', { revision: 1 }); assert(!syntax.isError); assert.match(JSON.stringify(syntax.value), /"phase":"red"/);
    assert(!(await host.execute('tdd_reset', { revision: 2 })).isError);
    assert(!(await host.execute('tdd_start', { ...base, revision: 3, command: [process.execPath, '-e', "require('node:fs').writeFileSync('spec', 'changed'); console.log('not ok 1'); process.exit(1)"] })).isError);
    const changed = await host.execute('tdd_run', { revision: 4 }); assert(changed.isError); assert.match(changed.error.message, /changed while tests ran/);
    assert(!(await host.execute('tdd_reset', { revision: 4 })).isError);
    assert(!(await host.execute('tdd_start', { ...base, revision: 5, command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'] })).isError);
    const timeout = await host.execute('tdd_run', { revision: 6 }); assert(timeout.isError); assert.match(timeout.error.message, /timed out/);
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});


test('real agents resolve working directories and isolate opt-in state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-red-green-'));
  const host = await createHost(root);
  try {
    await writeFile(join(root, 'spec'), 'fixture');
    await host.ctx.plugin(plugin, { timeoutMs: 1000 });
    assert((await host.execute('tdd_status', {})).isError);
    const a = await host.create('isolated-a'); const b = await host.create('isolated-b');
    let serial = 0;
    const execute = (agent: typeof a.agent, name: string, args: unknown) => host.ctx.tools.execute({ agent, name, arguments: args, signal: new AbortController().signal, callId: ToolCallId(`scope-${++serial}`) });
    const started = await execute(a.agent, 'tdd_start', { revision: 0, userRequested: true, task: 'agent A only', command: [process.execPath, '-e', 'process.exit(0)'], tests: ['spec'], files: [] });
    assert(!started.isError);
    const other = await execute(b.agent, 'tdd_status', {}); assert(!other.isError); assert.match(JSON.stringify(other.value), /"phase":"idle"/);
    const own = await execute(a.agent, 'tdd_status', {}); assert(!own.isError); assert.match(JSON.stringify(own.value), /"phase":"red"/);
    await a.dispose(); await b.dispose();
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});
