import { spawn } from 'node:child_process';

/** Execute a host-local command, drain bounded output, and reap its entire process group. */
export async function run(command: string[], cwd: string, signal: AbortSignal, timeoutMs: number) {
  signal.throwIfAborted();
  const executable = command[0];
  if (!executable) throw new Error('A non-empty command is required');
  if (process.platform === 'win32') throw new Error('Windows process cleanup is not implemented');
  const child = spawn(executable, command.slice(1), { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let failure: Error | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const kill = (kind: NodeJS.Signals) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, kind); } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
    }
  };
  const stop = () => {
    kill('SIGTERM');
    escalation ??= setTimeout(() => kill('SIGKILL'), 300);
  };
  const abort = () => stop();
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { failure = new Error('Test command timed out'); stop(); }, timeoutMs);
  const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-65536); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code));
    });
    signal.throwIfAborted();
    if (failure) throw failure;
    if (code === null) throw new Error('Test command terminated by signal');
    return { code, output };
  } finally {
    clearTimeout(timer);
    if (escalation) clearTimeout(escalation);
    signal.removeEventListener('abort', abort);
    kill('SIGKILL');
  }
}
