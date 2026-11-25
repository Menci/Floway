import { gatewayFactSpace, type ServeCandidates } from './facts.ts';
import type { FindCandidatesInput } from '../providers/resolution.ts';
import { move } from '@floway-dev/pipeline';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { ModelKind } from '@floway-dev/protocols/common';

export interface CandidateDiscoveryServices {
  readonly findCandidates: (input: Omit<FindCandidatesInput, 'scheduleRefresh'>, defer: BackgroundScheduler) => Promise<ServeCandidates>;
}

const { defineStage } = gatewayFactSpace<CandidateDiscoveryServices>();

export const discoverCandidates = (kind: ModelKind) => defineStage({
  name: 'serve.discover-candidates',
  through: {
    request: {
      needs: ['request.auth.user', 'request.auth.upstreamIds', 'request.auth.randomizeUpstreams', 'serve.model'],
      provides: ['serve.candidates'],
      consumes: [],
    },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const candidates = await scope.services.findCandidates({
      subject: facts['request.auth.user'],
      upstreamIds: facts['request.auth.upstreamIds'],
      randomizeUpstreams: facts['request.auth.randomizeUpstreams'],
      model: facts['serve.model'],
      kind,
    }, scope.defer);
    return await scope.next({ ...facts, 'serve.candidates': move(candidates) });
  },
});
