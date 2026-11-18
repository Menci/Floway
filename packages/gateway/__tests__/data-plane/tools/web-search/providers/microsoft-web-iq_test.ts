import { test } from 'vitest';

import { createMicrosoftWebIqWebSearchProvider } from '../../../../../src/data-plane/tools/web-search/providers/microsoft-web-iq.ts';
import { FakeTime } from '../../../../test-time.ts';
import { assertEquals, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

test('createMicrosoftWebIqWebSearchProvider calls v3 search/web with passage content', async () => {
  let request: Request | undefined;

  await withMockedFetch(
    incoming => {
      request = incoming;
      return jsonResponse({
        webResults: [
          {
            title: 'React',
            url: 'https://react.dev',
            content: 'Official React documentation',
            lastUpdatedAt: '2026-04-01T00:00:00Z',
          },
        ],
      });
    },
    async () => {
      const provider = createMicrosoftWebIqWebSearchProvider('ms-test');
      const result = await provider.search({
        query: 'React documentation',
        allowedDomains: ['react.dev', 'example.com OR site:evil.com'],
        blockedDomains: ['example.com', 'bad.com test'],
        userLocation: {
          country: 'GB',
          region: 'WA',
        },
      });

      assertEquals(request?.url, 'https://api.microsoft.ai/v3/search/web');
      assertEquals(request?.headers.get('x-apikey'), 'ms-test');
      const body = JSON.parse(await request!.text());
      assertEquals(body.query, 'React documentation site:react.dev -site:example.com');
      assertEquals(body.count, 10);
      assertEquals(body.contentFormat, 'passage');
      assertEquals(body.region, 'GB');
      assertEquals(result.type, 'ok');
      if (result.type !== 'ok') {
        throw new Error('expected successful Microsoft Web IQ result');
      }
      assertEquals(result.results[0].pageAge, '2026-04-01T00:00:00Z');
    },
  );
});

test('createMicrosoftWebIqWebSearchProvider returns too_many_requests after four by-design 429 retries and ignores retryAfter', async () => {
  const fakeTime = new FakeTime();
  const attemptTimes: number[] = [];

  try {
    await withMockedFetch(
      () => {
        attemptTimes.push(Date.now());
        return jsonResponse({ message: 'rate limited', retryAfter: '60s' }, 429);
      },
      async () => {
        const provider = createMicrosoftWebIqWebSearchProvider('ms-test');
        const resultPromise = provider.search({ query: 'React documentation' });

        fakeTime.runMicrotasks();
        assertEquals(attemptTimes.length, 1);

        await fakeTime.tickAsync(1000);
        assertEquals(attemptTimes.length, 2);

        await fakeTime.tickAsync(2000);
        assertEquals(attemptTimes.length, 3);

        await fakeTime.tickAsync(4000);
        assertEquals(attemptTimes.length, 4);

        await fakeTime.tickAsync(8000);

        assertEquals(await resultPromise, {
          type: 'error',
          errorCode: 'too_many_requests',
          message: 'rate limited',
        });
        assertEquals(attemptTimes.length, 5);
        assertEquals(
          attemptTimes.map(time => time - attemptTimes[0]),
          [0, 1000, 3000, 7000, 15000],
        );
      },
    );
  } finally {
    fakeTime.restore();
  }
});

test('createMicrosoftWebIqWebSearchProvider surfaces the envelope userMessage rather than raw JSON', async () => {
  // Shape captured from POST https://api.microsoft.ai/v3/search/web with an
  // invalid key. None of its keys are the generic ones, so without the
  // envelope rung the operator would read the whole body.
  await withMockedFetch(
    () => jsonResponse({
      errorCode: 'AuthInvalidApiKey',
      errorCategory: 'UserError',
      userMessage: 'Invalid API key provided.',
      technicalDetails: 'Invalid API key',
      retryAfter: null,
      requestId: '6a68d5eb52c34a62a2d8a4c09c6d2dd2',
      traceId: '6a68d5eb52c34a62a2d8a4c09c6d2dd2',
    }, 401),
    async () => {
      const provider = createMicrosoftWebIqWebSearchProvider('ms-test');
      assertEquals(await provider.search({ query: 'React documentation' }), {
        type: 'error',
        errorCode: 'unavailable',
        message: 'Invalid API key provided.',
      });
    },
  );
});

test('Microsoft Web IQ fetchPage issues one /v3/browse call per URL in parallel', async () => {
  const callBodies: Array<Record<string, unknown>> = [];

  await withMockedFetch(
    async incoming => {
      const body = JSON.parse(await incoming.text());
      callBodies.push(body);
      return jsonResponse({
        url: body.url,
        title: 'T',
        content: `body of ${body.url}`,
        crawledAt: '2026-05-24T00:00:00Z',
      });
    },
    async () => {
      const provider = createMicrosoftWebIqWebSearchProvider('ms-test');
      const result = await provider.fetchPage({ urls: ['https://a.com', 'https://b.com'] });

      assertEquals(callBodies.length, 2);
      const urlsCalled = callBodies.map(b => b.url).sort();
      assertEquals(urlsCalled, ['https://a.com', 'https://b.com']);
      if (result.type !== 'ok') throw new Error('expected ok');
      assertEquals(result.pages.length, 2);
      assertEquals(result.failures, []);
      const pagesByUrl = Object.fromEntries(result.pages.map(p => [p.url, p]));
      assertEquals(pagesByUrl['https://a.com'].content, 'body of https://a.com');
      assertEquals(pagesByUrl['https://a.com'].title, 'T');
      assertEquals(pagesByUrl['https://a.com'].truncated, false);
    },
  );
});

test('Microsoft Web IQ fetchPage treats HTTP 202 as a per-URL failure (cold cache)', async () => {
  await withMockedFetch(
    () => jsonResponse({ retryAfter: '30' }, 202),
    async () => {
      const provider = createMicrosoftWebIqWebSearchProvider('ms-test');
      const result = await provider.fetchPage({ urls: ['https://cold.com'] });
      if (result.type !== 'ok') throw new Error('expected ok');
      assertEquals(result.failures, [{ url: 'https://cold.com', errorCode: 'unavailable', message: 'live crawl pending' }]);
      assertEquals(result.pages, []);
    },
  );
});
