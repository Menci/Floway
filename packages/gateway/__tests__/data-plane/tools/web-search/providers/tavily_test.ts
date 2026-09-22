import { test } from 'vitest';

import { createTavilyWebSearchProvider } from '../../../../../src/data-plane/tools/web-search/providers/tavily.ts';
import { assertEquals, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

test('createTavilyWebSearchProvider sends bearer auth and domain filters', async () => {
  let request: Request | undefined;

  await withMockedFetch(
    incoming => {
      request = incoming;
      return jsonResponse({
        results: [
          {
            title: 'React',
            url: 'https://react.dev',
            content: 'Official React documentation',
          },
        ],
      });
    },
    async () => {
      const provider = createTavilyWebSearchProvider('tvly-test');
      const result = await provider.search({
        query: 'React documentation',
        allowedDomains: ['react.dev'],
        blockedDomains: ['example.com'],
        userLocation: { country: 'US' },
      });

      assertEquals(request?.url, 'https://api.tavily.com/search');
      assertEquals(request?.headers.get('authorization'), 'Bearer tvly-test');
      const body = JSON.parse(await request!.text());
      assertEquals(body.query, 'React documentation');
      assertEquals(body.country, 'US');
      assertEquals(body.include_domains, ['react.dev']);
      assertEquals(body.exclude_domains, ['example.com']);
      assertEquals(body.max_results, 10);
      assertEquals(result.type, 'ok');
      if (result.type !== 'ok') {
        throw new Error('expected successful Tavily result');
      }
      assertEquals(result.results[0].source, 'https://react.dev');
    },
  );
});

test('createTavilyWebSearchProvider forwards maxResults when set', async () => {
  let request: Request | undefined;

  await withMockedFetch(
    incoming => {
      request = incoming;
      return jsonResponse({ results: [] });
    },
    async () => {
      const provider = createTavilyWebSearchProvider('tvly-test');
      await provider.search({ query: 'React documentation', maxResults: 3 });
      const body = JSON.parse(await request!.text());
      assertEquals(body.max_results, 3);
    },
  );
});

test('createTavilyWebSearchProvider rejects blank and overlong queries before fetch', async () => {
  let called = false;

  await withMockedFetch(
    () => {
      called = true;
      return jsonResponse({ results: [] });
    },
    async () => {
      const provider = createTavilyWebSearchProvider('tvly-test');

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

test('createTavilyWebSearchProvider maps 429 to too_many_requests', async () => {
  await withMockedFetch(
    () => jsonResponse({ message: 'rate limited' }, 429),
    async () => {
      const provider = createTavilyWebSearchProvider('tvly-test');
      assertEquals(await provider.search({ query: 'React documentation' }), {
        type: 'error',
        errorCode: 'too_many_requests',
        message: 'rate limited',
      });
    },
  );
});

test('createTavilyWebSearchProvider maps 413 to request_too_large', async () => {
  await withMockedFetch(
    () => jsonResponse({ message: 'too large' }, 413),
    async () => {
      const provider = createTavilyWebSearchProvider('tvly-test');
      assertEquals(await provider.search({ query: 'React documentation' }), {
        type: 'error',
        errorCode: 'request_too_large',
        message: 'too large',
      });
    },
  );
});

test('createTavilyWebSearchProvider surfaces malformed payload as an error', async () => {
  await withMockedFetch(
    () => jsonResponse({ message: 'unexpected' }),
    async () => {
      const provider = createTavilyWebSearchProvider('tvly-test');
      const result = await provider.search({ query: 'React documentation' });
      assertEquals(result.type, 'error');
      if (result.type !== 'error') throw new Error('expected error');
      assertEquals(result.errorCode, 'unavailable');
    },
  );
});

test('Tavily fetchPage batches multiple URLs into one extract call', async () => {
  let capturedRequest: Request | undefined;

  await withMockedFetch(
    incoming => {
      capturedRequest = incoming;
      return jsonResponse({
        results: [
          { url: 'https://a.com', raw_content: 'A body' },
          { url: 'https://b.com', raw_content: 'B body' },
        ],
        failed_results: [],
        response_time: 0.1,
        request_id: 'req-1',
      });
    },
    async () => {
      const provider = createTavilyWebSearchProvider('tvly-test');
      const result = await provider.fetchPage({ urls: ['https://a.com', 'https://b.com'] });

      assertEquals(capturedRequest?.url, 'https://api.tavily.com/extract');
      assertEquals(capturedRequest?.headers.get('authorization'), 'Bearer tvly-test');
      const body = JSON.parse(await capturedRequest!.text());
      assertEquals(body, {
        urls: ['https://a.com', 'https://b.com'],
        extract_depth: 'basic',
        format: 'markdown',
      });
      assertEquals(result, {
        type: 'ok',
        pages: [
          { url: 'https://a.com', content: 'A body', truncated: false, fullContentBytes: 6 },
          { url: 'https://b.com', content: 'B body', truncated: false, fullContentBytes: 6 },
        ],
        failures: [],
      });
    },
  );
});

test('Tavily fetchPage truncates long pages to MAX_FETCH_PAGE_BYTES', async () => {
  const longText = 'x'.repeat(20_000);
  await withMockedFetch(
    () => jsonResponse({
      results: [{ url: 'https://a.com', raw_content: longText }],
      failed_results: [],
      response_time: 0.1,
      request_id: 'r',
    }),
    async () => {
      const provider = createTavilyWebSearchProvider('tvly-test');
      const result = await provider.fetchPage({ urls: ['https://a.com'] });
      if (result.type !== 'ok') throw new Error('expected ok');
      assertEquals(result.pages[0].truncated, true);
      assertEquals(result.pages[0].fullContentBytes, 20_000);
      assertEquals(result.pages[0].content.length, 10_240);
    },
  );
});

test('Tavily fetchPage maps failed_results into failures[]', async () => {
  await withMockedFetch(
    () => jsonResponse({
      results: [],
      failed_results: [{ url: 'https://broken.com', error: '404 page not found' }],
      response_time: 0.1,
      request_id: 'r',
    }),
    async () => {
      const provider = createTavilyWebSearchProvider('tvly-test');
      const result = await provider.fetchPage({ urls: ['https://broken.com'] });
      if (result.type !== 'ok') throw new Error('expected ok');
      assertEquals(result.failures, [{ url: 'https://broken.com', errorCode: 'unavailable', message: '404 page not found' }]);
      assertEquals(result.pages, []);
    },
  );
});

test('Tavily fetchPage returns whole-batch error on HTTP 5xx', async () => {
  await withMockedFetch(
    () => new Response('upstream broken', { status: 502 }),
    async () => {
      const provider = createTavilyWebSearchProvider('tvly-test');
      const result = await provider.fetchPage({ urls: ['https://a.com'] });
      assertEquals(result.type, 'error');
      if (result.type !== 'error') throw new Error('expected error');
      assertEquals(result.errorCode, 'unavailable');
    },
  );
});

test('Tavily fetchPage surfaces malformed payload as an error when both arrays are missing', async () => {
  await withMockedFetch(
    () => jsonResponse({ message: 'unexpected' }),
    async () => {
      const provider = createTavilyWebSearchProvider('tvly-test');
      const result = await provider.fetchPage({ urls: ['https://a.com'] });
      assertEquals(result.type, 'error');
      if (result.type !== 'error') throw new Error('expected error');
      assertEquals(result.errorCode, 'unavailable');
    },
  );
});

test('Tavily fetchPage accepts a 200 with only results (failed_results omitted)', async () => {
  await withMockedFetch(
    () => jsonResponse({
      results: [{ url: 'https://a.com', raw_content: 'A body' }],
    }),
    async () => {
      const provider = createTavilyWebSearchProvider('tvly-test');
      const result = await provider.fetchPage({ urls: ['https://a.com'] });
      if (result.type !== 'ok') throw new Error('expected ok');
      assertEquals(result.pages.length, 1);
      assertEquals(result.failures, []);
    },
  );
});

test('Tavily fetchPage accepts a 200 with only failed_results (results omitted)', async () => {
  await withMockedFetch(
    () => jsonResponse({
      failed_results: [{ url: 'https://broken.com', error: '404' }],
    }),
    async () => {
      const provider = createTavilyWebSearchProvider('tvly-test');
      const result = await provider.fetchPage({ urls: ['https://broken.com'] });
      if (result.type !== 'ok') throw new Error('expected ok');
      assertEquals(result.pages, []);
      assertEquals(result.failures, [{ url: 'https://broken.com', errorCode: 'unavailable', message: '404' }]);
    },
  );
});

test('Tavily search forwards an AbortSignal to the underlying fetch (cancellation propagates)', async () => {
  // A disconnected client must stop generating upstream load. The
  // provider threads the caller-supplied AbortSignal into the fetch
  // init; the global fetch wrapper preserves it on the Request, so we
  // can read it back here to confirm it propagated.
  let captured: AbortSignal | undefined;
  await withMockedFetch(
    incoming => {
      captured = incoming.signal;
      return jsonResponse({ results: [] });
    },
    async () => {
      const controller = new AbortController();
      const provider = createTavilyWebSearchProvider('tvly-test');
      await provider.search({ query: 'x', signal: controller.signal });
      // Sanity: signal made it to the underlying Request.
      if (captured === undefined) throw new Error('signal was not forwarded');
      assertEquals(captured.aborted, false);
      controller.abort();
      assertEquals(captured.aborted, true);
    },
  );
});

test('Tavily fetchPage forwards an AbortSignal to the underlying fetch', async () => {
  let captured: AbortSignal | undefined;
  await withMockedFetch(
    incoming => {
      captured = incoming.signal;
      return jsonResponse({ results: [] });
    },
    async () => {
      const controller = new AbortController();
      const provider = createTavilyWebSearchProvider('tvly-test');
      await provider.fetchPage({ urls: ['https://x'], signal: controller.signal });
      if (captured === undefined) throw new Error('signal was not forwarded');
      controller.abort();
      assertEquals(captured.aborted, true);
    },
  );
});
