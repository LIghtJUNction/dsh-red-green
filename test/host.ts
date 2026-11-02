import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import FsLocal from '@deepseek-ai/dsh-fs-local';

export class OfflineModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  readonly responses: StreamChunk[][] = [];
  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request);
    const chunks = this.responses.shift();
    if (!chunks) throw new Error('Offline response script exhausted');
    for (const chunk of chunks) { request.signal?.throwIfAborted(); yield chunk; }
  }
}
export function textResponse(text = 'Done'): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }];
}
export function toolResponse(name: string, args: object): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' }, { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('offline-call'), name, arguments: JSON.stringify(args) } }, { type: 'finish', reason: { kind: 'tool-calls' } }];
}
export async function createHost(root?: string) {
  const ctx = new Context();
  try {
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(SessionStore);
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(TokenMeter);
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: 'Offline plugin tests.' });
    await ctx.plugin(ToolRuntime, { mode: 'native' });
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(FsLocal);
    await ctx.plugin(WorkingDirectory, root ? { defaultDirectory: root } : {});
    await ctx.plugin(AgentLoop, { agents: [] });
    const model = new OfflineModel();
    ctx.llm.registerAdapter(['offline'], model);
    const errors: unknown[] = [];
    ctx.on('agent/error', ({ error }) => { errors.push(error); });
    let serial = 0;
    return {
      ctx, model, errors,
      create: (id = 'test-agent') => ctx.agents.create({ sessionId: SessionId(id), agentOptions: { provider: 'offline', model: 'fixture' }, ...(root ? { meta: { cwd: root } } : {}) }),
      execute: (name: string, args: unknown, signal = new AbortController().signal) => ctx.tools.execute({ callId: ToolCallId(`test-${++serial}`), name, arguments: args, signal }),
      close: () => ctx.fiber.dispose(),
    };
  } catch (error) { await ctx.fiber.dispose(); throw error; }
}
