import { afterEach, expect, test, vi } from 'vitest';

import { observeCopilotQuota } from '../../src/stages/observe-quota.ts';
import type { HttpRequestFacts, HttpResponseFacts } from '@floway-dev/http/pipeline';
import { compose, defineStage, move, run } from '@floway-dev/pipeline';
import { initProviderRepo, type ProviderServices } from '@floway-dev/provider';
import { noopUpstreamCallOptions } from '@floway-dev/test-utils';

afterEach(() => { vi.restoreAllMocks(); });

test('preserves the HTTP reply and warns with the original quota persistence error', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = new Error('quota persistence failed');
  let writes = 0;
  initProviderRepo(() => ({
    upstreams: {
      getById: async () => null,
      saveState: async () => { writes++; throw error; },
    },
    recordUpstreamMetric: async () => { throw new Error('quota persistence failed before metrics'); },
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
  await executed.drain();
  expect(warning).toHaveBeenCalledExactlyOnceWith('Failed to persist Copilot quota snapshot for up_quota:', error);
});

test('preserves the HTTP reply and warns about malformed quota headers without persisting', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  let writes = 0;
  initProviderRepo(() => ({
    upstreams: {
      getById: async () => null,
      saveState: async () => { writes++; },
    },
    recordUpstreamMetric: async () => {},
  }));
  const exchange = move({
    type: 'response' as const,
    status: 200,
    statusText: 'OK',
    headers: [['x-quota-snapshot-chat', 'ent=-5&ov=0.0&ovPerm=false&rem=100.0&rst=2026-09-01T00%3A00%3A00Z&totRem=-1']] as const,
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
  await executed.drain();
  expect(warning).toHaveBeenCalledOnce();
  expect(warning.mock.calls[0][0]).toBe('Failed to parse Copilot quota snapshot for up_quota:');
  expect(warning.mock.calls[0][1]).toBeInstanceOf(Error);
  expect(warning.mock.calls[0][1].message).toContain('Invalid Copilot quota entitlement');
  expect(writes).toBe(0);
});
