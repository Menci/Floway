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

test('createTavilyWebSearchProvider maps recencyDays to a publish-date window', async () => {
  for (const [days, expected] of [[1, 'day'], [3, 'week'], [10, 'month'], [400, 'year']] as const) {
    let request: Request | undefined;
    await withMockedFetch(
      incoming => {
        request = incoming;
        return jsonResponse({ results: [] });
      },
      async () => {
        const provider = createTavilyWebSearchProvider('tvly-test');
        await provider.search({ query: 'React', recencyDays: days });
        const body = JSON.parse(await request!.text());
        assertEquals(body.time_range, expected);
      },
    );
  }
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
