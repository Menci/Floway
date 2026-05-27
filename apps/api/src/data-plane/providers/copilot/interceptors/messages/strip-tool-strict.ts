import type { MessagesInterceptor } from '../../../../llm/interceptors.ts';

/**
 * Anthropic Messages tools may carry `strict: true` to compile
 * `input_schema` into a grammar (same pipeline as structured outputs).
 * Copilot's Messages upstream is backed by Vertex AI Claude, whose
 * organization policy `constraints/vertexai.allowedPartnerModelFeatures`
 * denies `structured_outputs` by default — any tool with `strict: true`
 * trips a 400 `FAILED_PRECONDITION` from Vertex. We drop the field on
 * outbound; the model still respects `input_schema`, only the
 * grammar-constrained guarantee is gone.
 */
export const withToolStrictStripped: MessagesInterceptor = async (ctx, _request, run) => {
  if (Array.isArray(ctx.payload.tools)) {
    for (const tool of ctx.payload.tools as unknown as Record<string, unknown>[]) {
      if ('strict' in tool) delete tool.strict;
    }
  }
  return await run();
};
