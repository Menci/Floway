import { vi } from 'vitest';

import type { Candidate } from '../../../src/data-plane/pipeline/facts.ts';
import { createGatewayServices, type GatewayServices } from '../../../src/data-plane/pipeline/services.ts';
import { buildCustomUpstreamRecord, setupAppTest } from '../../test-utils/app.ts';
import { candidateFor, hostFor } from '../pipeline/fixtures.ts';
import type { Fetcher, HttpRequestFact } from '@floway-dev/http';

export const customCandidate = (id: string, model: Partial<Candidate['model']>): Candidate => {
  const candidate = candidateFor(id);
  return {
    upstream: { ...candidate.upstream, config: buildCustomUpstreamRecord().config },
    model: { ...candidate.model, ...model },
  };
};

export const post = (body: unknown, path = '/v1/test'): { http: HttpRequestFact; 'serve.startedAt': number } => ({
  http: {
    url: `https://gateway.example${path}`,
    method: 'POST',
    headers: [['content-type', 'application/json'], ['authorization', 'Bearer floway-test']],
    body: new TextEncoder().encode(JSON.stringify(body)),
  },
  'serve.startedAt': Date.now(),
});

export const setupNonChat = async (candidates: readonly Candidate[], fetcher: (id: string) => Fetcher) => {
  const { apiKey } = await setupAppTest();
  const services = createGatewayServices({
    apiKey,
    subject: { id: apiKey.userId, isAdmin: false },
    runtimeLocation: 'TEST',
    dump: null,
  });
  const catalogCandidates = vi.fn<GatewayServices['catalogCandidates']>(async () => ({ candidates, sawModel: candidates.length > 0 }));
  const recordUsage = vi.fn<GatewayServices['recordUsage']>(async () => {});
  const recordPerformance = vi.fn<GatewayServices['recordPerformance']>(async () => {});
  return {
    services: { ...services, catalogCandidates, recordUsage, recordPerformance, fetcher },
    catalogCandidates,
    recordUsage,
    recordPerformance,
    host() {
      return hostFor(this.services);
    },
  };
};
