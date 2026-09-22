import { IDENTITY_BLOCK } from './system-blocks.ts';
import type { AnthropicMessagesBoundaryCtx } from './types.ts';
import type { AnthropicMessagesTextBlock } from '@floway-dev/protocols/anthropic-messages';

// system[1]; relies on injectBillingBlock having materialized payload.system as an array (see ./index.ts chain order).
export const injectIdentityBlock = async <TResult>(
  ctx: AnthropicMessagesBoundaryCtx,
  _env: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  const system = ctx.payload.system as AnthropicMessagesTextBlock[];
  ctx.payload = { ...ctx.payload, system: [...system, IDENTITY_BLOCK] };
  return await run();
};
