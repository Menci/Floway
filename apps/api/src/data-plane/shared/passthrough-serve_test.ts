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
//   - its extractUsage reads OpenAI-style `usage.prompt_tokens`, so a
//     2xx JSON body with that shape triggers a real usage write;
//   - it shares the exact same proxyUpstreamResponse + scheduleUsageRecord
//     path as the images endpoints — the behaviors under test are owned by
//     passthroughServe, not the endpoint shape.

import { test, vi } from 'vitest';

import { clearCopilotTokenCache } from '../../shared/copilot.ts';
import { assertEquals, assertExists } from '../../test-assert.ts';
import { buildCustomUpstreamRecord, flushAsyncWork, jsonResponse, requestApp, setupAppTest, withMockedFetch } from '../../test-helpers.ts';
import { clearModelsStore } from '../providers/models-store.ts';

const registerEmbeddingsUpstream = async (repo: Awaited<ReturnType<typeof setupAppTest>>['repo']): Promise<void> => {
  await repo.upstreams.deleteAll();
  clearModelsStore();
  await clearCopilotTokenCache();
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_passthrough',
    name: 'Passthrough Embedding Provider',
    sortOrder: 100,
    config: {
      baseUrl: 'https://passthrough.example.com',
      bearerToken: 'sk-passthrough',
      supportedEndpoints: [],
    },
  }));
};

test('passthrough-serve: usage-record failure does not turn upstream 2xx into 502', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerEmbeddingsUpstream(repo);

  // Replace the usage repo's record method with a rejection so the
  // scheduled usage write fails. The 200 from upstream must still reach
  // the client unchanged; the failure is observable via console.error.
  repo.usage.record = () => Promise.reject(new Error('simulated D1 write failure'));
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

    // The scheduled write rejected, was caught, and logged. The exact
    // first argument matches scheduleUsageRecord's wording.
    assertEquals(errorSpy.mock.calls.some(call => call[0] === 'Failed to record token usage:'), true);
  } finally {
    errorSpy.mockRestore();
  }
});

test('passthrough-serve: non-JSON 2xx upstream body is forwarded verbatim with no usage record', async () => {
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

    // safeJsonClone returned undefined for the binary body, so extractUsage
    // was never called and no usage row was recorded.
    const usage = await repo.usage.listAll();
    assertEquals(usage.length, 0);
    // The parse failure is observable through console.warn so operators can
    // correlate missing usage rows against upstream body shape regressions.
    assertEquals(warnSpy.mock.calls.some(call => typeof call[0] === 'string' && call[0].includes('passthrough-serve: failed to parse 2xx upstream body for embeddings')), true);
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
      // Out-of-allow-list headers are stripped.
      assertEquals(response.headers.get('x-internal-secret'), null);
      assertEquals(response.headers.get('set-cookie'), null);
      await response.json();
    },
  );
});
