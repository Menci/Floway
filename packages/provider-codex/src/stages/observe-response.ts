import { classifyCodexUnauthorizedResponse, decodeCodexUpstreamError, writeCodexQuotaObservation } from '../backend.ts';
import { codexCall, type CodexHttpFacts, type CodexOperation, type CodexPipelineConfig } from '../pipeline-facts.ts';
import { exchangeResponse, takeHttpResponse, type HttpResponseFacts } from '@floway-dev/http/pipeline';
import { defer, defineStage, move, setRelease, type Deferred } from '@floway-dev/pipeline';
import type { ProviderServices } from '@floway-dev/provider';

type Observed = HttpResponseFacts & { 'response.codex.background': Deferred<unknown>; 'response.codex.failureBody': unknown };

export const observeCodexResponse = (config: CodexPipelineConfig, operation: CodexOperation) => defineStage<CodexHttpFacts, CodexHttpFacts, HttpResponseFacts, Observed, ProviderServices>({
  name: 'observeCodexResponse',
  through: {
    request: { needs: ['request.codex.account', 'request.codex.model', 'request.http.callId'], consumes: [], provides: [] },
    response: { needs: ['response.http.exchange', 'response.http.body'], consumes: ['response.http.exchange', 'response.http.body'], provides: ['response.http.exchange', 'response.http.body', 'response.codex.background', 'response.codex.failureBody'] },
  },
  execute: async (facts, next, use) => {
    const back = await next(move({ ...facts }));
    const exchange = back['response.http.exchange'];
    const pending: Promise<unknown>[] = [];
    if (exchange.type === 'transportFailure') return move({ ...back, 'response.codex.background': defer(Promise.all(pending)), 'response.codex.failureBody': null });
    const call = codexCall(config, facts, use, facts['request.codex.model']);
    const response = exchangeResponse(exchange);
    let classified: Response;
    let failureBody: unknown = null;
    if (exchange.status === 401) {
      const parsed = decodeCodexUpstreamError(await response.text());
      if (exchange.body !== null) setRelease(exchange.body, async () => {});
      failureBody = parsed.body;
      if (call.account.refresh_token === null) pending.push(call.effects.persistTerminalState('session_terminated', parsed.message));
      classified = await classifyCodexUnauthorizedResponse(call, response, parsed);
    } else {
      classified = response;
      if (response.ok || response.status === 429) {
        const policy = operation === 'alphaSearch' || operation === 'openaiResponses' || operation === 'openaiResponsesCompact' ? 'always' : 'when-present';
        const work = writeCodexQuotaObservation(call, response, response.status === 429, policy);
        if (work !== null) pending.push(work);
      }
    }
    const retained = classified === response ? exchange : takeHttpResponse(classified);
    return move({ ...back, 'response.http.exchange': retained, 'response.http.body': retained.body, 'response.codex.background': defer(Promise.all(pending)), 'response.codex.failureBody': failureBody });
  },
});
