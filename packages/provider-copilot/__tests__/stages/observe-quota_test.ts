import { expect, test } from 'vitest';

import { observeCopilotQuota } from '../../src/stages/observe-quota.ts';
import type { HttpRequestFacts, HttpResponseFacts } from '@floway-dev/http/pipeline';
import { compose, defineStage, move, run } from '@floway-dev/pipeline';
import { initProviderRepo, type ProviderServices } from '@floway-dev/provider';
import { noopUpstreamCallOptions } from '@floway-dev/test-utils';

test('returns the HTTP reply while quota persistence rejects the deferred drain with its original error', async () => {
  const error = new Error('quota persistence failed');
  let writes = 0;
  initProviderRepo(() => ({
    upstreams: {
      getById: async () => null,
      saveState: async () => { writes++; throw error; },
    },
  }));
  const exchange = move({
    type: 'response' as const,
    status: 200,
    statusText: 'OK',
    headers: [['x-quota-snapshot-chat', 'ent=-1&ov=0.0&ovPerm=false&rem=100.0&rst=2026-09-01T00%3A00%3A00Z&totRem=-1']] as const,
    body: null,
  });
  const terminal = defineStage<Pick<HttpRequestFacts, 'request.http.callId'>, HttpResponseFacts>({
    name: 'reply',
    return: { provides: ['response.http.exchange', 'response.http.body'] },
    execute: async facts => move({ ...facts, 'response.http.exchange': exchange, 'response.http.body': null }),
  });
  const services: ProviderServices = { httpCall: () => ({ ...noopUpstreamCallOptions(), signal: undefined }) };
  const executed = await run(compose<Pick<HttpRequestFacts, 'request.http.callId'>, HttpResponseFacts>('quota', [observeCopilotQuota('up_quota'), terminal]), move({ 'request.http.callId': 1 }), services);
  expect(executed.facts['response.http.exchange']).toBe(exchange);
  expect(writes).toBe(1);
  await expect(executed.drain()).rejects.toBe(error);
});
