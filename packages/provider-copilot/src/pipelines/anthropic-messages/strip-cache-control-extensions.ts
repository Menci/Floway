import { mapChanged } from '../shared/map-changed.ts';
import { rewritePayload } from '../shared/rewrite-payload.ts';

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
 * `applyTopLevelCacheControl`, which runs first and either ports it
 * onto the last cacheable block (where this stage cleans it) or
 * deletes it when no cacheable block exists.
 *
 * Custom providers that speak Anthropic Messages directly may accept these
 * betas natively; this stage is Copilot-only.
 *
 * References:
 * - https://github.com/anthropics/anthropic-sdk-typescript/blob/a53f60d59ca904f3e79296586642aac3ce68ae02/src/resources/messages/messages.ts#L2909-L2913
 * - https://github.com/caozhiyuan/copilot-api/issues/143
 * - https://github.com/caozhiyuan/copilot-api/issues/144
 * - https://github.com/caozhiyuan/copilot-api/issues/269
 * - https://github.com/caozhiyuan/copilot-api/commit/ce8224c55933f811abe5bf9ba42f9336a7852997
 */

const stripExtensions = <T extends object>(block: T): T => {
  if (!('cache_control' in block)) return block;
  const { cache_control: cache, ...rest } = block;
  if (typeof cache !== 'object' || cache === null || !('scope' in cache || 'ttl' in cache)) return block;
  const { scope: _scope, ttl: _ttl, ...marker } = cache as Record<string, unknown>;
  return (Object.keys(marker).length === 0 ? rest : { ...rest, cache_control: marker }) as T;
};

export const stripCacheControlExtensions = rewritePayload('anthropicMessages', 'stripCacheControlExtensions', payload => {
  const system = Array.isArray(payload.system) ? mapChanged(payload.system, stripExtensions) : payload.system;
  const tools = payload.tools === undefined ? undefined : mapChanged(payload.tools, stripExtensions);
  const messages = mapChanged(payload.messages, message => {
    if (!Array.isArray(message.content)) return message;
    const content = mapChanged(message.content, stripExtensions);
    return content === message.content ? message : { ...message, content } as typeof message;
  });
  return system === payload.system && tools === payload.tools && messages === payload.messages ? payload : {
    ...payload,
    ...(system === undefined ? {} : { system }),
    ...(tools === undefined ? {} : { tools }),
    messages,
  };
});
