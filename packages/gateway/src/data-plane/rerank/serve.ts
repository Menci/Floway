import type { UsageQuantities } from '../../repo/types.ts';
import { createGatewayHttpHandler } from '../pipeline/host.ts';
import { createNonChatPipeline, forwardHttp, invalidUpstreamResponse, measured, requestBytes, scalarHttpAttempt, transportHttpAttempt } from '../pipeline/non-chat.ts';
import { failedRender } from '../pipeline/render.ts';
import { rerankProviderTargets } from '../providers/upstreams.ts';
import { Bytes } from '@floway-dev/pipeline';
import { parseDecimalString, type RerankSourceProtocol } from '@floway-dev/protocols/common';
import { type CanonicalRerankResponse, parseRerankRequest, parseRerankResponse, parseRerankUsage, renderRerankResponse, rerankRequestIncompatibility } from '@floway-dev/protocols/rerank';
import { readHttpBody } from '@floway-dev/provider';

const measure = (usage: Pick<CanonicalRerankResponse, 'searchUnits' | 'totalTokens'> | undefined) => {
  const quantities: UsageQuantities = {};
  if (usage?.searchUnits !== undefined) quantities.rerank_searches = parseDecimalString(String(usage.searchUnits));
  if (usage?.totalTokens !== undefined) quantities.input_tokens = parseDecimalString(String(usage.totalTokens));
  return measured({ quantities, pricingFacts: usage?.totalTokens === undefined ? {} : { inputTokens: usage.totalTokens }, dumpTokenUsage: null });
};

export const rerank = (sourceProtocol: RerankSourceProtocol) => createGatewayHttpHandler(
  createNonChatPipeline({
    name: `rerank.${sourceProtocol}`,
    sourceApi: '/rerank',
    operation: 'rerank',
    kind: 'rerank',
    unsupportedMessage: model => `Model ${model} does not support rerank.`,
    parse: http => {
      const bytes = requestBytes(http);
      let body: unknown;
      try {
        body = JSON.parse(bytes.utf8());
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        return { error: 'Rerank request body must be valid JSON' };
      }
      try {
        const { model, request } = parseRerankRequest(sourceProtocol, body);
        return { model, payload: request };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
    outcomeKey: 'response.rerank',
    targets: rerankProviderTargets,
    select: (candidates, facts) => {
      const routable = candidates.flatMap(candidate => {
        const target = candidate.providerModel.rerankTarget;
        return candidate.endpoints.rerank === undefined || target === undefined ? [] : [{
          candidate,
          reason: rerankRequestIncompatibility(target.protocol, facts['request.payload']),
        }];
      });
      const viable = routable.flatMap(({ candidate, reason }) => reason === null ? [candidate] : []);
      if (routable.length === 0 || viable.length > 0) return viable;
      const model = facts['request.model'];
      return {
        model, failedUpstreams: [], status: 400,
        message: `Model ${model} does not support this rerank request: ${[...new Set(routable.map(item => item.reason))].join('; ')}.`,
      };
    },
    respond: async (response, request, identity, scope) => {
      const http = forwardHttp(response['response.http']);
      const target = response['response.rerank'].target.protocol;
      const sameProtocol = sourceProtocol === target;
      const read = await readHttpBody(http.body);
      if (!read.ok) return transportHttpAttempt(scope, http, identity, read.error);
      const { bytes } = read;
      let body: unknown;
      let usage: ReturnType<typeof parseRerankUsage> | undefined;
      try {
        body = JSON.parse(bytes.utf8());
        usage = parseRerankUsage(target, body);
      } catch (error) {
        if (!sameProtocol) return scalarHttpAttempt(scope, invalidUpstreamResponse(error, scope.clock()), identity, measure(usage), failedRender('collect-error', error));
        scope.log.warn(`Rerank: failed to parse same-protocol 2xx upstream body or usage for ${sourceProtocol}; usage row will be request-only`, { message: error instanceof Error ? error.message : String(error) });
      }
      const observed = measure(usage);
      if (sameProtocol) return scalarHttpAttempt(scope, { ...http, body: http.body === null ? null : bytes }, identity, observed);
      let result: ReturnType<typeof renderRerankResponse>;
      try {
        const canonical = parseRerankResponse(target, body);
        result = renderRerankResponse(sourceProtocol, target, canonical, request['request.payload']);
      } catch (error) {
        return scalarHttpAttempt(scope, invalidUpstreamResponse(error, scope.clock()), identity, observed, failedRender('collect-error', error));
      }
      return scalarHttpAttempt(scope, { ...http, body: Bytes.fromUtf8(JSON.stringify(result)) }, identity, observed);
    },
  }),
  { errorStatus: () => 502 },
);
