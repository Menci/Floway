import type { ResponsesInterceptor } from '../../../../llm/interceptors.ts';

/**
 * VSCode Copilot Chat does not insert `safety_identifier` on its `/responses`
 * calls. Our Anthropic-to-Responses translator never synthesizes it; native
 * Responses callers' values flow through untouched. This interceptor
 * enforces that asymmetry on the Copilot Responses target — strip only when
 * the request entered as a non-Responses shape (we synthesized it during
 * translation), and preserve whatever native Responses callers actually
 * sent.
 *
 * Chat Completions is not affected: the field flows through to Copilot's
 * Chat endpoint without rejection.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/commit/1678c44bd083e7c3efa774c2952aadf977b4d528
 * - https://platform.openai.com/docs/api-reference/responses/create
 */
export const withSafetyIdentifierStripped: ResponsesInterceptor = async (ctx, _request, run) => {
  if (ctx.sourceApi !== 'responses') {
    delete ctx.payload.safety_identifier;
  }
  return await run();
};
