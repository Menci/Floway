import type { CopilotAnthropicMessagesBoundaryInterceptor } from './types.ts';
import type {
  AnthropicMessagesAssistantInputContentBlock,
  AnthropicMessagesPayload,
  AnthropicMessagesTextBlock,
  AnthropicMessagesUserContentBlock,
} from '@floway-dev/protocols/anthropic-messages';

/**
 * Anthropic's Messages API defines a top-level `cache_control` field that
 * "automatically applies a cache_control marker to the last cacheable block
 * in the request" (per `MessageCreateParamsBase` in the official SDK).
 * Copilot's `/v1/messages` deployment validates against an older schema for
 * several model slots (claude-haiku-4.5, claude-sonnet-4.5, claude-sonnet-4.6,
 * and intermittently claude-opus-4.5) and rejects the top-level field with
 * `cache_control: Extra inputs are not permitted`. Newer slots (opus 4.6/4.7)
 * silently accept it.
 *
 * Port the marker onto the last cacheable content block (mirroring the
 * documented semantics), then drop the top-level field. If the last cacheable
 * block already carries its own `cache_control`, leave it alone — an explicit
 * marker wins over the auto-apply. Sub-field extensions (`scope`, `ttl`)
 * carried in the ported value are cleaned up by
 * `withCacheControlExtensionsStripped`, which runs immediately after.
 *
 * References:
 * - https://github.com/anthropics/anthropic-sdk-typescript/blob/a53f60d59ca904f3e79296586642aac3ce68ae02/src/resources/messages/messages.ts#L2909-L2913
 * - https://github.com/caozhiyuan/copilot-api/issues/269
 */

type CacheableBlock = Extract<
  AnthropicMessagesUserContentBlock | AnthropicMessagesAssistantInputContentBlock,
  { cache_control?: unknown }
>;

const isCacheableBlock = (block: AnthropicMessagesUserContentBlock | AnthropicMessagesAssistantInputContentBlock): block is CacheableBlock =>
  block.type === 'text' || block.type === 'image' || block.type === 'tool_use' || block.type === 'tool_result';

/** Where the marker lands: the last message that can carry one, and within it either the whole
 *  string content or the last cacheable block. Reading the position out first is what lets the
 *  rewrite below rebuild one path and leave every other message alone. */
const markerSite = (messages: AnthropicMessagesPayload['messages']): { readonly message: number; readonly block: number | 'whole' } | undefined => {
  for (let m = messages.length - 1; m >= 0; m--) {
    const content = messages[m].content;
    if (typeof content === 'string') return { message: m, block: 'whole' };
    for (let b = content.length - 1; b >= 0; b--) {
      if (isCacheableBlock(content[b])) return { message: m, block: b };
    }
  }
  return undefined;
};

export const withTopLevelCacheControlApplied: CopilotAnthropicMessagesBoundaryInterceptor = async (ctx, run) => {
  const payload = ctx.payload as typeof ctx.payload & { cache_control?: { type: 'ephemeral' } };
  const topLevel = payload.cache_control;
  if (topLevel === undefined) return await run();

  const { cache_control: _ported, ...withoutTopLevel } = payload;
  const site = markerSite(payload.messages);
  if (site === undefined) {
    ctx.payload = withoutTopLevel;
    return await run();
  }

  ctx.payload = {
    ...withoutTopLevel,
    // Each rewrite keeps its message's own role and only re-homes that role's own blocks, so
    // the array is handed back at its element type; spreading alone widens it to the union.
    messages: payload.messages.map((message, m): AnthropicMessagesPayload['messages'][number] => {
      if (m !== site.message) return message;
      if (site.block === 'whole') {
        const block: AnthropicMessagesTextBlock = { type: 'text', text: message.content as string, cache_control: topLevel };
        return { ...message, content: [block] } as AnthropicMessagesPayload['messages'][number];
      }
      const content = message.content as readonly CacheableBlock[];
      // `??=` semantics: a block that already states its own marker keeps it.
      if (content[site.block].cache_control !== undefined) return message;
      return {
        ...message,
        content: content.map((block, b) => (b === site.block ? { ...block, cache_control: topLevel } : block)),
      } as AnthropicMessagesPayload['messages'][number];
    }),
  };

  return await run();
};
