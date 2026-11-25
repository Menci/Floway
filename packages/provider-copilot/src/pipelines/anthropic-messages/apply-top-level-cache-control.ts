import { defineCopilotStage } from '../facts.ts';
import { move, transform } from '@floway-dev/pipeline';
import type { AnthropicMessagesAssistantInputContentBlock, AnthropicMessagesCountTokensPayload, AnthropicMessagesMessage, AnthropicMessagesPayload, AnthropicMessagesUserContentBlock } from '@floway-dev/protocols/anthropic-messages';
type ContentBlock = AnthropicMessagesUserContentBlock | AnthropicMessagesAssistantInputContentBlock;
type CacheableBlock = Extract<ContentBlock, { cache_control?: unknown }>;

const isCacheableBlock = (block: ContentBlock): block is CacheableBlock =>
  block.type === 'text' || block.type === 'image' || block.type === 'tool_use' || block.type === 'tool_result';

const applyCacheControl = (payload: AnthropicMessagesPayload | AnthropicMessagesCountTokensPayload) => {
  if (payload.cache_control === undefined) return payload;
  const { cache_control: marker, ...rest } = payload;
  for (let index = rest.messages.length - 1; index >= 0; index--) {
    const message = rest.messages[index];
    if (typeof message.content === 'string') {
      const content = [{ type: 'text', text: message.content, cache_control: marker }] as const;
      return { ...rest, messages: rest.messages.with(index, { ...message, content: [...content] }) };
    }

    const slot = message.content.findLastIndex(isCacheableBlock);
    if (slot < 0) continue;
    const block = message.content[slot] as CacheableBlock;
    if (block.cache_control !== undefined) return rest;
    const content = message.content.with(slot, { ...block, cache_control: marker });
    return { ...rest, messages: rest.messages.with(index, { ...message, content } as AnthropicMessagesMessage) };
  }
  return rest;
};
// Older Copilot Messages schemas accept the marker on content blocks and reject it at the root.
// https://github.com/anthropics/anthropic-sdk-typescript/blob/a53f60d59ca904f3e79296586642aac3ce68ae02/src/resources/messages/messages.ts#L2909-L2913
// https://github.com/caozhiyuan/copilot-api/issues/269
export const applyTopLevelCacheControl = defineCopilotStage({
  name: 'copilot.anthropicMessages.applyTopLevelCacheControl',
  through: {
    request: { needs: ['request.anthropicMessages'], provides: ['request.anthropicMessages'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request(facts) {
      const payload = facts['request.anthropicMessages'];
      const next = applyCacheControl(payload);
      return { ...facts, 'request.anthropicMessages': move(next) };
    },
  })),
});
