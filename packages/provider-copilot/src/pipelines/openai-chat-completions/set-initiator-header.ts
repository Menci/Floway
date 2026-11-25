import { defineCopilotStage } from '../facts.ts';
import { setHeader } from '@floway-dev/http';
import { move, transform } from '@floway-dev/pipeline';

// A translated tool-result image can become a separate user message. The wire message role governs attribution.
// https://github.com/caozhiyuan/copilot-api/blob/cd0d0182eb4b9bf68a3376dc79728afa7f42ce07/src/services/copilot/create-chat-completions.ts#L28-L49
// https://github.com/microsoft/vscode/blob/fb5e582d1c8edb9ad0a69e50fe6f508a8c095466/extensions/copilot/src/extension/prompt/node/chatMLFetcher.ts#L1453-L1474
export const setInitiatorHeader = defineCopilotStage({
  name: 'copilot.openaiChatCompletions.setInitiatorHeader',
  through: {
    request: { needs: ['request.openaiChatCompletions', 'request.http'], provides: ['request.http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request(facts) {
      const payload = facts['request.openaiChatCompletions'];
      const request = facts['request.http'];
      const last = payload.messages.at(-1);
      const agentInitiated = last?.role === 'assistant' || last?.role === 'tool';
      const headers = setHeader(request.headers, 'x-initiator', agentInitiated ? 'agent' : 'user');
      return { ...facts, 'request.http': move({ ...request, headers }) };
    },
  })),
});
