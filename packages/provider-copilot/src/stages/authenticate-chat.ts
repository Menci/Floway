import { getCopilotToken, isCopilotTokenFetchError, type CopilotAuth } from '../auth.ts';
import type { AuthenticatedChatFacts, CopilotChatFacts } from '../chat-facts.ts';
import { takeHttpResponse } from '@floway-dev/http/pipeline';
import { defineStage, move, secret } from '@floway-dev/pipeline';
import type { ChatProviderOperation, ProviderChatResponse, ProviderServices } from '@floway-dev/provider';

export const authenticateCopilotChat = (auth: CopilotAuth) => defineStage<CopilotChatFacts, AuthenticatedChatFacts, ProviderChatResponse<ChatProviderOperation>, ProviderChatResponse<ChatProviderOperation>, ProviderChatResponse<ChatProviderOperation>, ProviderServices>({
  name: 'authenticateCopilotChat',
  through: {
    request: { needs: ['request.http.callId', 'request.provider.modelKey'], consumes: [], provides: ['request.copilot.session'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  return: { provides: ['response.http.exchange', 'response.http.body', 'response.provider.modelKey', 'response.provider.called', 'response.provider.previousCalls', 'response.provider.output'] },
  execute: async (facts, next, use) => {
    const call = use.httpCall(facts['request.http.callId']);
    let entry;
    try { entry = await getCopilotToken(auth.id, auth.githubHost, auth.githubToken, call.fetcher, call.signal); } catch (error) {
      if (!isCopilotTokenFetchError(error)) throw error;
      const exchange = takeHttpResponse(new Response(error.body, { status: error.status, headers: error.headers }));
      return move({ ...facts, 'response.http.exchange': exchange, 'response.http.body': exchange.body, 'response.provider.modelKey': facts['request.provider.modelKey'], 'response.provider.called': false, 'response.provider.previousCalls': [], 'response.provider.output': null });
    }
    return move({ ...await next(move({ ...facts, 'request.copilot.session': { ...entry, token: secret(entry.token) } })) });
  },
});
