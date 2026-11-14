import type { PinnedSearchUpstream, Fields } from './facts.ts';
import type { GatewayServices } from '../pipeline/services.ts';
import { AlphaSearchModelNotFoundError, resolveAlphaSearchCandidate } from '../tools/web-search/alpha-search/upstream.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { ModelCandidate } from '@floway-dev/provider';

/**
 * Resolves the operator's pinned search upstream into the attempt the ending dials. A
 * misconfigured pin is the operator's to see with its stack, the way the gateway surfaces any
 * internal failure; only a model the key cannot reach is the client's answer, and that answer
 * is the same whether the model is missing or withheld.
 */
export const resolveSearchUpstream = (pinned: PinnedSearchUpstream) => defineStage<
  Fields<never>,
  Fields<'route.attempt'>,
  Fields<'response.search.alphaSearch' | 'response.usage.billable' | 'response.http.headers' | 'response.http.status'>,
  Fields<'response.search.alphaSearch' | 'response.usage.billable' | 'response.http.headers' | 'response.http.status'>,
  Fields<'response.search.alphaSearch' | 'response.usage.billable' | 'response.http.headers' | 'response.http.status'>,
  GatewayServices
>({
  name: 'resolveSearchUpstream',
  through: {
    request: { needs: [], consumes: [], provides: ['route.attempt'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  return: { provides: ['response.search.alphaSearch', 'response.usage.billable', 'response.http.headers', 'response.http.status'] },
  execute: async (facts, next, use) => {
    let candidate: ModelCandidate;
    try {
      candidate = await resolveAlphaSearchCandidate({
        config: pinned,
        subject: use.gateway.user,
        upstreamIds: use.gateway.upstreamIds,
        scheduler: use.gateway.backgroundScheduler,
        runtimeLocation: use.gateway.runtimeLocation,
      });
    } catch (error) {
      if (!(error instanceof AlphaSearchModelNotFoundError)) throw error;
      return move({
        ...facts,
        'response.search.alphaSearch': { status: 404, message: error.message },
        // Nothing was called, so nothing is billable and there are no upstream headers.
        'response.usage.billable': [],
        'response.http.headers': [],
        'response.http.status': 404,
      });
    }
    return await next({ ...facts, 'route.attempt': move(use.rememberCandidates([candidate])[0]!) });
  },
});
