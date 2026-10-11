import type { OpenAIResponsesInterceptor } from './types.ts';
import { providerModelOf } from '@floway-dev/provider';

/**
 * Generic in the run-result type so the same definition feeds both the
 * streaming `/responses` chain and the non-streaming compaction chain.
 */
export const withStoreForcedFalse: OpenAIResponsesInterceptor = async (ctx, _gatewayCtx, run) => {
  if (!providerModelOf(ctx.candidate).enabledFlags.has('openai-responses-store-false')) return await run();

  ctx.payload = { ...ctx.payload, store: false };

  return await run();
};
