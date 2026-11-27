import { vi } from 'vitest';

import type { Candidate } from '../../../../src/data-plane/pipeline/facts.ts';
import { createGatewayServices } from '../../../../src/data-plane/pipeline/services.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { candidateFor, hostFor } from '../../pipeline/fixtures.ts';
import type { Fetcher, HttpRequestFact, HttpResponseFact } from '@floway-dev/http';

export const customCandidate = (id: string, endpoints: Candidate['model']['endpoints']): Candidate => {
  const { upstream, model } = candidateFor(id);
  return {
    upstream: { ...upstream, config: { baseUrl: `https://${id}.example`, apiKey: 'key', ingressHeadersRules: [], endpoints } },
    model: { ...model, endpoints },
  };
};

export const operationHost = (candidates: readonly Candidate[], fetcher: Fetcher) => {
  initRepo(new InMemoryRepo());
  const services = createGatewayServices({
    apiKey: {
      id: 'key-test', serverSecret: '0'.repeat(64), openaiResponsesRetentionSeconds: 0,
      upstreamIds: null, randomizeUpstreams: false,
    },
    subject: { id: 1, isAdmin: false },
    runtimeLocation: 'TEST',
    dump: null,
  });
  const recordUsage = vi.fn(services.recordUsage).mockResolvedValue(undefined);
  const recordPerformance = vi.fn(services.recordPerformance).mockResolvedValue(undefined);
  const catalogCandidates = vi.fn(services.catalogCandidates).mockResolvedValue({ candidates, sawModel: true });
  const host = hostFor({ ...services, fetcher: () => fetcher, recordUsage, recordPerformance, catalogCandidates });
  return { ...host, recordUsage, recordPerformance, catalogCandidates };
};

export const requestFor = (path: string, payload: unknown) => ({
  'serve.startedAt': 1_750_000_000_000,
  http: {
    url: `https://floway.example${path}`,
    method: 'POST',
    headers: [['authorization', 'Bearer floway-key'], ['content-type', 'application/json']],
    body: new TextEncoder().encode(JSON.stringify(payload)),
  } satisfies HttpRequestFact,
});

export const jsonBody = (http: HttpResponseFact | null): unknown => {
  if (!(http?.body instanceof Uint8Array)) throw new TypeError('Expected buffered JSON response');
  return JSON.parse(new TextDecoder().decode(http.body)) as unknown;
};
