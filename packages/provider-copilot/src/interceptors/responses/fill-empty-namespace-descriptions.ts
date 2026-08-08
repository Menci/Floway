import type { ResponsesBoundaryCtx } from './types.ts';
import { mapResponsesTools } from '@floway-dev/protocols/responses';

/**
 * Copilot data planes currently disagree on the OpenAI schema update that
 * permits an empty namespace description: some accept Codex 0.147's payload,
 * while others reject it with `invalid_request_body`. Fill the permitted-empty
 * text at the Copilot boundary so either deployment accepts the same request.
 *
 * References:
 * - https://github.com/openai/openai-openapi/commit/466c74a42f51c02f1927bc666815251dc53845dc
 * - https://github.com/caozhiyuan/copilot-api/issues/345
 * - https://github.com/engineersamuel/copilot-proxy-rs/commit/1c23d7237bd1bd7c24045d0d426412851bfd57f6
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
