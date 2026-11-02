import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-working-directory';

export function workspace(ctx: Context, exec: ToolRunContext, configured?: string): string {
  if (configured) return resolve(configured);
  if (!exec.agent) throw new Error('This operation requires an agent session or an explicit root configuration');
  const service = ctx.get('workingDirectory');
  if (!service) throw new Error('workingDirectory service is unavailable');
  return service.get(exec.agent.session);
}

export async function inside(root: string, path: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const target = await realpath(resolve(canonicalRoot, path));
  const rel = relative(canonicalRoot, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Path escapes workspace');
  return target;
}
