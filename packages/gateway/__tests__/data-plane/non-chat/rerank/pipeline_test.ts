import { expect, test, vi } from 'vitest';

import { rerankIngress } from '../../../../src/data-plane/non-chat/rerank/index.ts';
import { customCandidate, post, setupNonChat } from '../fixtures.ts';
import { getHeader, type Fetcher } from '@floway-dev/http';
import { run } from '@floway-dev/pipeline';

test('rerank retries an invalid cross-dialect result and keeps both calls’ observed usage', async () => {
  const model = {
    kind: 'rerank',
    endpoints: { rerank: {} },
    rerankTarget: { protocol: 'cohere-v2' },
  } as const;
  const bad = customCandidate('damaged', model);
  const good = customCandidate('valid', model);
  const badFetch = vi.fn<Fetcher>(async () => Response.json({
    results: [{ index: 2, relevance_score: 0.9 }],
    meta: { tokens: { input_tokens: 4 } },
  }));
  const goodFetch = vi.fn<Fetcher>(async () => Response.json({
    id: 'rank-id',
    results: [{ index: 1, relevance_score: 0.9 }],
    meta: { billed_units: { search_units: 1 }, tokens: { input_tokens: 9 } },
  }, { status: 201, headers: { 'x-request-id': 'chosen' } }));
  const fixture = await setupNonChat([bad, good], id => id === bad.upstream.id ? badFetch : goodFetch);
  const host = fixture.host();
  const running = run(rerankIngress, {
    ...post({
      model: 'public-model',
      query: 'question',
      documents: [{ text: 'first' }, { title: 'second', text: 'answer' }],
      top_n: 1,
      return_documents: true,
    }, '/v1/rerank'),
    rerankDialect: 'cohere-v1',
  }, host.options);

  const answer = await running.result;
  expect(badFetch).toHaveBeenCalledOnce();
  expect(goodFetch).toHaveBeenCalledOnce();
  expect(JSON.parse(String(goodFetch.mock.calls[0]?.[1].body))).toEqual({
    model: 'wire-model', query: 'question', documents: ['first', 'answer'], top_n: 1,
  });
  expect(answer.candidate).toEqual({ upstreamId: 'valid', model: 'public-model' });
  expect(answer.http?.status).toBe(201);
  expect(getHeader(answer.http?.headers ?? [], 'x-request-id')).toBe('chosen');
  if (!(answer.http?.body instanceof Uint8Array) || answer.usage === undefined) throw new Error('Expected encoded rerank response and selected usage');
  expect(JSON.parse(new TextDecoder().decode(answer.http.body))).toEqual({
    id: 'rank-id',
    results: [{ index: 1, relevance_score: 0.9, document: { title: 'second', text: 'answer' } }],
    meta: { billed_units: { search_units: 1 }, tokens: { input_tokens: 9 } },
  });
  await expect(running.read(answer.usage)).resolves.toMatchObject({ kind: 'observed', modelKey: 'wire-model' });
  host.controller.abort();
  running.discard(answer);
  await host.settle();
  expect(host.errors).toEqual([]);
  expect(fixture.recordPerformance).toHaveBeenCalledTimes(2);
  expect(fixture.recordPerformance).toHaveBeenCalledWith(expect.objectContaining({ upstream: 'damaged', operation: 'rerank', failed: true }));
  expect(fixture.recordPerformance).toHaveBeenCalledWith(expect.objectContaining({ upstream: 'valid', operation: 'rerank', failed: false }));
  expect(fixture.recordUsage).toHaveBeenCalledTimes(2);
  expect(fixture.recordUsage).toHaveBeenCalledWith(
    expect.objectContaining({ upstream: 'damaged' }),
    expect.objectContaining({ quantities: { input_tokens: '4' } }),
  );
  expect(fixture.recordUsage).toHaveBeenCalledWith(
    expect.objectContaining({ upstream: 'valid' }),
    expect.objectContaining({ quantities: { rerank_searches: '1', input_tokens: '9' } }),
  );
});
