import { prepareLocalAlphaSearch, renderLocalAlphaSearch } from './local-search.ts';
import type { AlphaSearchRequest } from './parse.ts';
import { localResponseHead } from '../pipeline/encode.ts';
import { defineStage } from '../pipeline/facts.ts';
import { toProviderUpstream } from '../providers/registry.ts';
import { localWebSearch } from '../tools/web-search/pipeline.ts';
import { toProviderModelFact } from '@floway-dev/provider';

const searchModelNotFound = () => ({
  'response.http': { ...localResponseHead(404), body: null },
  'response.alphaSearch': {
    kind: 'error' as const,
    source: 'local' as const,
    error: { error: { message: 'Search model not found.', type: 'api_error' } },
  },
});

export const routeAlphaSearch = defineStage({
  name: 'alphaSearch.route-search',
  through: {
    request: {
      needs: ['request.alphaSearch', 'request.auth.apiKeyId', 'request.auth.userId', 'request.auth.isAdmin', 'request.auth.upstreamIds', 'serve.runtimeLocation'],
      provides: ['request.candidates'],
      consumes: [],
    },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['response.http', 'response.alphaSearch'] },
  async execute(facts, scope) {
    const config = await scope.services.localWebSearch.configuration();
    const upstreamSearch = config.passthroughOpenAiSearch;
    if (!upstreamSearch.enabled) {
      const request: AlphaSearchRequest = facts['request.alphaSearch'];
      const prepared = prepareLocalAlphaSearch(request);
      let result: { encrypted_output: null; output: string };
      if (prepared.kind === 'result') {
        result = prepared.result;
      } else {
        const search = scope.run(localWebSearch, {
          'request.auth.apiKeyId': facts['request.auth.apiKeyId'],
          'request.webSearch': prepared,
        });
        try {
          const { 'response.webSearch': response } = await search;
          if (response.kind === 'abort') {
            return {
              'response.http': null,
              'response.alphaSearch': { kind: 'error', source: 'local', error: { error: { message: 'Search request cancelled.', type: 'api_error' } } },
            };
          }
          if (response.kind !== 'batch') throw new Error('Alpha Search expects batched web search results');
          result = renderLocalAlphaSearch(prepared.operations.operations, response.result);
        } finally {
          scope.abort(search);
        }
      }
      return {
        'response.http': { ...localResponseHead(200), body: null },
        'response.alphaSearch': { kind: 'result', result },
      };
    }

    const grants = facts['request.auth.upstreamIds'];
    if (grants !== null && !grants.includes(upstreamSearch.upstreamId)) return searchModelNotFound();
    const { candidates } = await scope.services.catalogCandidates({
      subject: { id: facts['request.auth.userId'], isAdmin: facts['request.auth.isAdmin'] },
      upstreamIds: [upstreamSearch.upstreamId],
      randomizeUpstreams: false,
      model: upstreamSearch.model,
      kind: 'chat',
      scheduler: work => scope.detach(async () => await work),
      runtimeLocation: facts['serve.runtimeLocation'],
    });
    const selected = candidates.find(({ provider }) => provider.upstreamId === upstreamSearch.upstreamId);
    if (selected === undefined) return searchModelNotFound();
    if (selected.provider.kind !== 'chatgpt' && selected.provider.kind !== 'custom') {
      throw new Error('Selected upstream does not support OpenAI search');
    }
    const providerModel = selected.model.providerModels?.[selected.provider.upstreamId];
    if (!providerModel) throw new Error(`Missing model metadata for ${upstreamSearch.model} on ${upstreamSearch.upstreamId}`);
    return await scope.next({
      ...facts,
      'request.candidates': [{ upstream: toProviderUpstream(selected.provider.record), model: toProviderModelFact(providerModel) }],
    });
  },
});
