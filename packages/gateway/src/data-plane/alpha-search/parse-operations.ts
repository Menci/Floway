import type { Fields } from './facts.ts';
import { webSearchFiltersFromSettings } from './protocol.ts';
import { assertLocalWebSearchSupport, UnsupportedLocalWebSearchFeatureError, parseWebSearchOperations } from '../tools/web-search/operations.ts';
import { move, defineStage } from '@floway-dev/pipeline';

/** Both in-band answers a local run can give: Codex reads `output`, so a command it asked for
 *  and this gateway cannot run is text the model sees rather than an HTTP failure. */
const inBandOutput = (facts: Fields<'request.search.alphaSearch'>, output: string) => move({
  ...facts,
  'response.search.alphaSearch': { encryptedOutput: null, output },
  'response.usage.billable': [],
  // Nothing was called, so there are no upstream headers to carry.
  'response.http.headers': [],
  'response.http.status': 200,
});

/**
 * Codex's commands become the gateway's own operations, and its settings become the filters
 * they run under. Nothing below reads Codex's request afterwards, so it is consumed here and
 * assembly is what holds that: a stage placed under this one cannot need it back.
 */
export const parseSearchOperations = defineStage<
  Fields<'request.search.alphaSearch'>,
  Fields<'request.search.operations' | 'request.search.filters'>,
  Fields<'response.search.alphaSearch' | 'response.usage.billable' | 'response.http.headers' | 'response.http.status'>,
  Fields<'response.search.alphaSearch' | 'response.usage.billable' | 'response.http.headers' | 'response.http.status'>,
  Fields<'response.search.alphaSearch' | 'response.usage.billable' | 'response.http.headers' | 'response.http.status'>
>({
  name: 'parseSearchOperations',
  through: {
    request: {
      needs: ['request.search.alphaSearch'],
      consumes: ['request.search.alphaSearch'],
      provides: ['request.search.operations', 'request.search.filters'],
    },
    response: { needs: [], consumes: [], provides: [] },
  },
  return: { provides: ['response.search.alphaSearch', 'response.usage.billable', 'response.http.headers', 'response.http.status'] },
  execute: async (facts, next) => {
    const { 'request.search.alphaSearch': request, ...rest } = facts;
    const commands = request.commands ?? {};

    try {
      assertLocalWebSearchSupport(commands);
    } catch (error) {
      if (!(error instanceof UnsupportedLocalWebSearchFeatureError)) throw error;
      return inBandOutput(facts, error.message);
    }

    const parsed = parseWebSearchOperations(commands);
    if (parsed.kind !== 'ops' || parsed.ops.length === 0) {
      return inBandOutput(facts, 'No web search commands were provided. Populate at least one of `search_query`, `open`, or `find`.');
    }

    return await next({
      ...rest,
      'request.search.operations': move(parsed.ops),
      'request.search.filters': move(webSearchFiltersFromSettings(request.settings)),
    });
  },
});
