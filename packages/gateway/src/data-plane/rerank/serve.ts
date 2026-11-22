import type { UsageQuantities } from '../../repo/types.ts';
import { createGatewayHttpHandler } from '../pipeline/host.ts';
import { createNonChatPipeline, forwardHttp, httpSucceeded, invalidUpstreamResponse, measured, readHttpBytes, requestBytes, scalarHttpAttempt } from '../pipeline/non-chat.ts';
import { Bytes } from '@floway-dev/pipeline';
import { parseDecimalString, type RerankSourceProtocol, type RerankTarget } from '@floway-dev/protocols/common';
import { type CanonicalRerankRequest, type CanonicalRerankResponse, parseRerankRequest, parseRerankResponse, parseRerankUsage, renderRerankResponse, rerankRequestIncompatibility } from '@floway-dev/protocols/rerank';
import type { ProviderTargetOutput } from '@floway-dev/provider';

const measure = (usage: Pick<CanonicalRerankResponse, 'searchUnits' | 'totalTokens'> | undefined) => {
  const quantities: UsageQuantities = {};
  if (usage?.searchUnits !== undefined) quantities.rerank_searches = parseDecimalString(String(usage.searchUnits));
  if (usage?.totalTokens !== undefined) quantities.input_tokens = parseDecimalString(String(usage.totalTokens));
  return measured({ quantities, pricingFacts: usage?.totalTokens === undefined ? {} : { inputTokens: usage.totalTokens }, dumpTokenUsage: null });
};

export const rerank = (sourceProtocol: RerankSourceProtocol) => createGatewayHttpHandler(
  createNonChatPipeline<CanonicalRerankRequest, ProviderTargetOutput<RerankTarget>>({
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
      } catch {
        return { error: 'Rerank request body must be valid JSON' };
      }
      try {
        const { model, request } = parseRerankRequest(sourceProtocol, body);
        return { model, payload: request };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
    provider: pipelines => pipelines.rerank,
    providerExit: ['response.target'],
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
    respond: async (response, request, identity, env) => {
      const http = forwardHttp(response['response.http']);
      if (!httpSucceeded(http)) return scalarHttpAttempt(env, http, identity);
      const target = response['response.target'].protocol;
      const sameProtocol = sourceProtocol === target;
      const bytes = await readHttpBytes(http.body);
      let body: unknown;
      let usage: ReturnType<typeof parseRerankUsage> | undefined;
      try {
        body = JSON.parse(bytes.utf8());
        usage = parseRerankUsage(target, body);
      } catch (error) {
        if (!sameProtocol) return scalarHttpAttempt(env, invalidUpstreamResponse(error, env.clock()), identity, measure(usage));
        console.warn(`rerank: failed to parse same-protocol 2xx upstream body or usage for ${sourceProtocol}; usage row will be request-only`, error instanceof Error ? error.message : String(error));
      }
      const observed = measure(usage);
      if (sameProtocol) return scalarHttpAttempt(env, { ...http, body: http.body === null ? null : bytes }, identity, observed);
      try {
        const canonical = parseRerankResponse(target, body);
        const result = renderRerankResponse(sourceProtocol, target, canonical, request['request.payload']);
        return scalarHttpAttempt(env, { ...http, body: Bytes.fromUtf8(JSON.stringify(result)) }, identity, observed);
      } catch (error) {
        return scalarHttpAttempt(env, invalidUpstreamResponse(error, env.clock()), identity, observed);
      }
    },
  }),
  { errorStatus: () => 502, performanceOperation: 'rerank' },
);
