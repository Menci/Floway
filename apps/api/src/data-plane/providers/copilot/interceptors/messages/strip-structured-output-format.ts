import type { MessagesInterceptor } from '../../../../llm/interceptors.ts';

/**
 * Anthropic's structured outputs (beta `structured-outputs-2025-12-15`)
 * surface a `output_config.format` body field carrying a JSON Schema.
 * Copilot load-balances `/v1/messages` between Vertex AI and other
 * backends; when a request lands on Vertex, GCP organization policy
 * `constraints/vertexai.allowedPartnerModelFeatures` denies the
 * `structured_outputs` partner feature and returns a 400
 * `FAILED_PRECONDITION`. Stripping is the only deterministic fix:
 * a retry might re-roll the routing dice but doesn't guarantee a
 * non-Vertex backend on the second try.
 *
 * The body field is the sole trigger — probing shows the beta header
 * alone passes through cleanly (`withAnthropicBetaHeaderFiltered`
 * already drops the unknown beta from the allow-list anyway). The
 * sibling `output_config.effort` field is Copilot's own reasoning-effort
 * surface and must be preserved; only `format` is removed, and the
 * container is dropped when it becomes empty so we don't ship a stray
 * `output_config: {}`.
 *
 * Clients lose the grammar-constrained guarantee on this beta path,
 * but the model still attends to the schema in-prompt and well-behaved
 * callers re-parse with a schema validator (Claude Code's hook
 * evaluator wraps the reply in Zod's `safeParse`, for example).
 *
 * References:
 * - https://platform.claude.com/docs/en/build-with-claude/structured-outputs
 * - https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts (OutputConfig, JSONOutputFormat)
 * - https://github.com/imbuxiangnan-cyber/copilot-api-plus/blob/0350e8805456b2c14e12358db66ae0584a5cc4ac/src/routes/messages/handler.ts#L260-L285 (prior art: transparent retry)
 */
export const withStructuredOutputFormatStripped: MessagesInterceptor = async (ctx, _request, run) => {
  const config = ctx.payload.output_config as Record<string, unknown> | undefined;
  if (config && 'format' in config) {
    delete config.format;
    if (Object.keys(config).length === 0) delete ctx.payload.output_config;
  }
  return await run();
};
