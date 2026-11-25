import type { AnthropicMessagesBoundaryCtx } from './types.ts';
import { hoistSystem } from '../../pipelines/anthropic-messages/hoist-user-system-to-messages.ts';

export const hoistUserSystemToMessages = async <TResult>(
  ctx: AnthropicMessagesBoundaryCtx,
  _env: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  ctx.payload = hoistSystem(ctx.payload);
  return await run();
};
