import { projectMovedChatGPTResponsesFields } from '../responses-lite.ts';
import type { ChatGPTResponsesHttpFacts } from './prepare-responses.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { ProviderChatResponse, ProviderChatServices } from '@floway-dev/provider';

export const projectChatGPTMovedResponsesFields = defineStage<ChatGPTResponsesHttpFacts, ChatGPTResponsesHttpFacts, ProviderChatResponse<'openaiResponses'>, ProviderChatResponse<'openaiResponses'>, ProviderChatServices>({
  name: 'projectChatGPTMovedResponsesFields',
  through: {
    request: { needs: ['request.chatgpt.movedResponsesFields'], consumes: [], provides: [] },
    response: { needs: ['response.provider.output'], consumes: ['response.provider.output'], provides: ['response.provider.output'] },
  },
  execute: async (facts, next, use) => {
    const back = await next(move({ ...facts }));
    const movedFields = facts['request.chatgpt.movedResponsesFields'];
    const output = back['response.provider.output'];
    return Object.keys(movedFields).length > 0 && output !== null && 'kind' in output && output.kind === 'stream'
      ? move({ ...back, 'response.provider.output': { kind: 'stream' as const, frames: use.recordProtocolFrames(projectMovedChatGPTResponsesFields(output.frames, movedFields)) } })
      : move({ ...back });
  },
});
