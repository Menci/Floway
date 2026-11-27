import { alphaSearchRequest, filtersFromSettings } from './request.ts';
import { defineStage } from '../../pipeline/facts.ts';
import { assertLocalWebSearchSupport, isSearchResponseLength, parseWebSearchOperations, UnsupportedLocalWebSearchFeatureError } from '../../tools/web-search/operations.ts';
import { localAlphaSearchOperation } from '../local-web-search/index.ts';
import { localHead, openAIError } from '../shared/http.ts';
import type { UpstreamResponse } from '@floway-dev/upstream';

const alphaSearchError = (status: number | null, error: unknown): UpstreamResponse<'alphaSearch'> => ({
  http: status === null ? null : localHead(status),
  alphaSearch: { kind: 'error', source: 'local', error },
});

const localOutput = (output: string): UpstreamResponse<'alphaSearch'> => ({
  http: localHead(200),
  alphaSearch: { kind: 'result', result: { encrypted_output: null, output } },
});

export const route = defineStage({
  name: 'alphaSearch.route',
  through: {
    request: { needs: ['http', 'serve.startedAt', 'alphaSearch'], provides: ['candidates'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['http', 'alphaSearch'] },
  async execute(facts, scope) {
    const parsed = alphaSearchRequest.safeParse(facts.alphaSearch);
    if (!parsed.success) {
      return alphaSearchError(400, { error: parsed.error.issues[0]?.message ?? 'Invalid input' });
    }

    const config = await scope.services.localWebSearch.passthroughConfiguration();
    if (config.enabled) {
      const { candidates } = await scope.services.catalogCandidates({ model: config.model, kind: 'chat', upstreamId: config.upstreamId });
      const candidate = candidates.find(({ upstream }) => upstream.id === config.upstreamId);
      if (candidate === undefined) {
        return alphaSearchError(404, openAIError('Search model not found.'));
      }
      if (candidate.upstream.kind !== 'chatgpt' && candidate.upstream.kind !== 'custom') {
        throw new Error('Selected upstream does not support OpenAI search passthrough');
      }
      return await scope.next({ ...facts, candidates: [candidate] });
    }

    const { commands = {}, settings } = parsed.data;
    try {
      assertLocalWebSearchSupport(commands);
    } catch (error) {
      if (!(error instanceof UnsupportedLocalWebSearchFeatureError)) throw error;
      return localOutput(error.message);
    }
    const operations = parseWebSearchOperations(commands);
    if (operations.kind !== 'ops' || operations.ops.length === 0) {
      return localOutput('No web search commands were provided. Populate at least one of `search_query`, `open`, or `find`.');
    }

    const length = commands.response_length;
    const call = scope.run(localAlphaSearchOperation, {
      http: facts.http,
      'serve.startedAt': facts['serve.startedAt'],
      alphaSearchBatch: {
        operations: operations.ops,
        filters: filtersFromSettings(settings),
        includeSearchActionSources: false,
        ...(isSearchResponseLength(length) ? { responseLength: length } : {}),
      },
    });
    let answer: Awaited<typeof call> | undefined;
    try {
      answer = await call;
      return answer.alphaSearchBatch.kind === 'abort'
        ? alphaSearchError(null, openAIError('Search request cancelled.'))
        : localOutput(answer.alphaSearchBatch.result);
    } finally {
      scope.abort(call);
      if (answer !== undefined) scope.discard(answer);
    }
  },
});
