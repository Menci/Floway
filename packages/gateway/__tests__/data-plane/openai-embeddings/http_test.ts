import { test, vi } from 'vitest';

import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, flushAsyncWork, requestAppWithWarmModels, setupAppTest } from '../../test-utils/app.ts';
import { HttpTransportError } from '@floway-dev/http';
import { jsonResponse, withMockedFetch, assertEquals } from '@floway-dev/test-utils';
import { clearInProcessCopilotTokenCache } from '@floway-dev/upstream-copilot';

type IngressHeadersRules = { key: string; value: string | null }[];

const registerOpenAIEmbeddingsUpstream = async (
  repo: Awaited<ReturnType<typeof setupAppTest>>['repo'],
  ingressHeadersRules: IngressHeadersRules = [],
): Promise<void> => {
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_passthrough',
    name: 'Passthrough Embedding Provider',
    sortOrder: 100,
    config: {
      baseUrl: 'https://passthrough.example.com',
      ingressHeadersRules,
      apiKey: 'sk-passthrough',
      endpoints: {},
    },
  }));
};

test('embeddings delivery succeeds when a detached usage write fails', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerOpenAIEmbeddingsUpstream(repo);

  repo.usage.record = () => Promise.reject(new Error('simulated SQL write failure'));
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  try {
    await withMockedFetch(
      request => {
        const url = new URL(request.url);
        if (url.hostname === 'passthrough.example.com' && url.pathname === '/v1/models') {
          return jsonResponse({ object: 'list', data: [{ id: 'custom-embed-model' }] });
        }
        if (url.hostname === 'passthrough.example.com' && url.pathname === '/v1/embeddings') {
          assertEquals(request.headers.get('anthropic-beta'), null);
          assertEquals(request.headers.get('x-client-request-id'), null);
          assertEquals(request.headers.get('x-debug'), null);
          return jsonResponse({
            object: 'list',
            model: 'custom-embed-model',
            data: [{ object: 'embedding', index: 0, embedding: [0.5] }],
            usage: { prompt_tokens: 3, total_tokens: 3 },
          });
        }
        throw new Error(`Unhandled fetch ${request.url}`);
      },
      async () => {
        const response = await requestAppWithWarmModels('/v1/embeddings', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey.key,
            'anthropic-beta': 'context-1m-2025-08-07',
            'x-client-request-id': 'request-1',
            'x-debug': 'discard',
          },
          body: JSON.stringify({ model: 'custom-embed-model', input: 'hi' }),
        });

        assertEquals(response.status, 200);
        const body = await response.json() as { data: Array<{ embedding: number[] }> };
        assertEquals(body.data[0].embedding, [0.5]);
        await flushAsyncWork();
      },
    );
  } finally {
    errorSpy.mockRestore();
  }
});

test('embeddings treats a non-JSON upstream 2xx as an upstream failure', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerOpenAIEmbeddingsUpstream(repo);

  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

  try {
    const binary = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    await withMockedFetch(
      request => {
        const url = new URL(request.url);
        if (url.hostname === 'passthrough.example.com' && url.pathname === '/v1/models') {
          return jsonResponse({ object: 'list', data: [{ id: 'custom-embed-model' }] });
        }
        if (url.hostname === 'passthrough.example.com' && url.pathname === '/v1/embeddings') {
          return new Response(binary, {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
          });
        }
        throw new Error(`Unhandled fetch ${request.url}`);
      },
      async () => {
        const response = await requestAppWithWarmModels('/v1/embeddings', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
          body: JSON.stringify({ model: 'custom-embed-model', input: 'hi' }),
        });

        assertEquals(response.status, 502);
        assertEquals(response.headers.get('content-type'), 'application/json');
        const body = await response.json() as { error: { type: string } };
        assertEquals(body.error.type, 'server_error');
        await flushAsyncWork();
      },
    );

    assertEquals(await repo.usage.listAll(), []);
    const performance = await repo.performance.listAll();
    assertEquals(performance.map(row => [row.requests, row.errorsNoOutput]), [[1, 1]]);
  } finally {
    warnSpy.mockRestore();
  }
});

const registerTwoOpenAIEmbeddingsUpstreams = async (
  repo: Awaited<ReturnType<typeof setupAppTest>>['repo'],
  { first = [], second = [] }: { first?: IngressHeadersRules; second?: IngressHeadersRules } = {},
): Promise<void> => {
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_a', name: 'Upstream A', sortOrder: 100,
    config: { baseUrl: 'https://up-a.example.com', apiKey: 'sk-a', endpoints: {}, ingressHeadersRules: first },
  }));
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_b', name: 'Upstream B', sortOrder: 200,
    config: { baseUrl: 'https://up-b.example.com', apiKey: 'sk-b', endpoints: {}, ingressHeadersRules: second },
  }));
};

test('embeddings retries a 5xx with independent upstream header policies', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerTwoOpenAIEmbeddingsUpstreams(repo, {
    first: [{ key: 'X-Client-Request-ID', value: 'first-attempt-id' }],
    second: [{ key: 'x-client-request-id', value: null }],
  });

  let firstOpenAIEmbeddingsCalls = 0;
  let secondOpenAIEmbeddingsCalls = 0;
  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.pathname === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'custom-embed-model' }] });
      }
      if (url.hostname === 'up-a.example.com' && url.pathname === '/v1/embeddings') {
        firstOpenAIEmbeddingsCalls += 1;
        assertEquals(request.headers.get('x-client-request-id'), 'first-attempt-id');
        assertEquals(request.headers.get('authorization'), 'Bearer sk-a');
        return new Response('upstream boom', { status: 503 });
      }
      if (url.hostname === 'up-b.example.com' && url.pathname === '/v1/embeddings') {
        secondOpenAIEmbeddingsCalls += 1;
        assertEquals(request.headers.get('x-client-request-id'), 'client-id');
        assertEquals(request.headers.get('authorization'), 'Bearer sk-b');
        return jsonResponse({
          object: 'list',
          model: 'custom-embed-model',
          data: [{ object: 'embedding', index: 0, embedding: [0.25] }],
          usage: { prompt_tokens: 2, total_tokens: 2 },
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestAppWithWarmModels('/v1/embeddings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key, 'X-Client-Request-Id': 'client-id' },
        body: JSON.stringify({ model: 'custom-embed-model', input: 'hi' }),
      });

      assertEquals(response.status, 200);
      const body = await response.json() as { data: Array<{ embedding: number[] }> };
      assertEquals(body.data[0].embedding, [0.25]);
      await flushAsyncWork();
    },
  );

  assertEquals(firstOpenAIEmbeddingsCalls, 1);
  assertEquals(secondOpenAIEmbeddingsCalls, 1);
});

test('embeddings preserves the selected upstream JSON error and Retry-After', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerTwoOpenAIEmbeddingsUpstreams(repo);

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.pathname === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'custom-embed-model' }] });
      }
      if (url.hostname === 'up-a.example.com' && url.pathname === '/v1/embeddings') {
        return new Response('first upstream unavailable', { status: 503 });
      }
      if (url.hostname === 'up-b.example.com' && url.pathname === '/v1/embeddings') {
        return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
          status: 429, headers: { 'content-type': 'application/json', 'retry-after': '17' },
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestAppWithWarmModels('/v1/embeddings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({ model: 'custom-embed-model', input: 'hi' }),
      });

      assertEquals(response.status, 429);
      assertEquals(response.headers.get('retry-after'), '17');
      const body = await response.json() as { error: { message: string } };
      assertEquals(body.error.message, 'rate limited');
      await flushAsyncWork();
    },
  );
});

test.each([
  ['disconnected', 'success', 200, null],
  ['limited', 'disconnected', 429, '17'],
  ['limited', 'unavailable', 429, '17'],
  ['limited', 'limited-later', 429, '17'],
  ['limited-later', 'limited', 429, '17'],
  ['disabled', 'limited', 429, '17'],
] as const)('embeddings %s followed by %s preserves the selected response', async (first, second, status, retryAfter) => {
  const { apiKey, repo } = await setupAppTest();
  await registerTwoOpenAIEmbeddingsUpstreams(repo);
  if (first === 'disabled') {
    const upstream = await repo.upstreams.getById('up_a');
    if (!upstream) throw new Error('missing fixture upstream');
    await saveUpstreamForTest(repo.upstreams, { ...upstream, enabled: false });
  }
  const calls: string[] = [];
  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.pathname === '/v1/models') return jsonResponse({ object: 'list', data: [{ id: 'custom-embed-model' }] });
      if (url.pathname !== '/v1/embeddings') throw new Error(`Unexpected fetch ${request.url}`);
      const behavior = url.hostname === 'up-a.example.com' ? first : second;
      calls.push(url.hostname);
      if (behavior === 'disabled') throw new Error('disabled upstream was called');
      if (behavior === 'disconnected') throw new HttpTransportError(new Error('fixture connection refused'));
      if (behavior === 'success') return jsonResponse({ object: 'list', data: [], usage: { prompt_tokens: 1, total_tokens: 1 } });
      if (behavior === 'unavailable') return new Response('fixture unavailable', { status: 503 });
      return new Response(`limit from ${url.hostname}`, {
        status: 429,
        headers: { 'retry-after': behavior === 'limited' ? '17' : '60', 'x-request-id': url.hostname },
      });
    },
    async () => {
      const response = await requestAppWithWarmModels('/v1/embeddings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({ model: 'custom-embed-model', input: 'hi' }),
      });
      assertEquals(response.status, status);
      assertEquals(response.headers.get('retry-after'), retryAfter);
      if (retryAfter !== null) {
        const selected = first === 'limited' ? 'up-a.example.com' : 'up-b.example.com';
        assertEquals(response.headers.get('x-request-id'), selected);
        assertEquals(await response.json(), {
          error: { type: 'invalid_request_error', message: `limit from ${selected}` },
        });
      } else {
        await response.text();
      }
      assertEquals(calls, first === 'disabled' ? ['up-b.example.com'] : ['up-a.example.com', 'up-b.example.com']);
      await flushAsyncWork();
    },
  );
});

test('embeddings surfaces a candidate panic after counting the prior ordinary failure', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerTwoOpenAIEmbeddingsUpstreams(repo);

  const panic = new Error('simulated embedding candidate panic');
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  try {
    await withMockedFetch(
      request => {
        const url = new URL(request.url);
        if (url.pathname === '/v1/models') {
          return jsonResponse({ object: 'list', data: [{ id: 'custom-embed-model' }] });
        }
        if (url.hostname === 'up-a.example.com' && url.pathname === '/v1/embeddings') {
          return new Response('first upstream unavailable', { status: 503 });
        }
        if (url.hostname === 'up-b.example.com' && url.pathname === '/v1/embeddings') {
          throw panic;
        }
        throw new Error(`Unhandled fetch ${request.url}`);
      },
      async () => {
        const response = await requestAppWithWarmModels('/v1/embeddings', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
          body: JSON.stringify({ model: 'custom-embed-model', input: 'hi' }),
        });

        assertEquals(response.status, 500);
        assertEquals(errorSpy.mock.calls.flat().includes(panic), true);
        await flushAsyncWork();
      },
    );

    const perfRows = await repo.performance.listAll();
    const errorRows = perfRows.filter(row => row.errorsNoOutput + row.errorsWithOutput > 0);
    assertEquals(errorRows.length, 1);
    assertEquals(errorRows[0].upstream, 'up_a');
  } finally {
    errorSpy.mockRestore();
  }
});
