import type { OpenAIChatCompletionsInterceptor } from './types.ts';

// Opt-in compatibility rewrite for upstreams that reject an active
// `tool_choice` when the caller explicitly supplies no tools. Keep `tools` as
// sent and make the caller's effective intent unambiguous on the target wire.
export const withEmptyToolsToolChoiceNormalized: OpenAIChatCompletionsInterceptor = async (ctx, _gatewayCtx, run) => {
  if (!ctx.candidate.model.enabledFlags.has('empty-tools-tool-choice-none')) return await run();
  if (!Array.isArray(ctx.payload.tools) || ctx.payload.tools.length !== 0) return await run();
  ctx.payload = { ...ctx.payload, tool_choice: 'none' };
  return await run();
};
