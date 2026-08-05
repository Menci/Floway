import { test } from 'vitest';

import { tokenCountsFromUsage } from '../../../src/repo/usage-metrics.ts';
import { buildCustomUpstreamRecord, copilotModels, flushAsyncWork, requestApp, setupAppTest } from '../../test-utils/app.ts';
import { clearInProcessCopilotTokenCache } from '@floway-dev/provider-copilot';
import { jsonResponse, withMockedFetch, assertEquals, assertExists } from '@floway-dev/test-utils';

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>(res => {
    resolve = res;
  });
  return { promise, resolve };
};

test('/v1/embeddings wraps scalar string input for Copilot upstream', async () => {
  const { apiKey } = await setupAppTest();
  let forwardedBody:
    | {
      model?: unknown;
      input?: unknown;
      encoding_format?: unknown;
    }
    | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'text-embedding-real', supported_endpoints: ['/embeddings'] }]));
      }
      if (url.pathname === '/embeddings') {
        forwardedBody = (await request.json()) as Record<string, unknown>;
        return jsonResponse({
          object: 'list',
          model: 'text-embedding-real',
          data: [{ object: 'embedding', index: 0, embedding: [0.1] }],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/embeddings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'text-embedding-real',
          input: 'hello',
          encoding_format: 'float',
        }),
      });

      assertEquals(response.status, 200);
      await response.json();
    },
  );

  assertExists(forwardedBody);
  assertEquals(forwardedBody.model, 'text-embedding-real');
  assertEquals(forwardedBody.input, ['hello']);
  assertEquals(forwardedBody.encoding_format, 'float');
});

test('/v1/embeddings records usage under request model when upstream omits model', async () => {
  const { apiKey, repo } = await setupAppTest();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'text-embedding-real', supported_endpoints: ['/embeddings'] }]));
      }
      if (url.pathname === '/embeddings') {
        return jsonResponse({
          data: [{ object: 'embedding', index: 0, embedding: [0.1] }],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/embeddings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'text-embedding-real',
          input: 'hello',
          encoding_format: 'float',
        }),
      });

      assertEquals(response.status, 200);
      await response.json();
    },
  );

  await flushAsyncWork();

  const usage = await repo.usage.listAll();
  assertEquals(usage.length, 1);
  assertEquals(usage[0].model, 'text-embedding-real');
  assertEquals(tokenCountsFromUsage(usage[0]), { input: 1 });

  const performanceRows = await repo.performance.listAll();
  assertEquals(performanceRows.length, 1);
  assertEquals(performanceRows[0]?.model, 'text-embedding-real');
  assertEquals(performanceRows[0]?.requests, 1);
  assertEquals(performanceRows[0]?.errorsNoOutput, 0);
  assertEquals(performanceRows[0]?.errorsWithOutput, 0);
});

test('/v1/embeddings streams JSON before EOF and settles usage after completion', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_embed_stream',
    name: 'Streaming Embedding Provider',
    config: {
      baseUrl: 'https://embed-stream.example.com',
      authStyle: 'bearer',
      ingressHeadersRules: [],
      apiKey: 'sk-embed-stream',
      endpoints: {},
      modelsFetch: { enabled: false },
      models: [{
        upstreamModelId: 'embed-stream-upstream',
        publicModelId: 'embed-stream',
        kind: 'embedding',
        endpoints: { embeddings: {} },
      }],
    },
  }));
  const eofGate = deferred();
  const eofPullStarted = deferred();
  const encoder = new TextEncoder();

  await withMockedFetch(
    () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"data":['));
      },
      async pull(controller) {
        eofPullStarted.resolve();
        await eofGate.promise;
        controller.enqueue(encoder.encode('],"usage":{"prompt_tokens":5,"total_tokens":5}}'));
        controller.close();
      },
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json' } }),
    async () => {
      const response = await requestApp('/v1/embeddings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({ model: 'embed-stream', input: 'hello' }),
      });
      const reader = response.body!.getReader();
      try {
        const first = await reader.read();
        assertEquals(new TextDecoder().decode(first.value), '{"data":[');
        const second = reader.read();
        await eofPullStarted.promise;
        assertEquals(await repo.usage.listAll(), []);
        eofGate.resolve();
        await second;
        while (!(await reader.read()).done) { /* drain */ }
      } finally {
        eofGate.resolve();
        await reader.cancel().catch(() => {});
      }
    },
  );

  await flushAsyncWork();
  const [usage] = await repo.usage.listAll();
  assertEquals(tokenCountsFromUsage(usage), { input: 5 });
});

test('/v1/embeddings preserves a success with malformed usage as a request-only row', async () => {
  const { apiKey, repo } = await setupAppTest();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'text-embedding-real', supported_endpoints: ['/embeddings'] }]));
      }
      if (url.pathname === '/embeddings') {
        return jsonResponse({
          data: [{ object: 'embedding', index: 0, embedding: [0.1] }],
          usage: { prompt_tokens: 2, total_tokens: 3 },
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/embeddings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({ model: 'text-embedding-real', input: 'hello' }),
      });

      assertEquals(response.status, 200);
      await response.json();
    },
  );

  await flushAsyncWork();

  const usage = await repo.usage.listAll();
  assertEquals(usage.length, 1);
  assertEquals(usage[0]?.requests, 1);
  assertEquals(tokenCountsFromUsage(usage[0]!), {});
});

test('/v1/embeddings aborts a pending upstream request when the inbound request is canceled', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_embed',
    name: 'Embedding Provider',
    enabled: true,
    sortOrder: 100,
    createdAt: '2026-05-01T00:00:00.000Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    config: {
      baseUrl: 'https://embed.example.com',
      authStyle: 'bearer',
      ingressHeadersRules: [],
      apiKey: 'sk-embed',
      endpoints: { embeddings: {} },
    },
  }));

  const upstreamStarted = deferred();
  const upstreamAborted = deferred();
  let upstreamSignal: AbortSignal | undefined;

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.pathname === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'custom-embed-model', kind: 'embedding' }] });
      }
      if (url.pathname === '/v1/embeddings') {
        upstreamSignal = request.signal;
        upstreamStarted.resolve();
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => {
            upstreamAborted.resolve();
            reject(request.signal.reason);
          }, { once: true });
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const controller = new AbortController();
      const response = requestApp('/v1/embeddings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({ model: 'custom-embed-model', input: 'hello' }),
        signal: controller.signal,
      });

      await upstreamStarted.promise;
      assertExists(upstreamSignal);
      assertEquals(upstreamSignal.aborted, false);
      controller.abort(new Error('client disconnected'));
      await upstreamAborted.promise;
      assertEquals(upstreamSignal.aborted, true);
      assertEquals((await response).status, 502);
    },
  );
});

test('/v1/embeddings records request and upstream performance', async () => {
  const { apiKey, copilotUpstream, repo } = await setupAppTest();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'text-embedding-real', supported_endpoints: ['/embeddings'] }]));
      }
      if (url.pathname === '/embeddings') {
        return jsonResponse({
          data: [{ object: 'embedding', index: 0, embedding: [0.1] }],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/embeddings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'text-embedding-real',
          input: 'hello',
        }),
      });

      assertEquals(response.status, 200);
      await response.json();
    },
  );

  await flushAsyncWork();

  const records = await repo.performance.listAll();
  assertEquals(records.length, 1);
  assertEquals(records[0]?.keyId, apiKey.id);
  assertEquals(records[0]?.model, 'text-embedding-real');
  assertEquals(records[0]?.upstream, copilotUpstream.id);
  assertEquals(records[0]?.requests, 1);
  assertEquals(records[0]?.errorsNoOutput, 0);
});

test('/v1/embeddings routes to custom upstream when model is only declared there', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();

  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_embed',
    name: 'Embedding Provider',
    enabled: true,
    sortOrder: 100,
    createdAt: '2026-05-01T00:00:00.000Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    config: {
      baseUrl: 'https://embed.example.com',
      authStyle: 'bearer',
      ingressHeadersRules: [],
      apiKey: 'sk-embed',
      endpoints: {},
    },
  }));

  let forwardedUrl: string | undefined;
  let forwardedBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

      if (url.hostname === 'embed.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({
          object: 'list',
          data: [{ id: 'custom-embed-model' }],
        });
      }
      if (url.hostname === 'embed.example.com' && url.pathname === '/v1/embeddings') {
        forwardedUrl = request.url;
        forwardedBody = (await request.json()) as Record<string, unknown>;
        return jsonResponse({
          object: 'list',
          model: 'custom-embed-model',
          data: [{ object: 'embedding', index: 0, embedding: [0.42] }],
          usage: { prompt_tokens: 2, total_tokens: 2 },
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/embeddings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'custom-embed-model',
          input: 'hello world',
        }),
      });

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.data[0].embedding, [0.42]);
    },
  );

  assertExists(forwardedUrl);
  assertEquals(new URL(forwardedUrl).hostname, 'embed.example.com');
  assertExists(forwardedBody);
  assertEquals(forwardedBody.model, 'custom-embed-model');
  assertEquals(forwardedBody.input, 'hello world');
});

test('/v1/embeddings rejects model on custom upstream without /embeddings capability', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();

  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_chat_only',
    name: 'Chat Only Provider',
    enabled: true,
    sortOrder: 100,
    createdAt: '2026-05-01T00:00:00.000Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    config: {
      baseUrl: 'https://chat.example.com',
      authStyle: 'bearer',
      ingressHeadersRules: [],
      apiKey: 'sk-chat',
      endpoints: { chatCompletions: {} },
    },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'chat.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({
          object: 'list',
          data: [{ id: 'chat-model' }],
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/embeddings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'chat-model',
          input: 'hello',
        }),
      });

      assertEquals(response.status, 400);
      const body = await response.json();
      assertEquals(body.error.message, 'Model chat-model does not support the /embeddings endpoint.');
    },
  );
});

// A custom upstream whose `/v1/models` fetch rejects is treated as
// temporarily empty: the request resolves to 404 model-missing with the
// failing upstream's display name appended parenthetically, instead of
// the gateway forwarding the upstream's raw HTTP status to the client.
test('/v1/embeddings reports the failed upstream parenthetically when /v1/models rejects', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();

  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_embed',
    name: 'Embedding Provider',
    enabled: true,
    sortOrder: 100,
    createdAt: '2026-05-01T00:00:00.000Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    config: {
      baseUrl: 'https://embed.example.com',
      authStyle: 'bearer',
      ingressHeadersRules: [],
      apiKey: 'sk-embed',
      endpoints: {},
    },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'embed.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ error: { message: 'bad embed key' } }, 403);
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/embeddings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'custom-embed-model',
          input: 'hello',
        }),
      });

      assertEquals(response.status, 404);
      assertEquals(await response.json(), {
        error: {
          message: 'Model custom-embed-model is not available on any configured upstream (models from upstream(s) "Embedding Provider" failed to load).',
          type: 'api_error',
        },
      });
    },
  );
});

// Even when a second upstream's catalog loads successfully (and so its
// models are routable), the rejected upstream's name still surfaces in
// the model-missing body so the operator can tell the failure apart
// from a genuine "no upstream has this model" miss.
test('/v1/embeddings reports the failed upstream even when a sibling upstream\'s catalog loads', async () => {
  const { apiKey, repo } = await setupAppTest();
  clearInProcessCopilotTokenCache();

  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_embed',
    name: 'Embedding Provider',
    enabled: true,
    sortOrder: 100,
    createdAt: '2026-05-01T00:00:00.000Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    config: {
      baseUrl: 'https://embed.example.com',
      authStyle: 'bearer',
      ingressHeadersRules: [],
      apiKey: 'sk-embed',
      endpoints: {},
    },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        });
      }
      if (url.hostname === 'api.individual.githubcopilot.com' && url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'copilot-chat', supported_endpoints: ['/chat/completions'] }]));
      }
      if (url.hostname === 'embed.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ error: { message: 'bad embed key' } }, 403);
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/embeddings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          model: 'custom-embed-model',
          input: 'hello',
        }),
      });

      assertEquals(response.status, 404);
      const body = await response.json();
      assertEquals(body.error.message, 'Model custom-embed-model is not available on any configured upstream (models from upstream(s) "Embedding Provider" failed to load).');
    },
  );
});

test('/v1/embeddings rejects malformed body at the provider-independent boundary', async () => {
  const { apiKey } = await setupAppTest();
  let dispatched = false;

  await withMockedFetch(
    request => {
      dispatched = true;
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/embeddings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: 'not valid json',
      });

      assertEquals(response.status, 400);
      const body = await response.json();
      assertEquals(body.error.type, 'api_error');
    },
  );

  assertEquals(dispatched, false);
});
