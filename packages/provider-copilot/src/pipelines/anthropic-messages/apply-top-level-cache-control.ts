import { rewritePayload } from '../shared/rewrite-payload.ts';
import type {
  AnthropicMessagesAssistantInputContentBlock,
  AnthropicMessagesTextBlockParam,
  AnthropicMessagesUserContentBlock,
} from '@floway-dev/protocols/anthropic-messages';

/**
 * Anthropic's Anthropic Messages API defines a top-level `cache_control` field that
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
 * `stripCacheControlExtensions`, which runs immediately after.
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

export const applyTopLevelCacheControl = rewritePayload('anthropicMessages', 'applyTopLevelCacheControl', current => {
  const payload = current as typeof current & { cache_control?: { type: 'ephemeral' } };
  if (payload.cache_control === undefined) return current;

  const { cache_control: marker, ...rest } = payload;
  for (let messageIndex = rest.messages.length - 1; messageIndex >= 0; messageIndex--) {
    const message = rest.messages[messageIndex];
    if (typeof message.content === 'string') {
      const block: AnthropicMessagesTextBlockParam = { type: 'text', text: message.content, cache_control: marker };
      return { ...rest, messages: rest.messages.with(messageIndex, { ...message, content: [block] }) };
    }

    for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex--) {
      const block = message.content[blockIndex];
      if (!isCacheableBlock(block)) continue;
      if (block.cache_control !== undefined) return rest;
      const content = message.content.with(blockIndex, { ...block, cache_control: marker });
      return { ...rest, messages: rest.messages.with(messageIndex, { ...message, content } as typeof message) };
    }
  }
  return rest;
});
