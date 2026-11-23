import type { UsageQuantities } from '../../repo/types.ts';
import { createGatewayHttpHandler } from '../pipeline/host.ts';
import { createNonChatPipeline, forwardHttp, invalidUpstreamResponse, measured, requestBytes, scalarHttpAttempt, transportHttpAttempt } from '../pipeline/non-chat.ts';
import { failedRender } from '../pipeline/render.ts';
import { decisionProviderTargets } from '../providers/upstreams.ts';
import { Bytes } from '@floway-dev/pipeline';
import { type DecisionProtocol, isJsonObject, parseDecimalString, parseJSONWithRawNumbers } from '@floway-dev/protocols/common';
import { parseDecisionRequest, parseDecisionResponse, parseDecisionUsage, renderDecisionResponse } from '@floway-dev/protocols/decision';
import { readHttpBody } from '@floway-dev/provider';

const measure = (inputTokens: number | undefined) => {
  const quantities: UsageQuantities = inputTokens === undefined ? {} : { input_tokens: parseDecimalString(String(inputTokens)) };
  return measured({ quantities, pricingFacts: inputTokens === undefined ? {} : { inputTokens }, dumpTokenUsage: null });
};

export const decision = (sourceProtocol: DecisionProtocol) => createGatewayHttpHandler(
  createNonChatPipeline({
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
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        return { error: 'Decision request body must be valid JSON' };
      }
      try {
        const { model, request } = parseDecisionRequest(sourceProtocol, body);
        return { model, payload: request };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
    outcomeKey: 'response.decision',
    targets: decisionProviderTargets,
    select: candidates => candidates.filter(candidate => candidate.endpoints.decision !== undefined && candidate.providerModel.decisionTarget !== undefined),
    respond: async (response, request, identity, scope) => {
      const http = forwardHttp(response['response.http']);
      const target = response['response.decision'].target.protocol;
      const sameProtocol = sourceProtocol === target;
      const read = await readHttpBody(http.body);
      if (!read.ok) return transportHttpAttempt(scope, http, identity, read.error);
      const { bytes } = read;
      let body: unknown;
      try {
        // Raw JSON preserves the upstream digits in cross-dialect probabilities.
        body = parseJSONWithRawNumbers(bytes.utf8());
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        if (!sameProtocol) return scalarHttpAttempt(scope, invalidUpstreamResponse(error, scope.clock()), identity, undefined, failedRender('collect-error', error));
        scope.log.warn(`Decision: failed to parse 2xx upstream body for ${request['request.model']}; usage row will be request-only`, { message: error.message });
      }

      const usage = measure(isJsonObject(body) ? parseDecisionUsage(body).inputTokens : undefined);
      if (sameProtocol) return scalarHttpAttempt(scope, { ...http, body: http.body === null ? null : bytes }, identity, usage);
      if (!isJsonObject(body)) {
        const error = new Error('Decision response body must be an object');
        return scalarHttpAttempt(scope, invalidUpstreamResponse(error, scope.clock()), identity, usage, failedRender('collect-error', error));
      }
      let result: ReturnType<typeof renderDecisionResponse>;
      try {
        result = renderDecisionResponse(sourceProtocol, parseDecisionResponse(target, body));
      } catch (error) {
        return scalarHttpAttempt(scope, invalidUpstreamResponse(error, scope.clock()), identity, usage, failedRender('collect-error', error));
      }
      return scalarHttpAttempt(scope, { ...http, body: Bytes.fromUtf8(JSON.stringify(result)) }, identity, usage);
    },
  }),
  { errorStatus: () => 502 },
);
