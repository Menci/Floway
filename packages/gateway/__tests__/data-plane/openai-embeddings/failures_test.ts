// What a run does when something other than the answer goes wrong. Each of these was a
// behaviour of the passthrough serve that /v1/embeddings used to run through, and each is
// kept here against the pipeline that replaced it — two unchanged, one deliberately not.

import { test, vi } from 'vitest';

import { buildCustomUpstreamRecord, flushAsyncWork, requestApp, setupAppTest } from '../../test-utils/app.ts';
import { clearInProcessCopilotTokenCache } from '@floway-dev/provider-copilot';
import { jsonResponse, withMockedFetch, assertEquals } from '@floway-dev/test-utils';

const registerOpenAIEmbeddingsUpstream = async (
  repo: Awaited<ReturnType<typeof setupAppTest>>['repo'],
): Promise<void> => {
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_embeddings',
    name: 'Embedding Provider',
    sortOrder: 100,
    config: {
      baseUrl: 'https://embeddings.example.com',
      authStyle: 'bearer',
      ingressHeadersRules: [],
      apiKey: 'sk-embeddings',
      endpoints: {},
    },
  }));
};

const upstreamModels = () => jsonResponse({ object: 'list', data: [{ id: 'custom-embed-model' }] });

const askForOpenAIEmbeddings = async (key: string): Promise<Response> => await requestApp('/v1/embeddings', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': key },
  body: JSON.stringify({ model: 'custom-embed-model', input: 'hi' }),
});

// The answer does not depend on the row. Settlement hands the write to the background rather
// than awaiting it, so a repository that rejects cannot turn an upstream's 2xx into a 502 —
// and the failure is still reported, because a write nobody hears about is one nobody fixes.
test('a usage write that fails leaves the answer alone and still reports', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerOpenAIEmbeddingsUpstream(repo);

  repo.usage.record = () => Promise.reject(new Error('simulated SQL write failure'));
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  try {
    await withMockedFetch(
      request => {
        const url = new URL(request.url);
        if (url.pathname === '/v1/models') return upstreamModels();
        if (url.pathname === '/v1/embeddings') {
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
        const response = await askForOpenAIEmbeddings(apiKey.key);

        assertEquals(response.status, 200);
        const body = await response.json() as { data: { embedding: number[] }[] };
        assertEquals(body.data[0].embedding, [0.5]);
        await flushAsyncWork();
      },
    );

    assertEquals(errorSpy.mock.calls.some(call => String(call[0]).includes('usage')), true);
  } finally {
    errorSpy.mockRestore();
  }
});

// The replaced surface forwarded such a body verbatim with the upstream's 200. A protocol
// that requires JSON and did not get JSON has no answer to serve, so the gateway says so
// itself — it cannot claim to have served a request whose answer it never read.
test('a 2xx body the OpenAI Embeddings protocol cannot read is refused rather than forwarded', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerOpenAIEmbeddingsUpstream(repo);

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.pathname === '/v1/models') return upstreamModels();
      if (url.pathname === '/v1/embeddings') {
        return new Response(new Uint8Array([0xde, 0xad, 0xbe, 0xef]), {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await askForOpenAIEmbeddings(apiKey.key);

      assertEquals(response.status, 502);
      assertEquals(response.headers.get('content-type'), 'application/json');
      const body = await response.json() as { error: { message: string } };
      assertEquals(body.error.message.includes('the OpenAI Embeddings protocol cannot read'), true);
      await flushAsyncWork();
    },
  );

  // An upstream that was called and reported nothing still counts as called: the row names
  // the request, and a reading we could not parse is, from here, no reading rather than zero.
  const usage = await repo.usage.listAll();
  assertEquals(usage.length, 1);
  assertEquals(usage[0].requests, 1);
  assertEquals(usage[0].metrics, []);
});

// The last failure is the one the client is answered with, and an upstream that refused in
// its own words is answered in them — with the status and the headers that carry what a
// client does next.
test('when every candidate refuses the client gets the last upstream-s own refusal', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();
  for (const [id, host, order] of [['up_a', 'up-a.example.com', 100], ['up_b', 'up-b.example.com', 200]] as const) {
    await repo.upstreams.save(buildCustomUpstreamRecord({
      id, name: id, sortOrder: order,
      config: { baseUrl: `https://${host}`, authStyle: 'bearer', ingressHeadersRules: [], apiKey: 'sk-x', endpoints: {} },
    }));
  }

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.pathname === '/v1/models') return upstreamModels();
      if (url.hostname === 'up-a.example.com') return new Response('first upstream unavailable', { status: 503 });
      if (url.hostname === 'up-b.example.com') {
        return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
          status: 429, headers: { 'content-type': 'application/json', 'retry-after': '17' },
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await askForOpenAIEmbeddings(apiKey.key);

      assertEquals(response.status, 429);
      assertEquals(response.headers.get('retry-after'), '17');
      assertEquals(await response.json(), { error: { message: 'rate limited' } });
      await flushAsyncWork();
    },
  );
});
