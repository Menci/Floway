import type { MessagesPayloadInterceptor } from './types.ts';
import { providerModelOf } from '@floway-dev/provider';

// Opt-in compatibility rewrite for upstreams that reject an active
// `tool_choice` when the caller explicitly supplies no tools. Messages uses
// an object for its native no-tool choice.
export const withEmptyToolsToolChoiceNormalized: MessagesPayloadInterceptor = async (ctx, _gatewayCtx, run) => {
  if (!providerModelOf(ctx.candidate).enabledFlags.has('empty-tools-tool-choice-none')) return await run();
  if (!Array.isArray(ctx.payload.tools) || ctx.payload.tools.length !== 0) return await run();
  ctx.payload = { ...ctx.payload, tool_choice: { type: 'none' } };
  return await run();
};
