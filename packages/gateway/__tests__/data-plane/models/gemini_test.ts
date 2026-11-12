import { test } from 'vitest';

import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, copilotModels, requestAppWithWarmModels, setupAppTest } from '../../test-utils/app.ts';
import { clearInProcessCopilotTokenCache } from '@floway-dev/provider-copilot';
import { jsonResponse, withMockedFetch, assertEquals } from '@floway-dev/test-utils';

// The listing shape follows the client identity, not the path, so a Gemini
// suite addresses the Gemini shape the same way a real SDK does.
const GEMINI_HEADERS = (apiKey: string) => ({ 'x-api-key': apiKey, 'user-agent': 'google-genai-sdk/1.0.0 gl-node/cross' });

test('/v1beta/models lists Copilot LLM models in Gemini model shape', async () => {
  const { apiKey } = await setupAppTest();

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
        return jsonResponse({
          object: 'list',
          data: [
            {
              id: 'gpt-gemini-list',
              name: 'gpt-gemini-list',
              display_name: 'GPT Gemini List',
              version: '1',
              object: 'model',
              capabilities: {
                family: 'test',
                type: 'chat',
                limits: {
                  max_prompt_tokens: 12345,
                  max_output_tokens: 678,
                },
                supports: {},
              },
            },
            {
              id: 'embedding-only',
              name: 'embedding-only',
              version: '1',
              object: 'model',
              supported_endpoints: ['/embeddings'],
              capabilities: {
                family: 'test',
                type: 'embeddings',
                limits: {},
                supports: {},
              },
            },
          ],
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestAppWithWarmModels('/v1beta/models', {
        headers: GEMINI_HEADERS(apiKey.key),
      });

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.models, [
        {
          name: 'models/gpt-gemini-list',
          baseModelId: 'gpt-gemini-list',
          displayName: 'GPT Gemini List',
          supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'],
          inputTokenLimit: 12345,
          outputTokenLimit: 678,
          temperature: 1,
          topP: 0.95,
          topK: 40,
        },
      ]);
    },
  );
});

test('/v1beta/models/:modelId returns one Gemini model or Google RPC 404', async () => {
  const { apiKey } = await setupAppTest();

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
        return jsonResponse(copilotModels([{ id: 'gpt-gemini-get', supported_endpoints: ['/v1/messages'] }]));
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const found = await requestAppWithWarmModels('/v1beta/models/gpt-gemini-get', {
        headers: GEMINI_HEADERS(apiKey.key),
      });
      assertEquals(found.status, 200);
      const model = await found.json();
      assertEquals(model.name, 'models/gpt-gemini-get');
      assertEquals(model.supportedGenerationMethods, ['generateContent', 'streamGenerateContent', 'countTokens']);

      const missing = await requestAppWithWarmModels('/v1beta/models/missing-model', {
        headers: GEMINI_HEADERS(apiKey.key),
      });
      assertEquals(missing.status, 404);
      assertEquals(await missing.json(), {
        error: {
          code: 404,
          message: 'Model not found: missing-model',
          status: 'NOT_FOUND',
        },
      });
    },
  );
});

test('the model detail answer is identical under /v1 and /v1beta', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_detail_alias',
    name: 'Detail Alias',
    sortOrder: 100,
    config: {
      baseUrl: 'https://detail-alias.example.com',
      authStyle: 'bearer',
      ingressHeadersRules: [],
      apiKey: 'sk-detail-alias',
      endpoints: { openaiChatCompletions: {} },
    },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'detail-alias.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'detail-alias-model' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const bodies = [];
      for (const path of ['/v1/models/detail-alias-model', '/v1beta/models/detail-alias-model']) {
        const response = await requestAppWithWarmModels(path, { headers: GEMINI_HEADERS(apiKey.key) });
        assertEquals(response.status, 200);
        bodies.push(await response.json());
      }
      assertEquals(bodies[0], bodies[1]);
      assertEquals((bodies[0] as { name: string }).name, 'models/detail-alias-model');
    },
  );
});

test('/v1beta/models includes custom upstream LLM models', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();

  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_custom',
    name: 'Custom LLM',
    sortOrder: 100,
    createdAt: '2026-05-01T00:00:00.000Z',
    config: {
      baseUrl: 'https://custom.example.com',
      authStyle: 'bearer',
      ingressHeadersRules: [],
      apiKey: 'sk-custom',
      endpoints: { openaiChatCompletions: {} },
    },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({
          object: 'list',
          data: [{ id: 'custom-llm-model', name: 'Custom LLM Model' }],
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const listResp = await requestAppWithWarmModels('/v1beta/models', {
        headers: GEMINI_HEADERS(apiKey.key),
      });
      assertEquals(listResp.status, 200);
      const list = await listResp.json();
      assertEquals(list.models.length, 1);
      assertEquals(list.models[0].name, 'models/custom-llm-model');
      assertEquals(list.models[0].displayName, 'Custom LLM Model');
      assertEquals(list.models[0].supportedGenerationMethods, ['generateContent', 'streamGenerateContent', 'countTokens']);

      const getResp = await requestAppWithWarmModels('/v1beta/models/custom-llm-model', {
        headers: GEMINI_HEADERS(apiKey.key),
      });
      assertEquals(getResp.status, 200);
      const model = await getResp.json();
      assertEquals(model.name, 'models/custom-llm-model');
    },
  );
});

test('/v1beta/models excludes custom upstream embedding-only models', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();

  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_embed',
    name: 'Embedding Provider',
    sortOrder: 100,
    createdAt: '2026-05-01T00:00:00.000Z',
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
        return jsonResponse({
          object: 'list',
          data: [{ id: 'embed-only-model' }],
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const listResp = await requestAppWithWarmModels('/v1beta/models', {
        headers: GEMINI_HEADERS(apiKey.key),
      });
      assertEquals(listResp.status, 200);
      const list = await listResp.json();
      assertEquals(list.models.length, 0);
    },
  );
});

test('/v1beta/models hides upstream identity when a provider returns an invalid model list', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();

  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_secret_gemini_provider',
    name: 'Secret Gemini Provider',
    sortOrder: 100,
    createdAt: '2026-05-01T00:00:00.000Z',
    config: {
      baseUrl: 'https://gemini-secret.example.com',
      authStyle: 'bearer',
      ingressHeadersRules: [],
      apiKey: 'sk-secret',
      endpoints: { openaiChatCompletions: {} },
    },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'gemini-secret.example.com') {
        return jsonResponse({ object: 'list', data: null });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestAppWithWarmModels('/v1beta/models', {
        headers: GEMINI_HEADERS(apiKey.key),
      });
      assertEquals(response.status, 200);
      assertEquals(await response.json(), { models: [] });
    },
  );
});

test('/v1beta/models hides upstream HTTP error bodies', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();

  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_http_secret_gemini_provider',
    name: 'HTTP Secret Gemini Provider',
    sortOrder: 100,
    createdAt: '2026-05-01T00:00:00.000Z',
    config: {
      baseUrl: 'https://gemini-http-secret.example.com',
      authStyle: 'bearer',
      ingressHeadersRules: [],
      apiKey: 'sk-secret',
      endpoints: { openaiChatCompletions: {} },
    },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'gemini-http-secret.example.com') {
        return new Response('secret upstream body: up_http_secret_gemini', {
          status: 403,
          headers: { 'content-type': 'text/plain' },
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestAppWithWarmModels('/v1beta/models', {
        headers: GEMINI_HEADERS(apiKey.key),
      });
      assertEquals(response.status, 200);
      const body = JSON.stringify(await response.json());
      assertEquals(body, '{"models":[]}');
    },
  );
});

test('/v1beta/models hides thrown upstream request errors', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();

  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_throw_secret_gemini_provider',
    name: 'Throw Secret Gemini Provider',
    sortOrder: 100,
    createdAt: '2026-05-01T00:00:00.000Z',
    config: {
      baseUrl: 'https://gemini-throw-secret.example.com',
      authStyle: 'bearer',
      ingressHeadersRules: [],
      apiKey: 'sk-secret',
      endpoints: { openaiChatCompletions: {} },
    },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'gemini-throw-secret.example.com') {
        throw new Error('network failure contacting https://gemini-throw-secret.example.com/v1/models');
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestAppWithWarmModels('/v1beta/models', {
        headers: GEMINI_HEADERS(apiKey.key),
      });
      assertEquals(response.status, 200);
      const body = JSON.stringify(await response.json());
      assertEquals(body.includes('gemini-throw-secret.example.com'), false);
    },
  );
});

test('/v1beta/models hides malformed upstream response bodies', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();

  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_malformed_secret_gemini_provider',
    name: 'Malformed Secret Gemini Provider',
    sortOrder: 100,
    createdAt: '2026-05-01T00:00:00.000Z',
    config: {
      baseUrl: 'https://gemini-malformed-secret.example.com',
      authStyle: 'bearer',
      ingressHeadersRules: [],
      apiKey: 'sk-secret',
      endpoints: { openaiChatCompletions: {} },
    },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'gemini-malformed-secret.example.com') {
        return new Response('secret malformed body: up_malformed_secret_gemini', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestAppWithWarmModels('/v1beta/models', {
        headers: GEMINI_HEADERS(apiKey.key),
      });
      assertEquals(response.status, 200);
      const body = JSON.stringify(await response.json());
      assertEquals(body.includes('secret malformed body'), false);
      assertEquals(body.includes('up_malformed_secret_gemini'), false);
    },
  );
});

test('/v1beta/models emits visible aliases as models/<alias-name> entries with displayName and baseModelId', async () => {
  // Aliases must surface on the Gemini listing surface alongside real ids,
  // so Gemini-native clients (google-genai SDK) can address them the same
  // way OpenAI clients hit them on /v1/models.
  const { apiKey, repo } = await setupAppTest();
  await repo.modelAliases.deleteAll();
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();

  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_gemini_alias',
    name: 'Alias Provider for Gemini Listing',
    sortOrder: 100,
    createdAt: '2026-05-01T00:00:00.000Z',
    config: {
      baseUrl: 'https://custom-alias.example.com',
      authStyle: 'bearer',
      ingressHeadersRules: [],
      apiKey: 'sk-custom',
      endpoints: { openaiChatCompletions: {} },
    },
  }));
  await repo.modelAliases.insert({
    id: 'alias_gpt-fast',
    name: 'gpt-fast',
    kind: 'chat',
    selection: 'first-available',
    displayName: 'Operator Fast Alias',
    visibleInModelsList: true,
    targets: [{ target_model_id: 'custom-llm-target', rules: {} }],
    announcedMetadata: null,
    sortOrder: 0,
    createdAt: '2026-06-26T00:00:00.000Z',
    updatedAt: '2026-06-26T00:00:00.000Z',
  });

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'custom-alias.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'custom-llm-target' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestAppWithWarmModels('/v1beta/models', {
        headers: GEMINI_HEADERS(apiKey.key),
      });
      assertEquals(response.status, 200);
      const body = (await response.json()) as { models: Array<{ name: string; displayName?: string; baseModelId?: string }> };
      const aliasEntry = body.models.find(model => model.name === 'models/gpt-fast');
      if (!aliasEntry) throw new Error(`missing alias entry; got ${JSON.stringify(body.models.map(m => m.name))}`);
      assertEquals(aliasEntry.displayName, 'Operator Fast Alias');
      assertEquals(aliasEntry.baseModelId, 'gpt-fast');
    },
  );
});

test('the model listing selects the Gemini shape from the client identity on either prefix', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_identity',
    name: 'Identity Provider',
    sortOrder: 100,
    config: {
      baseUrl: 'https://identity.example.com',
      authStyle: 'bearer',
      ingressHeadersRules: [],
      apiKey: 'sk-identity',
      endpoints: { openaiChatCompletions: {} },
    },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'identity.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'identity-model' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      for (const path of ['/v1/models', '/v1beta/models']) {
        const gemini = await requestAppWithWarmModels(path, { headers: GEMINI_HEADERS(apiKey.key) });
        assertEquals(gemini.status, 200);
        assertEquals(((await gemini.json()) as { models: Array<{ name: string }> }).models.map(model => model.name), ['models/identity-model']);

        // The same paths serve the OpenAI/Anthropic superset to every other
        // caller, so the path alone never implies a Gemini body.
        const generic = await requestAppWithWarmModels(path, { headers: { 'x-api-key': apiKey.key } });
        assertEquals(generic.status, 200);
        assertEquals(((await generic.json()) as { data: Array<{ id: string }> }).data.map(model => model.id), ['identity-model']);
      }
    },
  );
});

test('Gemini clients are recognized through x-goog-api-client and the legacy SDK labels', async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch(
    request => {
      if (new URL(request.url).hostname === 'api.individual.githubcopilot.com') return jsonResponse(copilotModels([]));
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const identities: ReadonlyArray<Record<string, string>> = [
        { 'x-goog-api-client': 'google-genai-sdk/1.0.0 gl-python/3.13.0' },
        { 'user-agent': 'GeminiCLI/0.12.0/gemini-2.5-pro (darwin; arm64; shell)', 'x-goog-api-client': 'google-genai-sdk/1.3.0 gl-node/cross' },
        { 'user-agent': 'genai-py/0.8.5 gl-python/3.12.0' },
        { 'x-goog-api-client': 'genai-js/0.24.1' },
      ];
      for (const identity of identities) {
        const response = await requestAppWithWarmModels('/v1/models', { headers: { 'x-api-key': apiKey.key, ...identity } });
        assertEquals(response.status, 200);
        const body = await response.json() as { models?: unknown; data?: unknown };
        assertEquals(Array.isArray(body.models), true);
        assertEquals(body.data, undefined);
      }
    },
  );
});
