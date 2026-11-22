import type { UsageQuantities } from '../../repo/types.ts';
import { createGatewayHttpHandler } from '../pipeline/host.ts';
import { createNonChatPipeline, forwardHttp, httpSucceeded, invalidUpstreamResponse, measured, readHttpBytes, requestBytes, scalarHttpAttempt } from '../pipeline/non-chat.ts';
import { failedRender } from '../pipeline/render.ts';
import { Bytes } from '@floway-dev/pipeline';
import { type DecisionProtocol, type DecisionTarget, parseDecimalString, parseJSONWithRawNumbers } from '@floway-dev/protocols/common';
import { type CanonicalDecisionRequest, parseDecisionRequest, parseDecisionResponse, parseDecisionUsage, renderDecisionResponse } from '@floway-dev/protocols/decision';
import type { ProviderTargetOutput } from '@floway-dev/provider';

const measure = (inputTokens: number | undefined) => {
  const quantities: UsageQuantities = inputTokens === undefined ? {} : { input_tokens: parseDecimalString(String(inputTokens)) };
  return measured({ quantities, pricingFacts: inputTokens === undefined ? {} : { inputTokens }, dumpTokenUsage: null });
};

export const decision = (sourceProtocol: DecisionProtocol) => createGatewayHttpHandler(
  createNonChatPipeline<CanonicalDecisionRequest, ProviderTargetOutput<DecisionTarget>>({
    name: `decision.${sourceProtocol}`,
    sourceApi: '/decision',
    operation: 'decision',
    kind: 'decision',
    unsupportedMessage: model => `Model ${model} does not support decision.`,
    parse: http => {
      const bytes = requestBytes(http);
      let body: unknown;
      try {
        body = parseJSONWithRawNumbers(bytes.utf8());
      } catch {
        return { error: 'Decision request body must be valid JSON' };
      }
      try {
        const { model, request } = parseDecisionRequest(sourceProtocol, body);
        return { model, payload: request };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
    provider: pipelines => pipelines.decision,
    providerExit: ['response.target'],
    select: candidates => candidates.filter(candidate => candidate.endpoints.decision !== undefined && candidate.providerModel.decisionTarget !== undefined),
    respond: async (response, request, identity, env) => {
      const http = forwardHttp(response['response.http']);
      if (!httpSucceeded(http)) return scalarHttpAttempt(env, http, identity);
      const target = response['response.target'].protocol;
      const sameProtocol = sourceProtocol === target;
      const bytes = await readHttpBytes(http.body);
      let body: Record<string, unknown> | undefined;
      try {
        // Raw JSON preserves the upstream digits in cross-dialect probabilities.
        body = parseJSONWithRawNumbers(bytes.utf8()) as Record<string, unknown>;
      } catch (error) {
        if (!sameProtocol) return scalarHttpAttempt(env, invalidUpstreamResponse(error, env.clock()), identity, undefined, failedRender('collect-error', error));
        console.warn(`decision: failed to parse 2xx upstream body for ${request['request.model']}; usage row will be request-only`, error instanceof Error ? error.message : String(error));
      }

      if (body === undefined) return scalarHttpAttempt(env, { ...http, body: http.body === null ? null : bytes }, identity);
      const usage = measure(parseDecisionUsage(body).inputTokens);
      if (sameProtocol) return scalarHttpAttempt(env, { ...http, body: http.body === null ? null : bytes }, identity, usage);
      try {
        const result = renderDecisionResponse(sourceProtocol, parseDecisionResponse(target, body));
        return scalarHttpAttempt(env, { ...http, body: Bytes.fromUtf8(JSON.stringify(result)) }, identity, usage);
      } catch (error) {
        return scalarHttpAttempt(env, invalidUpstreamResponse(error, env.clock()), identity, usage, failedRender('collect-error', error));
      }
    },
  }),
  { errorStatus: () => 502, performanceOperation: 'decision' },
);
