// Behavioral coverage for the shared passthrough serve scaffold used by
// /v1/embeddings and /v1/images/{generations,edits}. Each test exercises a
// full client request through the in-memory app rather than constructing a
// synthetic hono Context so the integration with model resolution,
// upstream HTTP, and background scheduling stays honest.
//
// We pick /v1/embeddings as the source under test because:
//   - its acceptBinding gate is `kind === 'embedding'`, satisfied by any
//     embedding-only custom upstream, with no per-endpoint Copilot setup
//     required;
//   - its extractBilling reads the OpenAI-style `usage.prompt_tokens` off
//     a 2xx JSON body, so a body with that shape triggers a real usage
//     write;
//   - it shares the exact same forwardUpstreamResponse + settle
//     path as the images endpoints — the behaviors under test are owned by
//     passthroughServe, not the endpoint shape.

import { test, vi } from 'vitest';

import { buildCustomUpstreamRecord, flushAsyncWork, requestApp, setupAppTest } from '../../test-helpers.ts';
import { clearInProcessCopilotTokenCache } from '@floway-dev/provider-copilot';
import { jsonResponse, withMockedFetch, assertEquals, assertExists } from '@floway-dev/test-utils';

const registerEmbeddingsUpstream = async (repo: Awaited<ReturnType<typeof setupAppTest>>['repo']): Promise<void> => {
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_passthrough',
    name: 'Passthrough Embedding Provider',
    sortOrder: 100,
    config: {
      baseUrl: 'https://passthrough.example.com',
      authStyle: 'bearer',
      apiKey: 'sk-passthrough',
      endpoints: {},
    },
  }));
};

test('passthrough-serve: usage-record failure does not turn upstream 2xx into 502', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerEmbeddingsUpstream(repo);

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
        const response = await requestApp('/v1/embeddings', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
          body: JSON.stringify({ model: 'custom-embed-model', input: 'hi' }),
        });

        assertEquals(response.status, 200);
        const body = await response.json() as { data: Array<{ embedding: number[] }> };
        assertEquals(body.data[0].embedding, [0.5]);
        await flushAsyncWork();
      },
    );

    assertEquals(errorSpy.mock.calls.some(call => call[0] === 'Failed to record usage:'), true);
  } finally {
    errorSpy.mockRestore();
  }
});

test('passthrough-serve: non-JSON 2xx upstream body is forwarded verbatim with a request-only usage record', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerEmbeddingsUpstream(repo);

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
        const response = await requestApp('/v1/embeddings', {
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
    // The parse failure is observable through console.warn so operators can
    // correlate missing usage rows against upstream body shape regressions.
    assertEquals(warnSpy.mock.calls.some(call => typeof call[0] === 'string' && call[0].includes('passthrough-serve: failed to parse 2xx upstream body for /embeddings')), true);
  } finally {
    warnSpy.mockRestore();
  }
});

test('passthrough-serve: response header allow-list forwards expected headers and drops the rest', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerEmbeddingsUpstream(repo);

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'passthrough.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'custom-embed-model' }] });
      }
      if (url.hostname === 'passthrough.example.com' && url.pathname === '/v1/embeddings') {
        return new Response(JSON.stringify({
          object: 'list',
          model: 'custom-embed-model',
          data: [{ object: 'embedding', index: 0, embedding: [0.1] }],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-request-id': 'req-123',
            'openai-organization': 'org-1',
            'x-ratelimit-remaining': '100',
            'retry-after': '30',
            'cf-ray': 'abc',
            'x-internal-secret': 'leak',
            'set-cookie': 'nope=1',
          },
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/embeddings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({ model: 'custom-embed-model', input: 'hi' }),
      });

      assertEquals(response.status, 200);
      assertExists(response.headers.get('x-request-id'));
      assertEquals(response.headers.get('x-request-id'), 'req-123');
      assertEquals(response.headers.get('openai-organization'), 'org-1');
      assertEquals(response.headers.get('x-ratelimit-remaining'), '100');
      assertEquals(response.headers.get('retry-after'), '30');
      assertEquals(response.headers.get('cf-ray'), 'abc');
      assertEquals(response.headers.get('x-internal-secret'), null);
      assertEquals(response.headers.get('set-cookie'), null);
      await response.json();
    },
  );
});

test('passthrough-serve: alias whose targets have no kind-matching binding surfaces as the regular model-missing 404', async () => {
  // The inlined alias resolver walks alias targets in `selection` order and
  // stops at the first target with kind-matching candidates. When every
  // target is unroutable (as here, where the single target id doesn't
  // exist in any upstream catalog), the resolver returns empty candidates
  // + sawModel=false, and the passthrough seam surfaces the regular
  // model-missing 404. No upstream call should fire.
  const { apiKey, repo } = await setupAppTest();
  await registerEmbeddingsUpstream(repo);
  await repo.modelAliases.insert({
    name: 'embed-fast',
    kind: 'embedding',
    selection: 'first-available',
    displayName: null,
    visibleInModelsList: true,
    targets: [{ target_model_id: 'unknown-embed', rules: {} }],
    announcedMetadata: null,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'passthrough.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'custom-embed-model' }] });
      }
      if (url.hostname === 'passthrough.example.com' && url.pathname === '/v1/embeddings') {
        throw new Error('passthrough-serve: upstream must not be called when alias has no routable target');
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/embeddings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({ model: 'embed-fast', input: 'hi' }),
      });

      assertEquals(response.status, 404);
      const body = await response.json() as { error: { message: string; type: string } };
      assertEquals(body.error.type, 'api_error');
      // The alias name (still on `payload.model` because no candidate was
      // rewritten in) reaches the wording verbatim.
      assertEquals(body.error.message, 'Model embed-fast is not available on any configured upstream.');
    },
  );
});

// Register two custom upstreams both exposing the same embedding model, so
// the shared narrow phase produces a two-element candidate list ordered by
// `sortOrder`. The passthrough loop must try `up_a` first (sortOrder 100)
// and `up_b` second (sortOrder 200).
const registerTwoEmbeddingsUpstreams = async (repo: Awaited<ReturnType<typeof setupAppTest>>['repo']): Promise<void> => {
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_a', name: 'Upstream A', sortOrder: 100,
    config: { baseUrl: 'https://up-a.example.com', authStyle: 'bearer', apiKey: 'sk-a', endpoints: {} },
  }));
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_b', name: 'Upstream B', sortOrder: 200,
    config: { baseUrl: 'https://up-b.example.com', authStyle: 'bearer', apiKey: 'sk-b', endpoints: {} },
  }));
};

test('passthrough-serve: 5xx from the first candidate falls through to the next successful upstream', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerTwoEmbeddingsUpstreams(repo);

  let firstEmbeddingsCalls = 0;
  let secondEmbeddingsCalls = 0;
  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.pathname === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'custom-embed-model' }] });
      }
      if (url.hostname === 'up-a.example.com' && url.pathname === '/v1/embeddings') {
        firstEmbeddingsCalls += 1;
        return new Response('upstream boom', { status: 503 });
      }
      if (url.hostname === 'up-b.example.com' && url.pathname === '/v1/embeddings') {
        secondEmbeddingsCalls += 1;
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
      const response = await requestApp('/v1/embeddings', {
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

  assertEquals(firstEmbeddingsCalls, 1);
  assertEquals(secondEmbeddingsCalls, 1);
});

test('passthrough-serve: when every candidate returns non-2xx the most recent upstream response is forwarded verbatim', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerTwoEmbeddingsUpstreams(repo);

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
      const response = await requestApp('/v1/embeddings', {
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

// A throw during candidate rollover attributes the error row to the
// throwing candidate, not the previously-succeeded one.
test('passthrough-serve: throw during rollover attributes the error perf row to the throwing candidate, not the previous one', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerTwoEmbeddingsUpstreams(repo);

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
        const response = await requestApp('/v1/embeddings', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
          body: JSON.stringify({ model: 'custom-embed-model', input: 'hi' }),
        });

        assertEquals(response.status, 502);
        await flushAsyncWork();
      },
    );

    const perfRows = await repo.performance.listAll();
    const errorRows = perfRows.filter(row => row.errorsNoOutput + row.errorsWithOutput > 0);
    assertEquals(errorRows.length, 1);
    assertEquals(errorRows[0].upstream, 'up_b');
  } finally {
    errorSpy.mockRestore();
  }
});
