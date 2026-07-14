import { expect, test } from 'vitest';

import { dispatchUpstreamFetch } from './options.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('dispatchUpstreamFetch transfers the request through the timing wrapper once', async () => {
  const init: RequestInit = { method: 'POST', body: 'payload' };
  let received: RequestInit | undefined;
  let wrapped = false;
  const response = await dispatchUpstreamFetch({
    fetcher: (_url, request) => {
      received = request;
      return Promise.resolve(new Response('ok'));
    },
    wrapUpstreamCall: dispatch => {
      wrapped = true;
      return dispatch();
    },
  }, 'https://example.com', init);

  assertEquals(await response.text(), 'ok');
  assertEquals(wrapped, true);
  assertEquals(received, init);
});

test('dispatchUpstreamFetch rejects a timing wrapper that dispatches twice', async () => {
  await expect(dispatchUpstreamFetch({
    fetcher: () => Promise.resolve(new Response('ok')),
    wrapUpstreamCall: async dispatch => {
      await dispatch();
      return await dispatch();
    },
  }, 'https://example.com', { method: 'POST', body: 'payload' })).rejects.toThrow('invoked more than once');
});
