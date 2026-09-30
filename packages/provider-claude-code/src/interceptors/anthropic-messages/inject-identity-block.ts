import { IDENTITY_BLOCK } from './system-blocks.ts';
import type { AnthropicMessagesBoundaryCtx } from './types.ts';
import type { AnthropicMessagesTextBlock } from '@floway-dev/protocols/anthropic-messages';

// system[1]; relies on injectBillingBlock having materialized payload.system as an array (see ./index.ts chain order).
export const injectIdentityBlockPayload = <P extends Omit<AnthropicMessagesBoundaryCtx['payload'], 'model'>>(payload: P): P => {
  const system = payload.system as AnthropicMessagesTextBlock[];
  payload = { ...payload, system: [...system, IDENTITY_BLOCK] };
  return payload;
};

export const injectIdentityBlock = async <TResult>(
  ctx: AnthropicMessagesBoundaryCtx,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  ctx.payload = injectIdentityBlockPayload(ctx.payload);
  return await run();
};
