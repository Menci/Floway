import { accountFacts, type ChatGPTAccountFacts, type ChatGPTOperation, type ChatGPTPipelineConfig, type ChatGPTRequest } from '../pipeline-facts.ts';
import { defineStage, move, type Handed } from '@floway-dev/pipeline';
import type { ProviderResponse, ProviderServices } from '@floway-dev/provider';

export const readChatGPTAccount = <O extends ChatGPTOperation>(config: ChatGPTPipelineConfig) => defineStage<ChatGPTRequest<O>, ChatGPTAccountFacts<O>, ProviderResponse, ProviderResponse, ProviderServices>({
  name: 'readChatGPTAccount',
  through: {
    request: { needs: [], consumes: [], provides: ['request.chatgpt.account'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next) => await next(move({ ...facts, 'request.chatgpt.account': accountFacts(await config.readAccount()) })) as Handed<ProviderResponse>,
});
