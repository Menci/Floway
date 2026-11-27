import type { OpenAIResponsesInterceptor } from './types.ts';

/**
 * Generic in the run-result type so the same definition feeds both the
 * streaming `/responses` chain and the non-streaming compaction chain.
 */
export const withStoreForcedFalse: OpenAIResponsesInterceptor = async (ctx, _gatewayCtx, run) => {
  if (!ctx.candidate.model.enabledFlags.has('openai-responses-store-false')) return await run();

  ctx.payload = { ...ctx.payload, store: false };

  return await run();
};
