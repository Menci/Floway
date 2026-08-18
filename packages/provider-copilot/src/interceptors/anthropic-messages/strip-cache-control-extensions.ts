import type { CopilotAnthropicMessagesBoundaryInterceptor } from './types.ts';
import { mapKeepingIdentity, withKeysChanged } from '../shared/rebuild.ts';

/**
 * Two `cache_control` sub-fields are beta extensions to the base
 * `CacheControlEphemeral` shape that Copilot's stricter Anthropic-Messages-upstream
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
/** The block with its cache-control extensions gone, or the same block when it carried none.
 *  Returning the original is what lets an untouched message ride through by identity. */
const stripExtensions = <T extends object>(block: T): T => {
  const cacheControl = (block as Record<string, unknown>).cache_control;
  if (!cacheControl || typeof cacheControl !== 'object') return block;

  const { scope: _scope, ttl: _ttl, ...rest } = cacheControl as Record<string, unknown>;
  return withKeysChanged(block, { cache_control: Object.keys(rest).length > 0 ? rest : undefined });
};

export const withCacheControlExtensionsStripped: CopilotAnthropicMessagesBoundaryInterceptor = async (ctx, _env, run) => {
  const payload = ctx.payload;

  const system = Array.isArray(payload.system)
    ? mapKeepingIdentity(payload.system, stripExtensions)
    : payload.system;
  const tools = payload.tools === undefined ? payload.tools : mapKeepingIdentity(payload.tools, stripExtensions);
  const messages = mapKeepingIdentity(payload.messages, message => (
    Array.isArray(message.content)
      // The content arrays are a union of per-role block types, so the walk is expressed over
      // the shape they share — an object — and handed back at the array's own type.
      ? withKeysChanged(message, { content: mapKeepingIdentity(message.content as readonly object[], stripExtensions) })
      : message
  ));

  ctx.payload = withKeysChanged(payload, {
    ...(system === payload.system ? {} : { system }),
    ...(tools === payload.tools ? {} : { tools }),
    ...(messages === payload.messages ? {} : { messages }),
  });

  return await run();
};
