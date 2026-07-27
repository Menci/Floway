import { test } from 'vitest';

import { createJinaWebSearchProvider } from '../../../../../src/data-plane/tools/web-search/providers/jina.ts';
import { FakeTime } from '../../../../test-time.ts';
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

test('createJinaWebSearchProvider omits X-Site when no allowed domains', async () => {
  let request: Request | undefined;
  await withMockedFetch(
    incoming => {
      request = incoming;
      return okEnvelope([]);
    },
    async () => {
      const provider = createJinaWebSearchProvider('jina-test');
      await provider.search({ query: 'React' });
      assertEquals(request?.headers.has('x-site'), false);
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

test('createJinaWebSearchProvider forwards explicit maxResults below the cap', async () => {
  let request: Request | undefined;
  await withMockedFetch(
    incoming => {
      request = incoming;
      return okEnvelope([]);
    },
    async () => {
      const provider = createJinaWebSearchProvider('jina-test');
      await provider.search({ query: 'React', maxResults: 3 });
      const url = new URL(request!.url);
      assertEquals(url.searchParams.get('count'), '3');
    },
  );
});

test('createJinaWebSearchProvider rejects blank and overlong queries before fetch', async () => {
  let called = false;
  await withMockedFetch(
    () => {
      called = true;
      return okEnvelope([]);
    },
    async () => {
      const provider = createJinaWebSearchProvider('jina-test');
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

test('createJinaWebSearchProvider maps 429 to too_many_requests', async () => {
  await withMockedFetch(
    () => errorEnvelope(429, 'RateLimitError', 'rate limited'),
    async () => {
      const provider = createJinaWebSearchProvider('jina-test');
      assertEquals(await provider.search({ query: 'React' }), {
        type: 'error',
        errorCode: 'too_many_requests',
        message: 'rate limited',
      });
    },
  );
});

test('createJinaWebSearchProvider maps 400 ParamValidationError to invalid_tool_input', async () => {
  await withMockedFetch(
    () => errorEnvelope(400, 'ParamValidationError', 'bad gl'),
    async () => {
      const provider = createJinaWebSearchProvider('jina-test');
      assertEquals(await provider.search({ query: 'React' }), {
        type: 'error',
        errorCode: 'invalid_tool_input',
        message: 'bad gl',
      });
    },
  );
});

test('createJinaWebSearchProvider maps 401 AuthenticationFailedError to unavailable', async () => {
  await withMockedFetch(
    () => errorEnvelope(401, 'AuthenticationFailedError', 'Invalid API key'),
    async () => {
      const provider = createJinaWebSearchProvider('jina-test');
      const result = await provider.search({ query: 'React' });
      assertEquals(result.type, 'error');
      if (result.type !== 'error') throw new Error('expected error');
      assertEquals(result.errorCode, 'unavailable');
      assertEquals(result.message, 'Invalid API key');
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

test('createJinaWebSearchProvider surfaces other AssertionFailureError as unavailable', async () => {
  await withMockedFetch(
    () => errorEnvelope(404, 'AssertionFailureError', 'Engine selection failed'),
    async () => {
      const provider = createJinaWebSearchProvider('jina-test');
      const result = await provider.search({ query: 'React' });
      assertEquals(result.type, 'error');
      if (result.type !== 'error') throw new Error('expected error');
      assertEquals(result.errorCode, 'unavailable');
    },
  );
});

test('createJinaWebSearchProvider treats malformed envelope as unavailable', async () => {
  await withMockedFetch(
    () => jsonResponse({ message: 'unexpected' }),
    async () => {
      const provider = createJinaWebSearchProvider('jina-test');
      const result = await provider.search({ query: 'React' });
      assertEquals(result.type, 'error');
      if (result.type !== 'error') throw new Error('expected error');
      assertEquals(result.errorCode, 'unavailable');
    },
  );
});

test('createJinaWebSearchProvider drops entries missing title or url', async () => {
  await withMockedFetch(
    () => okEnvelope([
      { url: 'https://a', content: 'no title' },
      { title: 'B', url: 'https://b', content: 'ok' },
    ]),
    async () => {
      const provider = createJinaWebSearchProvider('jina-test');
      const result = await provider.search({ query: 'x' });
      if (result.type !== 'ok') throw new Error('expected ok');
      assertEquals(result.results.length, 1);
      assertEquals(result.results[0].source, 'https://b');
    },
  );
});

test('createJinaWebSearchProvider forwards an AbortSignal to the underlying fetch', async () => {
  let captured: AbortSignal | undefined;
  await withMockedFetch(
    incoming => {
      captured = incoming.signal;
      return okEnvelope([]);
    },
    async () => {
      const controller = new AbortController();
      const provider = createJinaWebSearchProvider('jina-test');
      await provider.search({ query: 'x', signal: controller.signal });
      if (captured === undefined) throw new Error('signal was not forwarded');
      controller.abort();
      assertEquals(captured.aborted, true);
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

test('Jina fetchPage returns empty ok envelope for no URLs', async () => {
  let called = false;
  await withMockedFetch(
    () => {
      called = true;
      return okEnvelope({});
    },
    async () => {
      const provider = createJinaWebSearchProvider('jina-test');
      const result = await provider.fetchPage({ urls: [] });
      assertEquals(result, { type: 'ok', pages: [], failures: [] });
      assertEquals(called, false);
    },
  );
});

test('Jina fetchPage truncates a long page to MAX_FETCH_PAGE_BYTES', async () => {
  const longText = 'x'.repeat(20_000);
  await withMockedFetch(
    () => okEnvelope({ url: 'https://a.com', content: longText }),
    async () => {
      const provider = createJinaWebSearchProvider('jina-test');
      const result = await provider.fetchPage({ urls: ['https://a.com'] });
      if (result.type !== 'ok') throw new Error('expected ok');
      assertEquals(result.pages[0].truncated, true);
      assertEquals(result.pages[0].fullContentBytes, 20_000);
      assertEquals(result.pages[0].content.length, 10_240);
    },
  );
});

test('Jina fetchPage routes a 4xx URL to failures while keeping the rest', async () => {
  await withMockedFetch(
    async incoming => {
      const body = JSON.parse(await incoming.clone().text());
      if (body.url === 'https://broken.com') {
        return errorEnvelope(400, 'ParamValidationError', 'unreachable');
      }
      return okEnvelope({ url: body.url as string, content: 'ok body' });
    },
    async () => {
      const provider = createJinaWebSearchProvider('jina-test');
      const result = await provider.fetchPage({ urls: ['https://a.com', 'https://broken.com'] });
      if (result.type !== 'ok') throw new Error('expected ok');
      assertEquals(result.pages.length, 1);
      assertEquals(result.pages[0].url, 'https://a.com');
      assertEquals(result.failures, [
        { url: 'https://broken.com', errorCode: 'invalid_tool_input', message: 'unreachable' },
      ]);
    },
  );
});

test('Jina fetchPage retries 429 with 1s/2s/4s/8s backoff and succeeds on the fifth try', async () => {
  const fakeTime = new FakeTime();
  let attempts = 0;
  try {
    await withMockedFetch(
      () => {
        attempts += 1;
        if (attempts < 5) return errorEnvelope(429, 'RateLimitError', 'rate limited');
        return okEnvelope({ url: 'https://a.com', content: 'finally' });
      },
      async () => {
        const provider = createJinaWebSearchProvider('jina-test');
        const promise = provider.fetchPage({ urls: ['https://a.com'] });

        fakeTime.runMicrotasks();
        assertEquals(attempts, 1);
        await fakeTime.tickAsync(1000);
        assertEquals(attempts, 2);
        await fakeTime.tickAsync(2000);
        assertEquals(attempts, 3);
        await fakeTime.tickAsync(4000);
        assertEquals(attempts, 4);
        await fakeTime.tickAsync(8000);

        const result = await promise;
        if (result.type !== 'ok') throw new Error('expected ok');
        assertEquals(result.pages[0].content, 'finally');
      },
    );
  } finally {
    fakeTime.restore();
  }
});

test('Jina fetchPage surfaces a per-URL 429 failure after exhausting retries', async () => {
  const fakeTime = new FakeTime();
  try {
    await withMockedFetch(
      // First URL keeps 429ing; second succeeds — verifies retry exhaustion
      // routes to failures[] while keeping the rest of the batch intact.
      async incoming => {
        const body = JSON.parse(await incoming.clone().text());
        if (body.url === 'https://hot.com') return errorEnvelope(429, 'RateLimitError', 'rate limited');
        return okEnvelope({ url: body.url as string, content: 'cool body' });
      },
      async () => {
        const provider = createJinaWebSearchProvider('jina-test');
        const promise = provider.fetchPage({ urls: ['https://hot.com', 'https://cool.com'] });
        // Drain the retry timeline (1+2+4+8 = 15s).
        await fakeTime.tickAsync(15_000);
        const result = await promise;
        if (result.type !== 'ok') throw new Error('expected ok');
        assertEquals(result.pages.length, 1);
        assertEquals(result.pages[0].url, 'https://cool.com');
        assertEquals(result.failures, [
          { url: 'https://hot.com', errorCode: 'too_many_requests', message: 'rate limited' },
        ]);
      },
    );
  } finally {
    fakeTime.restore();
  }
});

test('Jina fetchPage collapses to whole-batch error when every URL transport-fails', async () => {
  await withMockedFetch(
    () => Promise.reject(new Error('network down')),
    async () => {
      const provider = createJinaWebSearchProvider('jina-test');
      const result = await provider.fetchPage({ urls: ['https://a.com', 'https://b.com'] });
      assertEquals(result.type, 'error');
      if (result.type !== 'error') throw new Error('expected error');
      assertEquals(result.errorCode, 'unavailable');
      assertEquals(result.message, 'network down');
    },
  );
});

test('Jina fetchPage forwards an AbortSignal to each per-URL fetch', async () => {
  const captured: AbortSignal[] = [];
  await withMockedFetch(
    incoming => {
      captured.push(incoming.signal);
      return okEnvelope({ url: 'https://x', content: 'ok' });
    },
    async () => {
      const controller = new AbortController();
      const provider = createJinaWebSearchProvider('jina-test');
      await provider.fetchPage({ urls: ['https://a', 'https://b'], signal: controller.signal });
      assertEquals(captured.length, 2);
      controller.abort();
      assertEquals(captured.every(s => s.aborted), true);
    },
  );
});
