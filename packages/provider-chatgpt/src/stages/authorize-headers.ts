import type { ChatGPTHttpFacts } from '../pipeline-facts.ts';
import type { HttpResponseFacts } from '@floway-dev/http/pipeline';
import { defineStage, move, secret, type Handed } from '@floway-dev/pipeline';
import { replaceHttpHeader, type ProviderServices } from '@floway-dev/provider';

export const authorizeChatGPTHeaders = defineStage<ChatGPTHttpFacts, ChatGPTHttpFacts, HttpResponseFacts, HttpResponseFacts, ProviderServices>({
  name: 'authorizeChatGPTHeaders',
  through: {
    request: {
      needs: ['request.chatgpt.account', 'request.chatgpt.accessToken', 'request.http.headers'],
      consumes: ['request.http.headers'],
      provides: ['request.http.headers'],
    },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next) => {
    const accountId = facts['request.chatgpt.account'].chatgptAccountId;
    let headers = replaceHttpHeader(facts['request.http.headers'], 'authorization', secret(`Bearer ${facts['request.chatgpt.accessToken'].token.reveal()}`));
    if (accountId !== null) headers = replaceHttpHeader(headers, 'chatgpt-account-id', accountId);
    return await next(move({ ...facts, 'request.http.headers': headers })) as Handed<HttpResponseFacts>;
  },
});
