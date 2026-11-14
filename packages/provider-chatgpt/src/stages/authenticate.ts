import { chatgptPlanObservation } from '../access-token.ts';
import { prepareChatGPTCall } from '../fetch.ts';
import { chatgptPlanSupportsImages } from '../models.ts';
import { chatgptCall, tokenFacts, type ChatGPTAccountFacts, type ChatGPTAuthenticatedFacts, type ChatGPTOperation, type ChatGPTPipelineConfig } from '../pipeline-facts.ts';
import { takeHttpResponse } from '@floway-dev/http/pipeline';
import { defineStage, move, type Handed } from '@floway-dev/pipeline';
import type { ProviderResponse, ProviderServices } from '@floway-dev/provider';

export const authenticateChatGPT = <O extends ChatGPTOperation>(config: ChatGPTPipelineConfig, operation: O) => defineStage<ChatGPTAccountFacts<O>, ChatGPTAuthenticatedFacts<O>, ProviderResponse, ProviderResponse, ProviderResponse, ProviderServices>({
  name: 'authenticateChatGPT',
  through: {
    request: { needs: ['request.chatgpt.account', 'request.provider.model', 'request.http.callId'], consumes: [], provides: ['request.chatgpt.accessToken', 'request.chatgpt.plan'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  return: { provides: ['response.http.exchange', 'response.http.body', 'response.provider.modelKey', 'response.provider.called', 'response.provider.previousCalls'] },
  execute: async (facts, next, use) => {
    const model = facts['request.provider.model'];
    const ready = await prepareChatGPTCall(chatgptCall(config, facts, use, model));
    const failed = (response: Response) => {
      const exchange = takeHttpResponse(response);
      return move({ ...facts, 'response.http.exchange': exchange, 'response.http.body': exchange.body, 'response.provider.modelKey': model.id, 'response.provider.called': false, 'response.provider.previousCalls': [] });
    };
    if (!ready.ok) return failed(ready.response);
    const observedPlan = chatgptPlanObservation(ready.accessToken);
    const plan = observedPlan ?? (config.fallbackPlanType === undefined ? null : { planType: config.fallbackPlanType });
    if (operation !== 'alphaSearch' && plan !== null && !chatgptPlanSupportsImages(plan.planType)) {
      return failed(Response.json({ error: { type: 'image_tools_unavailable', message: 'ChatGPT Free accounts do not provide Codex image tools.' } }, { status: 403 }));
    }
    return await next(move({ ...facts, 'request.chatgpt.accessToken': tokenFacts(ready.accessToken), 'request.chatgpt.plan': plan })) as Handed<ProviderResponse>;
  },
});
