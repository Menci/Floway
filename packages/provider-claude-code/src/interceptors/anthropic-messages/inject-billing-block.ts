import type { AnthropicMessagesBoundaryCtx } from './types.ts';
import { addBillingBlock } from '../../pipelines/anthropic-messages/inject-billing-block.ts';

export const injectBillingBlock = async <TResult>(
  ctx: AnthropicMessagesBoundaryCtx,
  _env: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  ctx.payload = addBillingBlock(ctx.payload);
  return await run();
};
