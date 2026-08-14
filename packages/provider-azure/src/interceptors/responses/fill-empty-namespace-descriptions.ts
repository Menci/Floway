import type { ResponsesBoundaryCtx } from './types.ts';
import { mapResponsesTools } from '@floway-dev/protocols/responses';

/**
 * Azure OpenAI still enforces the former namespace-description minLength even
 * though current OpenAI Responses permits an empty required string. Supply a
 * deterministic model-facing description only on Azure-bound requests.
 *
 * References:
 * - https://github.com/openai/openai-openapi/commit/466c74a42f51c02f1927bc666815251dc53845dc
 * - https://github.com/openai/codex/issues/37380
 */
export const withEmptyNamespaceDescriptionsFilled = async <TResult>(
  ctx: ResponsesBoundaryCtx,
  _env: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  ctx.payload = mapResponsesTools(ctx.payload, tool => tool.type === 'namespace' && tool.description === ''
    ? { ...tool, description: `Tools in the ${tool.name} namespace.` }
    : tool);
  return await run();
};
