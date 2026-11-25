import { defineCopilotStage } from '../facts.ts';
import { setHeader } from '@floway-dev/http';
import { move, transform } from '@floway-dev/pipeline';

// https://github.com/caozhiyuan/copilot-api/blob/cd0d0182eb4b9bf68a3376dc79728afa7f42ce07/src/services/copilot/create-chat-completions.ts#L28-L49
export const setVisionHeader = defineCopilotStage({
  name: 'copilot.openaiChatCompletions.setVisionHeader',
  through: {
    request: { needs: ['request.openaiChatCompletions', 'request.http'], provides: ['request.http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request(facts) {
      const payload = facts['request.openaiChatCompletions'];
      const request = facts['request.http'];
      const hasImage = payload.messages.some(message =>
        Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'));
      if (!hasImage) return facts;
      const headers = setHeader(request.headers, 'copilot-vision-request', 'true');
      return { ...facts, 'request.http': move({ ...request, headers }) };
    },
  })),
});
