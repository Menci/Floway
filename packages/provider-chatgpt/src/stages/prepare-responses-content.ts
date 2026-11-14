import { prepareChatGPTResponsesContent, type PreparedChatGPTResponsesRequest } from '../backend.ts';
import { accountValue, type ChatGPTAccountFacts } from '../pipeline-facts.ts';
import { defineStage, isSecret, move } from '@floway-dev/pipeline';
import type { ProviderChatResponse } from '@floway-dev/provider';

export interface ChatGPTPreparedResponsesFacts { 'request.chatgpt.responsesPrepared': PreparedChatGPTResponsesRequest }
export const prepareChatGPTResponsesPayload = <O extends 'openaiResponses' | 'openaiResponsesCompact'>() => defineStage<ChatGPTAccountFacts<O> & { 'request.provider.responsesAction': 'generate' | 'compact' }, ChatGPTAccountFacts<O> & ChatGPTPreparedResponsesFacts, ProviderChatResponse<O>, ProviderChatResponse<O>>({
  name: 'prepareChatGPTResponsesPayload',
  through: { request: { needs: ['request.provider.model', 'request.provider.payload', 'request.http.headers', 'request.chatgpt.account', 'request.provider.responsesAction'], consumes: [], provides: ['request.chatgpt.responsesPrepared'] }, response: { needs: [], consumes: [], provides: [] } },
  execute: async (facts, next) => {
    const headers = new Headers(facts['request.http.headers'].map(([name, value]): [string, string] => [name, isSecret(value) ? value.reveal() : value]));
    const prepared = prepareChatGPTResponsesContent({ account: accountValue(facts['request.chatgpt.account']), model: facts['request.provider.model'], body: facts['request.provider.payload'], headers }, facts['request.provider.responsesAction']);
    return move({ ...await next(move({ ...facts, 'request.chatgpt.responsesPrepared': prepared })) });
  },
});
