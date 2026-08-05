import type { CopilotMessagesBoundaryInterceptor } from './types.ts';

/**
 * Two `cache_control` sub-fields are beta extensions to the base
 * `CacheControlEphemeral` shape that Copilot's stricter Messages-upstream
 * deployments (claude-haiku-4.5, claude-sonnet-4.5/4.6, intermittently
 * claude-opus-4.5) reject:
 *
 *   - `scope`: added by Claude Code's `prompt-caching-scope-2025-11-27` beta.
 *     Copilot returns `cache_control.scope: Extra inputs are not permitted`.
 *   - `ttl`: added by the `extended-cache-ttl-2025-04-11` beta. Floway does
 *     not enable that beta for Copilot, so any `ttl` value trips the same
 *     schema rejection on the body.
 *
 * Walk every position where `cache_control` may appear — system blocks,
 * tools, message content blocks including `tool_use` and `tool_result` —
 * and strip both sub-fields, keeping `{ type: 'ephemeral' }` so prompt
 * caching still primes on slots that do honour the marker.
 *
 * The top-level `cache_control` field is handled by
 * `withTopLevelCacheControlApplied`, which runs first and either ports it
 * onto the last cacheable block (where this interceptor cleans it) or
 * deletes it when no cacheable block exists.
 *
 * Custom providers that speak Anthropic Messages directly may accept these
 * betas natively; this interceptor is Copilot-only.
 *
 * References:
 * - https://github.com/anthropics/anthropic-sdk-typescript/blob/a53f60d59ca904f3e79296586642aac3ce68ae02/src/resources/messages/messages.ts#L2909-L2913
 * - https://github.com/caozhiyuan/copilot-api/issues/143
 * - https://github.com/caozhiyuan/copilot-api/issues/144
 * - https://github.com/caozhiyuan/copilot-api/issues/269
 * - https://github.com/caozhiyuan/copilot-api/commit/ce8224c55933f811abe5bf9ba42f9336a7852997
 */
const stripExtensions = (block: Record<string, unknown>): void => {
  const cacheControl = block.cache_control;
  if (!cacheControl || typeof cacheControl !== 'object') return;

  const { scope: _scope, ttl: _ttl, ...rest } = cacheControl as Record<string, unknown>;
  if (Object.keys(rest).length > 0) block.cache_control = rest;
  else delete block.cache_control;
};

export const withCacheControlExtensionsStripped: CopilotMessagesBoundaryInterceptor = async (ctx, _env, run) => {
  if (Array.isArray(ctx.payload.system)) {
    for (const block of ctx.payload.system as unknown as Record<string, unknown>[]) {
      stripExtensions(block);
    }
  }

  if (ctx.payload.tools) {
    for (const tool of ctx.payload.tools as unknown as Record<string, unknown>[]) {
      stripExtensions(tool);
    }
  }

  for (const message of ctx.payload.messages) {
    if (!Array.isArray(message.content)) continue;

    for (const block of message.content as unknown as Record<string, unknown>[]) {
      stripExtensions(block);
    }
  }

  return await run();
};
