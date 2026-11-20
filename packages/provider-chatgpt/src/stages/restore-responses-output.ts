import { restoreChatGPTResponsesOutput as restoreFrames } from '../responses-output.ts';
import type { ChatGPTResponsesHttpFacts } from './prepare-responses.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { ProviderChatResponse, ProviderChatServices } from '@floway-dev/provider';

export const restoreChatGPTResponsesOutput = defineStage<ChatGPTResponsesHttpFacts, ChatGPTResponsesHttpFacts, ProviderChatResponse<'openaiResponses'>, ProviderChatResponse<'openaiResponses'>, ProviderChatServices>({
  name: 'restoreChatGPTResponsesOutput',
  through: {
    request: { needs: [], consumes: [], provides: [] },
    response: { needs: ['response.provider.output'], consumes: ['response.provider.output'], provides: ['response.provider.output'] },
  },
  execute: async (facts, next, use) => {
    const back = await next(move({ ...facts }));
    const output = back['response.provider.output'];
    return output !== null && 'kind' in output && output.kind === 'stream'
      ? move({ ...back, 'response.provider.output': { kind: 'stream' as const, frames: use.recordProtocolFrames(restoreFrames(output.frames)) } })
      : move({ ...back });
  },
});
