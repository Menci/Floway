import { expect, test } from 'vitest';

import { candidate, config, facts, fixture } from './fixture.ts';
import { alphaSearchIngress } from '../../../../../src/data-plane/alpha-search/pipeline.ts';
import { resolveAlphaSearchRoute } from '../../../../../src/data-plane/tools/web-search/alpha-search/upstream.ts';
import { Bytes, run, secret } from '@floway-dev/pipeline';
import { readHttpBody } from '@floway-dev/provider';

const success = () => Response.json({});

test('Alpha Search reports a missing model for an empty permitted catalog', async () => {
  const { services, enumerate } = fixture(success, { candidates: [] });
  await expect(resolveAlphaSearchRoute(services.providers, facts, config)).resolves.toEqual({ candidate: undefined, staleRefreshes: [] });
  expect(enumerate).toHaveBeenCalledWith(expect.objectContaining({ 'request.route.upstreamIds': ['search-upstream'], 'request.route.randomizeUpstreams': false }), 'search-model', 'chat');
});

test('Alpha Search hides a configured upstream outside the API-key scope', async () => {
  const { services, enumerate } = fixture(success);
  await expect(resolveAlphaSearchRoute(services.providers, { ...facts, 'request.route.upstreamIds': [] }, config)).resolves.toEqual({ candidate: undefined, staleRefreshes: [] });
  expect(enumerate).not.toHaveBeenCalled();
});

test('Alpha Search rejects providers without the operation as configuration failures', async () => {
  const { services } = fixture(success, { candidates: [{ ...candidate, kind: 'azure' }] });
  await expect(resolveAlphaSearchRoute(services.providers, facts, config)).rejects.toThrow('Selected upstream does not support OpenAI search passthrough');
});

test('an Alpha Search upstream receives only the declared turn metadata and records a request', async () => {
  const { receive, services, usage, recordPerformance } = fixture(success);
  const handle = run(alphaSearchIngress, {
    ...facts,
    'request.http': {
      ...facts['request.http'],
      headers: [['authorization', secret('Bearer secret')], ['x-codex-turn-metadata', '{"turn_id":"turn-1"}'], ['x-debug', 'discard'], ['content-type', 'application/json']],
      body: Bytes.fromUtf8('{}'),
    },
  }, { services, finalizationTimeoutMs: 100 });
  const { 'response.http': response } = await handle.result;
  expect(response.status).toBe(200);
  expect(await readHttpBody(response.body)).toMatchObject({ ok: true });
  const headers = new Headers(receive.mock.calls[0]?.[1].headers);
  expect(headers.get('x-codex-turn-metadata')).toBe('{"turn_id":"turn-1"}');
  expect(headers.get('x-debug')).toBeNull();
  expect(headers.get('authorization')).toBe('Bearer search-token');
  expect(await handle.done).toEqual({ ok: true });
  expect(usage).toEqual([expect.objectContaining({ model: 'search-model', requests: 1 })]);
  expect(recordPerformance).not.toHaveBeenCalled();
});
