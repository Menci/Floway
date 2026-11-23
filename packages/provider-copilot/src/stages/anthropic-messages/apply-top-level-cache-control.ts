import type {
  AnthropicMessagesAssistantInputContentBlock,
  AnthropicMessagesPayload,
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
 * carried in the ported value are cleaned up by the following cache-control
 * stage.
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

export const applyCopilotTopLevelCacheControl = (payload: AnthropicMessagesPayload): AnthropicMessagesPayload => {
  const payloadWithTopLevel = payload as typeof payload & { cache_control?: { type: 'ephemeral' } };
  const topLevel = payloadWithTopLevel.cache_control;
  if (topLevel === undefined) return payload;

  const { cache_control: _cacheControl, ...withoutTopLevel } = payloadWithTopLevel;

  for (let m = withoutTopLevel.messages.length - 1; m >= 0; m--) {
    const message = withoutTopLevel.messages[m];

    if (typeof message.content === 'string') {
      const block: AnthropicMessagesTextBlockParam = { type: 'text', text: message.content, cache_control: topLevel };
      return {
        ...withoutTopLevel,
        messages: withoutTopLevel.messages.map((candidate, index) => index === m ? { ...candidate, content: [block] } : candidate),
      } as AnthropicMessagesPayload;
    }

    for (let b = message.content.length - 1; b >= 0; b--) {
      const block = message.content[b];
      if (!isCacheableBlock(block)) continue;
      if (block.cache_control !== undefined && block.cache_control !== null) return { ...withoutTopLevel, messages: withoutTopLevel.messages };
      return {
        ...withoutTopLevel,
        messages: withoutTopLevel.messages.map((candidate, messageIndex) => messageIndex !== m || !Array.isArray(candidate.content)
          ? candidate
          : {
              ...candidate,
              content: candidate.content.map((candidateBlock, blockIndex) => blockIndex === b ? { ...candidateBlock, cache_control: topLevel } : candidateBlock),
            }),
      } as AnthropicMessagesPayload;
    }
  }

  return { ...withoutTopLevel, messages: withoutTopLevel.messages };
};
