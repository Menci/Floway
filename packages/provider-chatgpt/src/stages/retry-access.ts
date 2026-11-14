import { chatgptPlanObservation } from '../access-token.ts';
import { refreshAccessTokenForRetry } from '../fetch.ts';
import { chatgptPlanSupportsImages } from '../models.ts';
import { chatgptCall, tokenFacts, type ChatGPTHttpFacts, type ChatGPTOperation, type ChatGPTPipelineConfig } from '../pipeline-facts.ts';
import { takeHttpResponse, type HttpResponseFacts } from '@floway-dev/http/pipeline';
import { defineStage, move } from '@floway-dev/pipeline';
import type { ProviderCallResponse, ProviderServices } from '@floway-dev/provider';

export const retryChatGPTAccess = (config: ChatGPTPipelineConfig, operation: ChatGPTOperation) => defineStage<ChatGPTHttpFacts, ChatGPTHttpFacts, HttpResponseFacts, ProviderCallResponse, ProviderServices>({
  name: 'retryChatGPTAccess',
  through: {
    request: { needs: ['request.chatgpt.account', 'request.chatgpt.accessToken', 'request.chatgpt.plan', 'request.chatgpt.model', 'request.chatgpt.modelKey', 'request.http.callId'], consumes: ['request.chatgpt.accessToken', 'request.chatgpt.plan'], provides: ['request.chatgpt.accessToken', 'request.chatgpt.plan'] },
    response: { needs: ['response.http.exchange', 'response.http.body'], consumes: ['response.http.exchange', 'response.http.body'], provides: ['response.http.exchange', 'response.http.body', 'response.provider.called', 'response.provider.previousCalls'] },
  },
  execute: async (facts, next, use) => {
    const first = await next(move({ ...facts }));
    const exchange = first['response.http.exchange'];
    if (exchange.type !== 'response' || exchange.status !== 401 || facts['request.chatgpt.account'].refresh_token === null) return move({ ...first, 'response.provider.called': exchange.type === 'response', 'response.provider.previousCalls': [] });
    if (exchange.body !== null) await exchange.body[Symbol.asyncDispose]();
    const failedToken = facts['request.chatgpt.accessToken'];
    const fresh = await refreshAccessTokenForRetry(chatgptCall(config, facts, use, facts['request.chatgpt.model']), { ...failedToken, token: failedToken.token.reveal() }, facts['request.chatgpt.plan'] ?? undefined);
    const declined = (response: Response) => {
      const nextExchange = takeHttpResponse(response);
      return move({ ...first, 'response.http.exchange': nextExchange, 'response.http.body': nextExchange.body, 'response.provider.called': false, 'response.provider.previousCalls': [{ modelKey: facts['request.chatgpt.modelKey'] }] });
    };
    if (!fresh.ok) return declined(fresh.response);
    const plan = chatgptPlanObservation(fresh.accessToken) ?? facts['request.chatgpt.plan'];
    if (operation !== 'alphaSearch' && plan !== null && !chatgptPlanSupportsImages(plan.planType)) return declined(Response.json({ error: { type: 'image_tools_unavailable', message: 'ChatGPT Free accounts do not provide Codex image tools.' } }, { status: 403 }));
    const retried = await next(move({ ...facts, 'request.chatgpt.accessToken': tokenFacts(fresh.accessToken), 'request.chatgpt.plan': plan }));
    return move({ ...retried, 'response.provider.called': retried['response.http.exchange'].type === 'response', 'response.provider.previousCalls': [{ modelKey: facts['request.chatgpt.modelKey'] }] });
  },
});
