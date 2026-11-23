import { expect, test, vi } from 'vitest';

import { app } from '../../../src/app.ts';
import { initDumpBroker, initDumpStore } from '../../../src/dump/registry.ts';
import { initBackgroundSchedulerResolver } from '../../../src/runtime/background.ts';
import { installDumpStubs } from '../../dump/test-fixtures.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, flushAsyncWork, requestAppWithWarmModels, setupAppTest } from '../../test-utils/app.ts';
import { flushBackground, trackBackground } from '../../test-utils/background-tracker.ts';
import { clearInProcessCopilotTokenCache } from '@floway-dev/provider-copilot';
import { jsonResponse, withMockedFetch, assertEquals } from '@floway-dev/test-utils';

const registerOpenAIEmbeddingsUpstream = async (
  repo: Awaited<ReturnType<typeof setupAppTest>>['repo'],
  ingressHeadersRules: { key: string; value: string | null }[] = [],
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

test.each(['/v1/embeddings', '/v1/completions', '/v1/audio/transcriptions'])('an interrupted upload to %s returns 502 and finishes the run and dump', async path => {
  const { apiKey, repo } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const dumps = installDumpStubs(initDumpStore, initDumpBroker);
  const tasks: Promise<unknown>[] = [];
  initBackgroundSchedulerResolver(() => promise => tasks.push(promise));
  try {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"model":'));
        controller.error(new Error('client upload interrupted'));
      },
    });
    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      headers: {
        'content-type': path === '/v1/audio/transcriptions' ? 'multipart/form-data; boundary=fixture' : 'application/json',
        'x-api-key': apiKey.key,
      },
      body, duplex: 'half',
    };
    const response = await app.fetch(new Request(`https://floway.test${path}`, init));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { message: 'client upload interrupted' } });
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    expect(await Promise.all(tasks)).toContainEqual({ ok: true });
    expect(dumps.stored).toHaveLength(1);
    expect(dumps.stored[0]!.meta).toMatchObject({ status: 502, requestBytes: 0, error: { kind: 'failed', reason: 'client upload interrupted' } });
    expect(await repo.usage.listAll()).toEqual([]);
    expect(await repo.performance.listAll()).toEqual([]);
  } finally {
    initBackgroundSchedulerResolver(() => trackBackground);
  }
});

test('non-chat ingress: usage-record failure does not turn upstream 2xx into 502', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerOpenAIEmbeddingsUpstream(repo);

  const record = vi.spyOn(repo.usage, 'record').mockRejectedValue(new Error('simulated SQL write failure'));
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
        await flushBackground();
        expect(record).toHaveBeenCalledOnce();
      },
    );
  } finally {
    errorSpy.mockRestore();
  }
});

test('non-chat ingress: non-JSON 2xx upstream body is forwarded verbatim with a request-only usage record', async () => {
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

        assertEquals(response.status, 200);
        assertEquals(response.headers.get('content-type'), 'application/octet-stream');
        const bytes = new Uint8Array(await response.arrayBuffer());
        assertEquals(Array.from(bytes), Array.from(binary));
        await flushAsyncWork();
      },
    );

    const usage = await repo.usage.listAll();
    assertEquals(usage.length, 1);
    assertEquals(usage[0].requests, 1);
    assertEquals(usage[0].metrics, []);
  } finally {
    warnSpy.mockRestore();
  }
});

// Register two custom upstreams both exposing the same embedding model, so
// the shared narrow phase produces a two-element candidate list ordered by
// `sortOrder`. The passthrough loop must try `up_a` first (sortOrder 100)
// and `up_b` second (sortOrder 200).
const registerTwoOpenAIEmbeddingsUpstreams = async (repo: Awaited<ReturnType<typeof setupAppTest>>['repo']): Promise<void> => {
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_a', name: 'Upstream A', sortOrder: 100,
    config: { baseUrl: 'https://up-a.example.com', apiKey: 'sk-a', endpoints: {}, ingressHeadersRules: [] },
  }));
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_b', name: 'Upstream B', sortOrder: 200,
    config: { baseUrl: 'https://up-b.example.com', apiKey: 'sk-b', endpoints: {}, ingressHeadersRules: [] },
  }));
};

test.each([
  {
    failure: 'HTTP rejection',
    firstResponse: () => new Response('upstream boom', { status: 503 }),
    billed: ['up_b'],
  },
  {
    failure: 'body transport failure after a 2xx',
    firstResponse: () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error('fixture upstream body disconnected')); },
    }), { headers: { 'content-type': 'application/json' } }),
    billed: ['up_a', 'up_b'],
  },
])('non-chat ingress: records both attempts after $failure on the first candidate', async ({ firstResponse, billed }) => {
  const { apiKey, repo } = await setupAppTest();
  await registerTwoOpenAIEmbeddingsUpstreams(repo);

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
        return firstResponse();
      }
      if (url.hostname === 'up-b.example.com' && url.pathname === '/v1/embeddings') {
        secondOpenAIEmbeddingsCalls += 1;
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
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
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
  const usage = (await repo.usage.listAll()).map(({ upstream, requests }) => ({ upstream, requests }));
  expect(usage).toHaveLength(billed.length);
  expect(usage).toEqual(expect.arrayContaining(billed.map(upstream => ({ upstream, requests: 1 }))));
  const performance = await repo.performance.listAll();
  expect(performance).toHaveLength(2);
  expect(performance).toEqual(expect.arrayContaining([
    expect.objectContaining({ upstream: 'up_a', requests: 1, errorsNoOutput: 1 }),
    expect.objectContaining({ upstream: 'up_b', requests: 1, errorsNoOutput: 0 }),
  ]));
});

test('non-chat ingress: when every candidate returns non-2xx the most recent upstream response is forwarded verbatim', async () => {
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

      // The last-attempted upstream's status, body, and allow-listed
      // headers pass through unchanged so clients see real upstream
      // telemetry — no synthetic gateway envelope.
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
] as const)('non-chat ingress: %s followed by %s preserves the selected response', async (first, second, status, retryAfter) => {
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
      if (behavior === 'disconnected') throw new TypeError('fixture connection refused');
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
        assertEquals(await response.text(), `limit from ${selected}`);
      } else {
        await response.text();
      }
      assertEquals(calls, first === 'disabled' ? ['up-b.example.com'] : ['up-a.example.com', 'up-b.example.com']);
      await flushAsyncWork();
    },
  );
});

test('non-chat ingress: HTTP and transport errors each record a failed call', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerTwoOpenAIEmbeddingsUpstreams(repo);

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
          throw new Error('simulated network error to up_b');
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
        await flushAsyncWork();
      },
    );

    const performance = await repo.performance.listAll();
    expect(performance).toHaveLength(2);
    expect(performance).toEqual(expect.arrayContaining([
      expect.objectContaining({ upstream: 'up_a', requests: 1, errorsNoOutput: 1 }),
      expect.objectContaining({ upstream: 'up_b', requests: 1, errorsNoOutput: 1 }),
    ]));
    expect(await repo.usage.listAll()).toEqual([]);
  } finally {
    errorSpy.mockRestore();
  }
});
