import { test } from 'vitest';

import { createJinaWebSearchProvider } from '../../../../../src/data-plane/tools/web-search/providers/jina.ts';
import { assertEquals, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const okEnvelope = (data: unknown) => jsonResponse({ code: 200, status: 20000, data, meta: { usage: { tokens: 1 } } });

const errorEnvelope = (httpStatus: number, name: string, message: string, status?: number) => jsonResponse(
  { code: httpStatus, status: status ?? httpStatus * 100, name, message, data: null },
  httpStatus,
);

test('createJinaWebSearchProvider sends bearer auth, X-Max-Tokens, X-Site, and gl', async () => {
  let request: Request | undefined;

  await withMockedFetch(
    incoming => {
      request = incoming;
      return okEnvelope([
        {
          title: 'React',
          url: 'https://react.dev',
          content: 'Official React documentation',
          publishedTime: 'Fri, 19 Jun 2026 18:46:03 GMT',
        },
      ]);
    },
    async () => {
      const provider = createJinaWebSearchProvider('jina-test');
      const result = await provider.search({
        query: 'React documentation',
        allowedDomains: ['react.dev', 'reactjs.org'],
        blockedDomains: ['example.com'],
        userLocation: { country: 'US' },
      });

      const url = new URL(request!.url);
      assertEquals(url.origin + url.pathname, 'https://s.jina.ai/');
      assertEquals(url.searchParams.get('q'), 'React documentation');
      assertEquals(url.searchParams.get('count'), '10');
      assertEquals(url.searchParams.get('gl'), 'us');
      assertEquals(request?.method, 'GET');
      assertEquals(request?.headers.get('authorization'), 'Bearer jina-test');
      assertEquals(request?.headers.get('accept'), 'application/json');
      assertEquals(request?.headers.get('x-max-tokens'), '500');
      assertEquals(request?.headers.get('x-site'), 'react.dev, reactjs.org');
      assertEquals(result.type, 'ok');
      if (result.type !== 'ok') throw new Error('expected ok');
      assertEquals(result.results[0].source, 'https://react.dev');
      assertEquals(result.results[0].title, 'React');
      assertEquals(result.results[0].pageAge, 'Fri, 19 Jun 2026 18:46:03 GMT');
      assertEquals(result.results[0].content, [{ type: 'text', text: 'Official React documentation' }]);
    },
  );
});

test('createJinaWebSearchProvider falls back to SERP description when content is absent', async () => {
  await withMockedFetch(
    () => okEnvelope([{ title: 'React', url: 'https://react.dev', description: 'short snippet' }]),
    async () => {
      const provider = createJinaWebSearchProvider('jina-test');
      const result = await provider.search({ query: 'React' });
      if (result.type !== 'ok') throw new Error('expected ok');
      assertEquals(result.results[0].content, [{ type: 'text', text: 'short snippet' }]);
    },
  );
});

test('createJinaWebSearchProvider clamps maxResults to Jina cap of 20', async () => {
  let request: Request | undefined;
  await withMockedFetch(
    incoming => {
      request = incoming;
      return okEnvelope([]);
    },
    async () => {
      const provider = createJinaWebSearchProvider('jina-test');
      await provider.search({ query: 'React', maxResults: 50 });
      const url = new URL(request!.url);
      assertEquals(url.searchParams.get('count'), '20');
    },
  );
});

test('createJinaWebSearchProvider normalizes AssertionFailureError "no search results" to ok empty', async () => {
  await withMockedFetch(
    () => errorEnvelope(404, 'AssertionFailureError', 'No search results available for query "asdfqwerty"'),
    async () => {
      const provider = createJinaWebSearchProvider('jina-test');
      assertEquals(await provider.search({ query: 'asdfqwerty' }), { type: 'ok', results: [] });
    },
  );
});

test('Jina fetchPage fans out one POST per URL and parses the envelope', async () => {
  const captured: Request[] = [];
  await withMockedFetch(
    async incoming => {
      const clone = incoming.clone();
      captured.push(incoming);
      const body = JSON.parse(await clone.text());
      return okEnvelope({ url: body.url as string, title: `Title ${body.url as string}`, content: `body of ${body.url as string}` });
    },
    async () => {
      const provider = createJinaWebSearchProvider('jina-test');
      const result = await provider.fetchPage({ urls: ['https://a.com', 'https://b.com'] });

      assertEquals(captured.length, 2);
      assertEquals(captured[0].url, 'https://r.jina.ai/');
      assertEquals(captured[0].method, 'POST');
      assertEquals(captured[0].headers.get('authorization'), 'Bearer jina-test');
      assertEquals(captured[0].headers.get('accept'), 'application/json');
      assertEquals(result, {
        type: 'ok',
        pages: [
          { url: 'https://a.com', title: 'Title https://a.com', content: 'body of https://a.com', truncated: false, fullContentBytes: 21 },
          { url: 'https://b.com', title: 'Title https://b.com', content: 'body of https://b.com', truncated: false, fullContentBytes: 21 },
        ],
        failures: [],
      });
    },
  );
});
