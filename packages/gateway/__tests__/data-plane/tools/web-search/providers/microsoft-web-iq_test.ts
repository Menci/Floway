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

test('createMicrosoftWebIqWebSearchProvider forwards maxResults to upstream count', async () => {
  let request: Request | undefined;
  await withMockedFetch(
    incoming => {
      request = incoming;
      return jsonResponse({ webResults: [] });
    },
    async () => {
      const provider = createMicrosoftWebIqWebSearchProvider('ms-test');
      await provider.search({ query: 'React documentation', maxResults: 4 });
      const body = JSON.parse(await request!.text());
      assertEquals(body.count, 4);
    },
  );
});

test('createMicrosoftWebIqWebSearchProvider rejects blank and overlong queries before fetch', async () => {
  let called = false;

  await withMockedFetch(
    () => {
      called = true;
      return jsonResponse({ webResults: [] });
    },
    async () => {
      const provider = createMicrosoftWebIqWebSearchProvider('ms-test');

      assertEquals(await provider.search({ query: '   ' }), {
        type: 'error',
        errorCode: 'invalid_tool_input',
        message: 'Search query must not be empty.',
      });

      assertEquals(await provider.search({ query: 'x'.repeat(1001) }), {
        type: 'error',
        errorCode: 'query_too_long',
        message: 'Search query must be at most 1000 characters.',
      });
    },
  );

  assertEquals(called, false);
});

test('createMicrosoftWebIqWebSearchProvider retries 429 with by-design 1s/2s/4s/8s backoff and ignores retryAfter when the next attempt succeeds', async () => {
  const fakeTime = new FakeTime();
  const attemptTimes: number[] = [];
  let attempts = 0;

  try {
    await withMockedFetch(
      () => {
        attemptTimes.push(Date.now());
        attempts += 1;

        if (attempts < 5) {
          return jsonResponse({ message: 'rate limited', retryAfter: '60s' }, 429);
        }

        return jsonResponse({
          webResults: [
            {
              title: 'React',
              url: 'https://react.dev',
              content: 'Official React documentation',
            },
          ],
        });
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

        const result = await resultPromise;
        assertEquals(attemptTimes.length, 5);
        assertEquals(
          attemptTimes.map(time => time - attemptTimes[0]),
          [0, 1000, 3000, 7000, 15000],
        );
        assertEquals(result.type, 'ok');
      },
    );
  } finally {
    fakeTime.restore();
  }
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

test('createMicrosoftWebIqWebSearchProvider maps 413 to request_too_large', async () => {
  await withMockedFetch(
    () => jsonResponse({ message: 'too large' }, 413),
    async () => {
      const provider = createMicrosoftWebIqWebSearchProvider('ms-test');
      assertEquals(await provider.search({ query: 'React documentation' }), {
        type: 'error',
        errorCode: 'request_too_large',
        message: 'too large',
      });
    },
  );
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
test('createMicrosoftWebIqWebSearchProvider surfaces malformed payload as an error', async () => {
  await withMockedFetch(
    () => jsonResponse({ message: 'unexpected' }),
    async () => {
      const provider = createMicrosoftWebIqWebSearchProvider('ms-test');
      const result = await provider.search({ query: 'React documentation' });
      assertEquals(result.type, 'error');
      if (result.type !== 'error') throw new Error('expected error');
      assertEquals(result.errorCode, 'unavailable');
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
      for (const body of callBodies) {
        assertEquals(body.renderDynamicPages, true);
        assertEquals(body.liveCrawl, 'fallback');
        assertEquals(body.contentFormat, 'markdown');
        assertEquals(body.maxLength, 50_000);
      }
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

test('Microsoft Web IQ fetchPage truncates long pages to MAX_FETCH_PAGE_BYTES', async () => {
  const long = 'y'.repeat(30_000);
  await withMockedFetch(
    async incoming => {
      const body = JSON.parse(await incoming.text());
      return jsonResponse({ url: body.url, title: 'T', content: long });
    },
    async () => {
      const provider = createMicrosoftWebIqWebSearchProvider('ms-test');
      const result = await provider.fetchPage({ urls: ['https://a.com'] });
      if (result.type !== 'ok') throw new Error('expected ok');
      assertEquals(result.pages[0].truncated, true);
      assertEquals(result.pages[0].content.length, 10_240);
      assertEquals(result.pages[0].fullContentBytes, 30_000);
    },
  );
});

test('Microsoft Web IQ fetchPage returns whole-batch error on HTTP 5xx after retry exhaustion', async () => {
  const fakeTime = new FakeTime();
  try {
    await withMockedFetch(
      () => new Response('upstream broken', { status: 502 }),
      async () => {
        const provider = createMicrosoftWebIqWebSearchProvider('ms-test');
        const resultPromise = provider.fetchPage({ urls: ['https://a.com'] });
        await fakeTime.tickAsync(15_000);
        const result = await resultPromise;
        assertEquals(result.type, 'error');
        if (result.type !== 'error') throw new Error('expected error');
        assertEquals(result.errorCode, 'unavailable');
      },
    );
  } finally {
    fakeTime.restore();
  }
});
