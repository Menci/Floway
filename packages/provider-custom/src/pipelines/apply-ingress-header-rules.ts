import type { CustomUpstream } from '../upstream.ts';
import { filterHeaders, getHeaders, type HttpHeaders, type HttpRequestFact } from '@floway-dev/http';
import { factSpace, transform } from '@floway-dev/pipeline';

const { defineStage } = factSpace<{ 'request.http': HttpRequestFact; 'provider.upstream': CustomUpstream }>();

const ingressHeaderRules = (anthropicMessages: boolean) => defineStage({
  name: anthropicMessages ? 'custom.anthropicMessages.apply-ingress-header-rules' : 'custom.apply-ingress-header-rules',
  through: {
    request: { needs: ['request.http', 'provider.upstream'], provides: ['request.http'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request(facts) {
      const request = facts['request.http'];
      const { ingressHeadersRules } = facts['provider.upstream'].config;
      // The Anthropic ingress and translation stages own the beta list.
      // https://github.com/anthropics/anthropic-sdk-typescript/blob/3b45cd3b69c956ac63384fdb09ce1d8109f3fa80/src/resources/beta/beta.ts#L622-L635
      const headers: HttpHeaders = anthropicMessages ? filterHeaders(request.headers, name => name === 'anthropic-beta') : [];
      const byName = Map.groupBy(ingressHeadersRules, rule => rule.key);
      for (const [name, rules] of byName) {
        for (const { value } of rules) {
          if (value === null) {
            for (const admitted of getHeaders(request.headers, name)) headers.push([name, admitted]);
          } else {
            headers.push([name, value]);
          }
        }
      }
      return { ...facts, 'request.http': { ...request, headers } };
    },
  })),
});

export const applyCustomIngressHeaderRules = ingressHeaderRules(false);
export const applyCustomAnthropicMessagesIngressHeaderRules = ingressHeaderRules(true);
