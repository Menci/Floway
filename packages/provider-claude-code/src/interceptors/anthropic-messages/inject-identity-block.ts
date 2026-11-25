import type { AnthropicMessagesBoundaryCtx } from './types.ts';
import { addIdentityBlock } from '../../pipelines/anthropic-messages/inject-identity-block.ts';

export const injectIdentityBlock = async <TResult>(
  ctx: AnthropicMessagesBoundaryCtx,
  _env: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  ctx.payload = addIdentityBlock(ctx.payload);
  return await run();
};
