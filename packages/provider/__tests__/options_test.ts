import { expect, test } from 'vitest';

import { directFetcher, dispatchUpstreamFetch } from '../src/options.ts';

test('directFetcher rejects a replayable body without runtime composition', async () => {
  await expect(directFetcher('https://example.com', {
    method: 'POST',
    body: { contentLength: 0, open: () => new ReadableStream() },
  })).rejects.toThrow('runtime-composed direct fetcher');
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
