import type { CopilotOpenAIChatCompletionsBoundaryInterceptor } from './types.ts';

// Copilot rejects simultaneous cap spellings. When both are equal, the
// combined cap also bounds visible output, so the legacy constraint is redundant.
// Leave distinct caller limits untouched for upstream validation.
// https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/chat/completions/completions.ts
export const withEquivalentOutputLimitsNormalized: CopilotOpenAIChatCompletionsBoundaryInterceptor = async (ctx, _env, run) => {
  if (ctx.payload.max_completion_tokens !== undefined && ctx.payload.max_tokens === ctx.payload.max_completion_tokens) {
    const { max_tokens: _legacy, ...payload } = ctx.payload;
    ctx.payload = payload;
  }
  return await run();
};
