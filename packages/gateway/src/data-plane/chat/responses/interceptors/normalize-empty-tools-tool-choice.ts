import type { ResponsesInterceptor } from './types.ts';
import { providerModelOf } from '@floway-dev/provider';

// Opt-in compatibility rewrite for upstreams that reject an active
// `tool_choice` when the caller explicitly supplies no tools. This runs after
// server-tool shims have had the opportunity to inject a usable tool.
export const withEmptyToolsToolChoiceNormalized: ResponsesInterceptor = async (ctx, _gatewayCtx, run) => {
  if (!providerModelOf(ctx.candidate).enabledFlags.has('empty-tools-tool-choice-none')) return await run();
  if (!Array.isArray(ctx.payload.tools) || ctx.payload.tools.length !== 0) return await run();
  ctx.payload = { ...ctx.payload, tool_choice: 'none' };
  return await run();
};
