import { executeLocalAlphaSearch } from './local-search.ts';
import { alphaSearchModelNotFound } from './parse.ts';
import { gatewayFactSpace } from '../../pipeline/facts.ts';
import { responseHead } from '../../pipeline/response.ts';
import { loadWebSearchConfig } from '../../tools/web-search/config.ts';
import type { AlphaSearchRequest } from '../schema.ts';
import { filterHeaders } from '@floway-dev/http';
import { move } from '@floway-dev/pipeline';

const { defineStage } = gatewayFactSpace<{}>();

export const routeAlphaSearch = defineStage({
  name: 'alphaSearch.route-search',
  through: {
    request: {
      needs: ['request.http', 'request.alphaSearch', 'request.auth.apiKeyId', 'request.auth.upstreamIds', 'request.auth.randomizeUpstreams'],
      provides: ['request.http', 'request.auth.upstreamIds', 'request.auth.randomizeUpstreams', 'serve.model'],
      consumes: [],
    },
    response: { needs: ['response.http', 'response.alphaSearch'], provides: [], consumes: [] },
  },
  return: { provides: ['response.http', 'response.alphaSearch'] },
  async execute(facts, scope) {
    const config = await loadWebSearchConfig();
    const target = config.passthroughOpenAiSearch;
    if (!target.enabled) {
      const result = await executeLocalAlphaSearch(facts['request.alphaSearch'] as AlphaSearchRequest, config, facts['request.auth.apiKeyId'], scope.signal);
      return {
        'response.http': move(responseHead(200)),
        'response.alphaSearch': move({ kind: 'result', result } as const),
      };
    }

    // The configured model is private. Missing models and grants share a response.
    const allowed = facts['request.auth.upstreamIds'];
    if (allowed !== null && !allowed.includes(target.upstreamId)) return alphaSearchModelNotFound();
    const request = facts['request.http'];
    // https://github.com/openai/codex/blob/2e1607ee2fa8099a233df7437adee5f16a741905/codex-rs/codex-api/src/endpoint/search.rs#L31-L47
    const headers = filterHeaders(request.headers, name => name === 'x-codex-turn-metadata');
    return await scope.next({
      ...facts,
      'request.http': move({ ...request, headers }),
      'request.auth.upstreamIds': move([target.upstreamId]),
      'request.auth.randomizeUpstreams': false,
      'serve.model': target.model,
    });
  },
});
