import { vi } from 'vitest';

import type { Candidate } from '../../../../src/data-plane/pipeline/facts.ts';
import { createGatewayServices, type GatewayServices } from '../../../../src/data-plane/pipeline/services.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { candidateFor, hostFor } from '../../pipeline/fixtures.ts';
import type { FetchInit, Fetcher, HttpRequestFact, HttpResponseFact } from '@floway-dev/http';

export const mediaCandidate = (id: string, kind: Candidate['model']['kind'], endpoints: Candidate['model']['endpoints']): Candidate => {
  const candidate = candidateFor(id);
  return {
    upstream: {
      ...candidate.upstream,
      config: {
        baseUrl: `https://${id}.example.test`,
        apiKey: 'wire-key',
        ingressHeadersRules: [],
        endpoints: {},
        modelsFetch: { enabled: false, authStyle: 'bearer' },
      },
    },
    model: { ...candidate.model, kind, endpoints },
  };
};

export const mediaHost = (candidates: readonly Candidate[], fetcher: (id: string) => Fetcher, sawModel = true) => {
  initRepo(new InMemoryRepo());
  const recordPerformance = vi.fn<GatewayServices['recordPerformance']>(async () => {});
  const recordUsage = vi.fn<GatewayServices['recordUsage']>(async () => {});
  const catalogCandidates = vi.fn<GatewayServices['catalogCandidates']>(async () => ({ candidates, sawModel }));
  const services = {
    ...createGatewayServices({
      apiKey: { id: 'key', serverSecret: '00'.repeat(32), openaiResponsesRetentionSeconds: 30, upstreamIds: null, randomizeUpstreams: false },
      subject: { id: 2, isAdmin: false },
      runtimeLocation: null,
      dump: null,
    }),
    catalogCandidates,
    fetcher,
    recordPerformance,
    recordUsage,
  };
  return { ...hostFor(services), catalogCandidates, recordPerformance, recordUsage };
};

export const mediaRequest = async (path: string, body: FormData | Record<string, unknown>) => {
  const request = new Request(`https://floway.test/v1${path}`, {
    method: 'POST',
    headers: body instanceof FormData ? { authorization: 'Bearer gateway-key' } : { 'content-type': 'application/json', authorization: 'Bearer gateway-key' },
    body: body instanceof FormData ? body : JSON.stringify(body),
  });
  const http: HttpRequestFact = {
    method: request.method,
    url: request.url,
    headers: [...request.headers],
    body: new Uint8Array(await request.arrayBuffer()),
  };
  return { http, 'serve.startedAt': Date.now() };
};

export const multipartBody = async ({ body, headers }: FetchInit): Promise<FormData> => {
  if (!(body instanceof Uint8Array) || headers === undefined) throw new TypeError('Expected encoded multipart bytes and the multipart headers');
  return await new Response(new Uint8Array(body), { headers }).formData();
};

export const upload = (value: FormDataEntryValue | null): File => {
  if (!(value instanceof File)) throw new TypeError('Expected a multipart file');
  return value;
};

export const bodyBytes = (http: HttpResponseFact | null): Uint8Array => {
  if (http === null || !(http.body instanceof Uint8Array)) throw new TypeError('Expected an encoded HTTP body');
  return http.body;
};

export const bodyStream = (http: HttpResponseFact | null) => {
  if (http?.body == null || http.body instanceof Uint8Array) throw new TypeError('Expected an encoded HTTP stream');
  return http.body;
};
