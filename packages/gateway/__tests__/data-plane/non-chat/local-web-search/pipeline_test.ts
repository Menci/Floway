import { expect, test } from 'vitest';

import { localWebSearchOperation } from '../../../../src/data-plane/non-chat/local-web-search/index.ts';
import { post, setupNonChat } from '../fixtures.ts';
import { run } from '@floway-dev/pipeline';

test('local web search reports the cancellation that reached its backend', async () => {
  const fixture = await setupNonChat([], () => { throw new Error('Unexpected model dial'); });
  const entered = Promise.withResolvers<AbortSignal>();
  const reason = new Error('host cancelled the search');
  fixture.services.localWebSearch.getBackend = async () => ({
    type: 'enabled',
    backend: 'tavily',
    impl: {
      async search({ query, signal }) {
        expect(query).toBe('search term');
        if (signal === undefined) throw new Error('Expected the search invocation signal');
        entered.resolve(signal);
        return await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      },
      async fetchPage() {
        throw new Error('Unexpected web fetch');
      },
    },
  });
  const host = fixture.host();
  const running = run(localWebSearchOperation, {
    ...post(null, '/alpha/search'),
    webSearch: { kind: 'provider', query: { query: 'search term' } },
  }, host.options);

  const backendSignal = await entered.promise;
  expect(backendSignal.aborted).toBe(false);
  host.controller.abort(reason);
  const answer = await running.result;
  expect(backendSignal.reason).toBe(reason);
  expect(answer).toEqual({ http: null, webSearch: { kind: 'abort', cause: reason } });
  running.discard(answer);
  await host.settle();
  expect(host.errors).toEqual([]);
  expect(fixture.recordPerformance).not.toHaveBeenCalled();
});
