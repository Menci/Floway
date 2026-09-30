import { codexPlanObservation } from '../access-token.ts';
import { refreshAccessTokenForRetry } from '../fetch.ts';
import { codexPlanSupportsImages } from '../models.ts';
import { codexCall, tokenFacts, type CodexHttpFacts, type CodexOperation, type CodexPipelineConfig } from '../pipeline-facts.ts';
import { takeHttpResponse, type HttpResponseFacts } from '@floway-dev/http/pipeline';
import { defineStage, move } from '@floway-dev/pipeline';
import type { ProviderCallResponse, ProviderServices } from '@floway-dev/provider';

export const retryCodexAccess = (config: CodexPipelineConfig, operation: CodexOperation) => defineStage<CodexHttpFacts & { 'request.provider.responsesAction'?: 'generate' | 'compact' }, CodexHttpFacts, HttpResponseFacts, ProviderCallResponse & { 'response.provider.responsesAction'?: 'generate' | 'compact' }, ProviderServices>({
  name: 'retryCodexAccess',
  through: {
    request: { needs: ['request.codex.account', 'request.codex.accessToken', 'request.codex.plan', 'request.codex.model', 'request.codex.modelKey', 'request.http.callId'], consumes: ['request.codex.accessToken', 'request.codex.plan'], provides: ['request.codex.accessToken', 'request.codex.plan'] },
    response: { needs: ['response.http.exchange', 'response.http.body'], consumes: ['response.http.exchange', 'response.http.body'], provides: ['response.http.exchange', 'response.http.body', 'response.provider.called', 'response.provider.previousCalls', ...(operation === 'openaiResponses' || operation === 'openaiResponsesCompact' ? ['response.provider.responsesAction' as const] : [])] },
  },
  execute: async (facts, next, use) => {
    const first = await next(move({ ...facts }));
    const exchange = first['response.http.exchange'];
    if (exchange.type !== 'response' || exchange.status !== 401 || facts['request.codex.account'].refresh_token === null) return move({ ...first, 'response.provider.called': exchange.type === 'response', 'response.provider.previousCalls': [] });
    if (exchange.body !== null) await exchange.body[Symbol.asyncDispose]();
    const failedToken = facts['request.codex.accessToken'];
    const fresh = await refreshAccessTokenForRetry(codexCall(config, facts, use, facts['request.codex.model']), { ...failedToken, token: failedToken.token.reveal() }, facts['request.codex.plan'] ?? undefined);
    const declined = (response: Response) => {
      const nextExchange = takeHttpResponse(response);
      return move({ ...first, 'response.http.exchange': nextExchange, 'response.http.body': nextExchange.body, 'response.provider.called': false, 'response.provider.previousCalls': [{ modelKey: facts['request.codex.modelKey'] }], ...(operation === 'openaiResponses' || operation === 'openaiResponsesCompact' ? { 'response.provider.responsesAction': facts['request.provider.responsesAction']! } : {}) });
    };
    if (!fresh.ok) return declined(fresh.response);
    const plan = codexPlanObservation(fresh.accessToken) ?? facts['request.codex.plan'];
    if ((operation === 'openaiImagesGenerations' || operation === 'openaiImagesEdits') && plan !== null && !codexPlanSupportsImages(plan.planType)) return declined(Response.json({ error: { type: 'image_tools_unavailable', message: 'ChatGPT Free accounts do not provide Codex image tools.' } }, { status: 403 }));
    const retried = await next(move({ ...facts, 'request.codex.accessToken': tokenFacts(fresh.accessToken), 'request.codex.plan': plan }));
    return move({ ...retried, 'response.provider.called': retried['response.http.exchange'].type === 'response', 'response.provider.previousCalls': [{ modelKey: facts['request.codex.modelKey'] }], ...(operation === 'openaiResponses' || operation === 'openaiResponsesCompact' ? { 'response.provider.responsesAction': facts['request.provider.responsesAction']! } : {}) });
  },
});
