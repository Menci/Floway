import { expect, test } from 'vitest';

import { candidate, config, facts, fixture } from './fixture.ts';
import { alphaSearchIngress } from '../../../../../src/data-plane/alpha-search/pipeline.ts';
import { jsonHttpResponse } from '../../../../../src/data-plane/pipeline/edge-http.ts';
import { resolveAlphaSearchRouteCandidate } from '../../../../../src/data-plane/tools/web-search/alpha-search/upstream.ts';
import { Bytes, run, secret } from '@floway-dev/pipeline';

const success = () => jsonHttpResponse(200, {}, 0);

test('Alpha Search reports a missing model for an empty permitted catalog', async () => {
  const { services, enumerate } = fixture(success, { candidates: [] });
  await expect(resolveAlphaSearchRouteCandidate(services.providers, facts, config)).resolves.toBeUndefined();
  expect(enumerate).toHaveBeenCalledWith(expect.objectContaining({ 'request.route.upstreamIds': ['search-upstream'], 'request.route.randomizeUpstreams': false }), 'search-model', 'chat');
});

test('Alpha Search hides a configured upstream outside the API-key scope', async () => {
  const { services, enumerate } = fixture(success);
  await expect(resolveAlphaSearchRouteCandidate(services.providers, { ...facts, 'request.route.upstreamIds': [] }, config)).resolves.toBeUndefined();
  expect(enumerate).not.toHaveBeenCalled();
});

test('Alpha Search rejects providers without the operation as configuration failures', async () => {
  const { services } = fixture(success, { candidates: [candidate], unsupported: true });
  await expect(resolveAlphaSearchRouteCandidate(services.providers, facts, config)).rejects.toThrow('Selected upstream does not support OpenAI search passthrough');
});

test('an Alpha Search upstream receives only its declared turn metadata', async () => {
  const { receive, services } = fixture(success);
  const handle = run(alphaSearchIngress, {
    ...facts,
    'request.http': {
      ...facts['request.http'],
      headers: [['authorization', secret('Bearer secret')], ['x-codex-turn-metadata', '{"turn_id":"turn-1"}'], ['x-debug', 'discard'], ['content-type', 'application/json']],
      body: Bytes.fromUtf8('{}'),
    },
  }, { services, finalizationTimeoutMs: 100 });
  expect((await handle.result)['response.http'].status).toBe(200);
  expect(receive.mock.calls[0]?.[0]['request.headers']).toEqual([['x-codex-turn-metadata', '{"turn_id":"turn-1"}']]);
  expect(await handle.done).toEqual({ ok: true });
});
