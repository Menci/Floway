import { defineCopilotStage } from '../facts.ts';
import { setHeader } from '@floway-dev/http';
import { move, transform } from '@floway-dev/pipeline';
import type { AnthropicMessagesAssistantMessage, AnthropicMessagesUserMessage } from '@floway-dev/protocols/anthropic-messages';
const contentHasImage = (content: AnthropicMessagesUserMessage['content'] | AnthropicMessagesAssistantMessage['content']): boolean => {
  if (!Array.isArray(content)) return false;
  return content.some(block => {
    if (block.type === 'image') return true;
    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      return block.content.some(inner => inner.type === 'image');
    }
    return false;
  });
};
// https://github.com/caozhiyuan/copilot-api/commit/1f6b98924ae092db9b2010846c32e5cbf10817df
export const setVisionHeader = defineCopilotStage({
  name: 'copilot.anthropicMessages.setVisionHeader',
  through: {
    request: { needs: ['request.anthropicMessages', 'request.http'], provides: ['request.http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request(facts) {
      const payload = facts['request.anthropicMessages'];
      const request = facts['request.http'];
      if (!payload.messages.some(message => contentHasImage(message.content))) return facts;
      const headers = setHeader(request.headers, 'copilot-vision-request', 'true');
      return { ...facts, 'request.http': move({ ...request, headers }) };
    },
  })),
});
