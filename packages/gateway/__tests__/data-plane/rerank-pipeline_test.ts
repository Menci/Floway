import { describe, expect, it } from 'vitest';

import { failover } from '../../src/data-plane/pipeline/failover.ts';
import { rerankServePipeline } from '../../src/data-plane/rerank/pipeline.ts';
import { mockGatewayCtx } from '../test-utils/gateway-ctx.ts';
import { compose, defineStage, move, own, run } from '@floway-dev/pipeline';
import type { CanonicalRerankRequest } from '@floway-dev/protocols/rerank';

const request: CanonicalRerankRequest = {
  sourceProtocol: 'cohere-v2',
  raw: {},
  query: 'what is a pipeline',
  documents: ['one', 'two'],
};

describe('the rerank pipeline', () => {
  it('assembles, and asks its caller for what the descending stages need', () => {
    expect([...rerankServePipeline(request).entryNeeds].sort()).toEqual([
      'ingress.http.headers',
      'ingress.rerank.sourceProtocol',
      'request.rerank.canonical',
      'serve.model',
    ]);
  });

  it('retains only streamed bodies and restores the caller usage context', async () => {
    for (const streaming of [false, true]) {
      let released = 0;
      const body = streaming ? own({ source: 'upstream body' }, async () => { released += 1; }) : null;
      const prior = move([]);
      const answer = defineStage<Record<string, unknown>, Record<string, unknown>>({
        name: 'answer',
        return: { provides: ['response.usage.billable', ...streaming ? ['response.http.body'] : []] },
        execute: async facts => move({
          ...facts, 'response.usage.billable': [], ...body === null ? {} : { 'response.http.body': body },
        }),
      });
      const pipeline = compose<Record<string, unknown>, Record<string, unknown>>('readOrStream', [
        failover({ failed: () => false, owns: streaming ? ['response.http.body'] : [] }), answer,
      ]);
      const { facts, drain } = await run(pipeline, move({
        'serve.candidates': [{ upstreamId: 'upstream', modelId: 'rerank', flags: [] }],
        'serve.usage.prior': prior,
      }), { gateway: mockGatewayCtx() });
      expect(facts['serve.usage.prior']).toBe(prior);
      if (streaming) expect(facts['response.http.body']).toBe(body);
      else expect(facts).not.toHaveProperty('response.http.body');
      expect(released).toBe(0);
      await drain();
      expect(released).toBe(streaming ? 1 : 0);
    }
  });

  it('names the entry key a caller did not bring, before any stage runs', async () => {
    await expect(run(rerankServePipeline(request), move({ 'serve.model': 'rerank-v3' }) as never, {}))
      .rejects.toThrow('run(rerankServe): rerankServe needs');
  });
});
