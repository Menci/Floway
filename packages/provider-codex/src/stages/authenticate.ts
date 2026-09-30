import { codexPlanObservation } from '../access-token.ts';
import { prepareCodexCall } from '../fetch.ts';
import { codexPlanSupportsImages } from '../models.ts';
import { codexCall, tokenFacts, type CodexAccountFacts, type CodexAuthenticatedFacts, type CodexOperation, type CodexPipelineConfig } from '../pipeline-facts.ts';
import { takeHttpResponse } from '@floway-dev/http/pipeline';
import { defineStage, move, type Handed } from '@floway-dev/pipeline';
import type { ProviderResponse, ProviderServices } from '@floway-dev/provider';

export const authenticateCodex = <O extends CodexOperation>(config: CodexPipelineConfig, operation: O) => defineStage<CodexAccountFacts<O>, CodexAuthenticatedFacts<O>, ProviderResponse, ProviderResponse, ProviderResponse & { 'response.provider.output': null }, ProviderServices>({
  name: 'authenticateCodex',
  through: {
    request: { needs: ['request.codex.account', 'request.provider.model', 'request.http.callId'], consumes: [], provides: ['request.codex.accessToken', 'request.codex.plan'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  return: { provides: ['response.http.exchange', 'response.http.body', 'response.provider.modelKey', 'response.provider.called', 'response.provider.previousCalls', 'response.provider.output'] },
  execute: async (facts, next, use) => {
    const model = facts['request.provider.model'];
    const ready = await prepareCodexCall(codexCall(config, facts, use, model));
    const failed = (response: Response) => {
      const exchange = takeHttpResponse(response);
      return move({ ...facts, 'response.http.exchange': exchange, 'response.http.body': exchange.body, 'response.provider.modelKey': model.id, 'response.provider.called': false, 'response.provider.previousCalls': [], 'response.provider.output': null });
    };
    if (!ready.ok) return failed(ready.response);
    const observedPlan = codexPlanObservation(ready.accessToken);
    const plan = observedPlan ?? (config.fallbackPlanType === undefined ? null : { planType: config.fallbackPlanType });
    if ((operation === 'openaiImagesGenerations' || operation === 'openaiImagesEdits') && plan !== null && !codexPlanSupportsImages(plan.planType)) {
      return failed(Response.json({ error: { type: 'image_tools_unavailable', message: 'ChatGPT Free accounts do not provide Codex image tools.' } }, { status: 403 }));
    }
    return await next(move({ ...facts, 'request.codex.accessToken': tokenFacts(ready.accessToken), 'request.codex.plan': plan })) as Handed<ProviderResponse>;
  },
});
