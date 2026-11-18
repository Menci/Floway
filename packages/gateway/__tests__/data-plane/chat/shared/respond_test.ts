import { test } from 'vitest';

import { plainResultFromResponse } from '../../../../src/data-plane/chat/shared/respond.ts';
import { forwardBufferedUpstreamResponse } from '../../../../src/data-plane/shared/upstream-response.ts';
import { bufferedResultToResponse, readUpstreamApiError } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

test('measurement response conversion preserves retry and correlation headers without forwarding cookies or body framing', async () => {
  const upstream = new Response('rate limited', {
    status: 429,
    headers: {
      'retry-after': '17',
      'request-id': 'req-measurement',
      'set-cookie': 'session=private',
      'connection': 'close',
      'content-length': '999',
      'content-encoding': 'gzip',
    },
  });
  const response = forwardBufferedUpstreamResponse(await plainResultFromResponse(upstream, 'upstream'));
  assertEquals(response.status, 429);
  assertEquals(response.headers.get('retry-after'), '17');
  assertEquals(response.headers.get('request-id'), 'req-measurement');
  for (const name of ['set-cookie', 'connection', 'content-length', 'content-encoding']) assertEquals(response.headers.get(name), null);
  assertEquals(await response.text(), 'rate limited');
});

test.each([204, 205, 304])('buffered responses preserve the absent body for HTTP %i', async status => {
  const upstream = new Response(null, { status, headers: { 'request-id': 'req-empty' } });
  for (const result of [await plainResultFromResponse(upstream), await readUpstreamApiError(upstream)]) {
    assertEquals(result.body, null);
    const response = bufferedResultToResponse(result);
    assertEquals(response.status, status);
    assertEquals(response.headers.get('request-id'), 'req-empty');
    assertEquals(response.body, null);
  }
});

test('buffered responses preserve an explicitly empty body', async () => {
  const result = await plainResultFromResponse(new Response(new Uint8Array()));
  assertEquals(result.body, new Uint8Array());
  const response = bufferedResultToResponse(result);
  assertEquals(response.body === null, false);
  assertEquals((await response.arrayBuffer()).byteLength, 0);
});
