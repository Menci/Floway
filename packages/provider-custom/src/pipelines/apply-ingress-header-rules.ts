import { upstreamConfig } from './prepare-request.ts';
import { filterHeaders, getHeaders, type HeaderEntry, type HttpRequestFact } from '@floway-dev/http';
import { factSpace, move, transform } from '@floway-dev/pipeline';
import type { GatewayFacts } from '@floway-dev/provider';

const { defineStage } = factSpace<Pick<GatewayFacts, 'request.http' | 'provider.upstream'>>();

const rebuildHeaders = (request: HttpRequestFact, rules: ReturnType<typeof upstreamConfig>['ingressHeadersRules'], allowAnthropicBeta: boolean): HeaderEntry[] => {
  const headers = filterHeaders(request.headers, name => allowAnthropicBeta && name === 'anthropic-beta');
  for (const [name, namedRules] of Map.groupBy(rules, rule => rule.key)) {
    for (const { value } of namedRules) {
      if (value !== null) headers.push([name, value]);
      else for (const admitted of getHeaders(request.headers, name)) headers.push([name, admitted]);
    }
  }
  return headers;
};

const applyRules = (allowAnthropicBeta: boolean) => defineStage({
  name: 'custom.applyIngressHeaderRules',
  through: {
    request: { needs: ['request.http', 'provider.upstream'], provides: ['request.http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request: facts => {
      const request = facts['request.http'];
      const { ingressHeadersRules } = upstreamConfig(facts['provider.upstream']);
      return { ...facts, 'request.http': move({ ...request, headers: rebuildHeaders(request, ingressHeadersRules, allowAnthropicBeta) }) };
    },
  })),
});

export const applyIngressHeaderRules = applyRules(false);
export const applyAnthropicMessagesIngressHeaderRules = applyRules(true);
