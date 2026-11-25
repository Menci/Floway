import { test } from 'vitest';

import type { OmpModel } from '../../../src/data-plane/models/omp-catalog.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, copilotModels, requestAppWithWarmModels, setupAppTest } from '../../test-utils/app.ts';
import type { ModelKind } from '@floway-dev/protocols/common';
import { jsonResponse, withMockedFetch, assertEquals } from '@floway-dev/test-utils';

test('/v1/models returns merged model list from Copilot and custom upstreams', async () => {
  const { repo, apiKey } = await setupAppTest();

  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_oai',
    name: 'Test OpenAI',
    sortOrder: 100,
    config: {
      baseUrl: 'https://oai.example.com',
      ingressHeadersRules: [],
      apiKey: 'sk-test',
      endpoints: { openaiChatCompletions: {} },
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
      if (url.pathname === '/models' && url.hostname === 'api.individual.githubcopilot.com') {
        return jsonResponse(
          copilotModels([
            {
              id: 'claude-sonnet-4',
              display_name: 'Claude Sonnet 4',
              supported_endpoints: ['/v1/messages'],
            },
          ]),
        );
      }
      if (url.pathname === '/v1/models' && url.hostname === 'oai.example.com') {
        return jsonResponse({
          object: 'list',
          data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }],
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestAppWithWarmModels('/v1/models', {
        headers: { 'x-api-key': apiKey.key },
      });

      assertEquals(response.status, 200);
      const body = (await response.json()) as {
        object: string;
        data: Array<{
          id: string;
          object?: string;
          type?: string;
          display_name?: string;
          kind?: ModelKind;
          limits?: Record<string, number>;
          providerModels?: unknown;
        }>;
      };
      assertEquals(body.object, 'list');

      const ids = body.data.map(m => m.id);
      assertEquals(ids.includes('claude-sonnet-4'), true);
      assertEquals(ids.includes('gpt-4o'), true);
      assertEquals(ids.includes('gpt-4o-mini'), true);

      const claude = body.data.find(m => m.id === 'claude-sonnet-4')!;
      // Superset DTO: OpenAI's object + Anthropic's type + Anthropic's display_name
      // + our extras. Only `PublicModel` fields reach the wire.
      assertEquals(claude.object, 'model');
      assertEquals(claude.type, 'model');
      assertEquals(claude.display_name, 'Claude Sonnet 4');
      assertEquals(claude.kind, 'chat');
      assertEquals(claude.limits, {});
      // The catalog row carries every upstream's ProviderModel; the public
      // surface must not leak that per-upstream identity.
      assertEquals(body.data.some(model => model.providerModels !== undefined), false);

      const anthropicResponse = await requestAppWithWarmModels('/models', {
        headers: { 'x-api-key': apiKey.key },
      });
      assertEquals(anthropicResponse.status, 200);
      assertEquals(await anthropicResponse.json(), body);
    },
  );
});

test('/v1/models secret-free listing survives a failing upstream catalog', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_http_secret_provider',
    name: 'HTTP Secret Provider',
    sortOrder: 100,
    config: {
      baseUrl: 'https://http-secret.example.com',
      ingressHeadersRules: [],
      apiKey: 'sk-secret',
      endpoints: { openaiChatCompletions: {} },
    },
  }));

  await withMockedFetch(
    () => new Response('secret upstream body: up_http_secret_provider', {
      status: 403,
      headers: { 'content-type': 'text/plain', 'x-upstream-id': 'up_http_secret_provider' },
    }),
    async () => {
      const response = await requestAppWithWarmModels('/v1/models', { headers: { 'x-api-key': apiKey.key } });
      assertEquals(response.status, 200);
      assertEquals(response.headers.get('x-upstream-id'), null);
      assertEquals(JSON.stringify(await response.json()).includes('secret upstream body'), false);
    },
  );
});

test('/v1/models appends visible aliases with their aliasedFrom block and folds alias-id collisions onto the alias entry', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.modelAliases.deleteAll();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_oai',
    name: 'Test OpenAI',
    sortOrder: 100,
    config: {
      baseUrl: 'https://oai.example.com',
      ingressHeadersRules: [],
      apiKey: 'sk-test',
      endpoints: { openaiChatCompletions: {} },
    },
  }));
  // Two aliases: one shadows a real id (`gpt-4o`) so the alias entry must
  // replace the catalog entry; one points at a real id under a brand-new
  // name (`gpt-fast`).
  await repo.modelAliases.insert({
    id: 'alias_gpt-4o',
    name: 'gpt-4o',
    kind: 'chat',
    selection: 'first-available',
    displayName: null,
    visibleInModelsList: true,
    targets: [{ target_model_id: 'gpt-4o', rules: { reasoning: { effort: 'low' } } }],
    announcedMetadata: null,
    sortOrder: 1,
    createdAt: '2026-06-26T00:00:00.000Z',
    updatedAt: '2026-06-26T00:00:00.000Z',
  });
  await repo.modelAliases.insert({
    id: 'alias_gpt-fast',
    name: 'gpt-fast',
    kind: 'chat',
    selection: 'first-available',
    displayName: 'Operator Fast',
    visibleInModelsList: true,
    targets: [{ target_model_id: 'gpt-4o-mini', rules: {} }],
    announcedMetadata: null,
    sortOrder: 0,
    createdAt: '2026-06-26T00:00:00.000Z',
    updatedAt: '2026-06-26T00:00:00.000Z',
  });
  await repo.modelAliases.insert({
    id: 'alias_hidden-alias',
    name: 'hidden-alias',
    kind: 'chat',
    selection: 'first-available',
    displayName: null,
    visibleInModelsList: false,
    targets: [{ target_model_id: 'gpt-4o', rules: {} }],
    announcedMetadata: null,
    sortOrder: 2,
    createdAt: '2026-06-26T00:00:00.000Z',
    updatedAt: '2026-06-26T00:00:00.000Z',
  });

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models' && url.hostname === 'api.individual.githubcopilot.com') {
        return jsonResponse(copilotModels([]));
      }
      if (url.pathname === '/v1/models' && url.hostname === 'oai.example.com') {
        return jsonResponse({ object: 'list', data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestAppWithWarmModels('/v1/models', { headers: { 'x-api-key': apiKey.key } });
      assertEquals(response.status, 200);
      const body = (await response.json()) as { data: Array<{ id: string; display_name: string; aliasedFrom?: { selection: string } }> };
      const ids = body.data.map(model => model.id);

      // Real `gpt-4o` is replaced by the alias of the same name; the alias
      // entry sits where the catalog ordering placed it. `gpt-4o-mini`
      // (still a real id) stays first, and the two visible aliases land
      // after the real-only entries.
      assertEquals(ids.includes('gpt-4o-mini'), true);
      assertEquals(ids.filter(id => id === 'gpt-4o').length, 1);
      assertEquals(ids.includes('hidden-alias'), false);

      const collided = body.data.find(model => model.id === 'gpt-4o')!;
      assertEquals(collided.aliasedFrom !== undefined, true);
      assertEquals(collided.aliasedFrom?.selection, 'first-available');
      assertEquals(collided.display_name, 'gpt-4o (low effort)');

      const fast = body.data.find(model => model.id === 'gpt-fast')!;
      assertEquals(fast.aliasedFrom !== undefined, true);
      assertEquals(fast.display_name, 'Operator Fast');
    },
  );
});

// Claude Code CLI's `/model` picker discovers gateway-served models by GET
// /v1/models?limit=1000. Its `[1m]` suffix — which flips a pick to the
// 1M-context window — only reaches the picker when the discovered id
// carries the suffix, and the CLI does not synthesize the variant on
// discovered ids in gateway mode. So the handler rewrites 1M-capable ids
// on the wire only for callers that identify as the Claude Code CLI, and
// translates the payload into the official Anthropic /v1/models shape
// (`{data, first_id, has_more, last_id}` with `ModelInfo` rows).
// Non-Claude-Code callers still see Floway's PublicModel superset.
test('/v1/models serves Anthropic-shape rows with a [1m] suffix on 1M-capable ids to Claude Code CLI callers', async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        });
      }
      if (url.pathname === '/models' && url.hostname === 'api.individual.githubcopilot.com') {
        return jsonResponse(
          copilotModels([
            {
              id: 'claude-opus-4.7',
              display_name: 'Claude Opus 4.7',
              supported_endpoints: ['/v1/messages'],
              maxContextWindowTokens: 1_000_000,
              maxOutputTokens: 128_000,
            },
            {
              id: 'claude-haiku-4.5',
              display_name: 'Claude Haiku 4.5',
              supported_endpoints: ['/v1/messages'],
              maxContextWindowTokens: 200_000,
              maxOutputTokens: 64_000,
            },
          ]),
        );
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const claudeCodeResp = await requestAppWithWarmModels('/v1/models', {
        headers: { 'x-api-key': apiKey.key, 'user-agent': 'claude-code/2.1.206' },
      });
      assertEquals(claudeCodeResp.status, 200);
      const claudeCodeBody = (await claudeCodeResp.json()) as {
        object?: unknown;
        first_id: string | null;
        has_more: boolean;
        last_id: string | null;
        data: Array<{
          id: string;
          type: string;
          display_name: string;
          created_at: string;
          max_input_tokens: number | null;
          max_tokens: number | null;
          capabilities: unknown;
          // Floway superset leftovers that must not reach the wire in this branch.
          object?: unknown;
          kind?: unknown;
          endpoints?: unknown;
          limits?: unknown;
          pricing?: unknown;
          chat?: unknown;
        }>;
      };
      // Anthropic envelope: no `object` field, has_more literal false,
      // container edges reflect the rewritten id order (Copilot merges in
      // input order, so `claude-opus-4.7` lands first).
      assertEquals(claudeCodeBody.object, undefined);
      assertEquals(claudeCodeBody.has_more, false);
      assertEquals(claudeCodeBody.first_id, 'claude-opus-4-7[1m]');
      assertEquals(claudeCodeBody.last_id, 'claude-haiku-4-5');

      // 1M model gains the suffix; display_name and token limits mirror
      // upstream, so the picker keeps rendering the original label and
      // downstream Anthropic-shape consumers still see accurate windows.
      const opus = claudeCodeBody.data.find(m => m.display_name === 'Claude Opus 4.7')!;
      assertEquals(opus.id, 'claude-opus-4-7[1m]');
      assertEquals(opus.type, 'model');
      assertEquals(opus.max_input_tokens, 1_000_000);
      assertEquals(opus.max_tokens, 128_000);
      // `capabilities` is intentionally null: Floway does not track every
      // dimension the SDK declares; nulling out is honest, and the CLI
      // strips the field anyway.
      assertEquals(opus.capabilities, null);
      // Unknown upstream release date collapses to the epoch sentinel.
      assertEquals(opus.created_at, '1970-01-01T00:00:00Z');
      // Floway superset fields are dropped from this branch.
      assertEquals(opus.object, undefined);
      assertEquals(opus.kind, undefined);
      assertEquals(opus.endpoints, undefined);
      assertEquals(opus.limits, undefined);
      assertEquals(opus.pricing, undefined);
      assertEquals(opus.chat, undefined);

      // 200K model stays bare and carries the same Anthropic-shape fields.
      const haiku = claudeCodeBody.data.find(m => m.display_name === 'Claude Haiku 4.5')!;
      assertEquals(haiku.id, 'claude-haiku-4-5');
      assertEquals(haiku.max_input_tokens, 200_000);
      assertEquals(haiku.max_tokens, 64_000);

      // Non-Claude-Code caller: Floway's PublicModel superset is unchanged.
      const openAiResp = await requestAppWithWarmModels('/v1/models', {
        headers: { 'x-api-key': apiKey.key, 'user-agent': 'openai-python/1.42.0' },
      });
      assertEquals(openAiResp.status, 200);
      const openAiBody = (await openAiResp.json()) as {
        object: string;
        first_id: string | null;
        last_id: string | null;
        data: Array<{ id: string; kind?: string; limits?: Record<string, number>; type?: string; display_name?: string }>;
      };
      assertEquals(openAiBody.object, 'list');
      assertEquals(openAiBody.data.map(m => m.id).sort(), ['claude-haiku-4-5', 'claude-opus-4-7']);
      assertEquals(openAiBody.first_id, 'claude-opus-4-7');
      assertEquals(openAiBody.last_id, 'claude-haiku-4-5');
      const openAiOpus = openAiBody.data.find(m => m.id === 'claude-opus-4-7')!;
      // Superset fields (kind, limits) still present on the default branch.
      assertEquals(openAiOpus.kind, 'chat');
      assertEquals(openAiOpus.limits?.max_context_window_tokens, 1_000_000);
    },
  );
});

test('/v1/models keeps the configured public endpoint when OMP connects through a reverse proxy', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    config: {
      baseUrl: 'https://upstream.example', apiKey: 'upstream-key', ingressHeadersRules: [],
      endpoints: {}, modelsFetch: { enabled: false, authStyle: 'bearer' },
      models: [
        { upstreamModelId: 'response-model', kind: 'chat', endpoints: { openaiResponses: {} }, chat: { reasoning: { effort: { supported: ['low'], default: 'low' } } } },
        { upstreamModelId: 'budget-model', kind: 'chat', endpoints: { anthropicMessages: {} }, chat: { reasoning: { budget_tokens: { min: 1024 } } } },
      ],
    },
  }));
  await withMockedFetch(() => { throw new Error('configured models require no upstream fetch'); }, async () => {
    const endpoint = 'https://public.example/gateway';
    const response = await requestAppWithWarmModels(`http://internal:8788/v1/models?endpoint=${encodeURIComponent(endpoint)}`, {
      headers: { 'x-api-key': apiKey.key, 'user-agent': 'omp/18.8.4' },
    });
    assertEquals(response.status, 200);
    const body = await response.json() as { models: OmpModel[] };
    assertEquals(body.models.find(model => model.id === 'response-model')!.baseUrl, `${endpoint}/v1`);
    assertEquals(body.models.find(model => model.id === 'budget-model')!.baseUrl, endpoint);

    const named = await requestAppWithWarmModels(`/v1/models?provider=personal&endpoint=${encodeURIComponent(endpoint)}`, {
      headers: { 'x-api-key': apiKey.key, 'user-agent': 'pi/1.1.0 (linux; node/v22.19.0; x64)' },
    });
    assertEquals(named.status, 200);
    assertEquals((await named.json() as { models: { provider: string }[] }).models.map(model => model.provider), ['personal', 'personal']);

    const invalidProvider = await requestAppWithWarmModels('/v1/models?provider=UPPER', {
      headers: { 'x-api-key': apiKey.key, 'user-agent': 'omp/18.8.4' },
    });
    assertEquals(invalidProvider.status, 400);
    const invalid = await requestAppWithWarmModels('/v1/models?endpoint=ftp%3A%2F%2Fpublic.example', {
      headers: { 'x-api-key': apiKey.key, 'user-agent': 'omp/18.8.4' },
    });
    assertEquals(invalid.status, 400);
  });
});

test('/v1/models serves omp-tailored catalog to omp/* callers and preserves precedence for other callers', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.upstreams.deleteAll();

  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_omp_test',
    name: 'OMP Test Provider',
    sortOrder: 100,
    config: {
      baseUrl: 'https://omp-test.example.com',
      ingressHeadersRules: [],
      apiKey: 'sk-omp-test',
      endpoints: {},
      modelsFetch: { enabled: false, authStyle: 'bearer' },
      models: [
        {
          upstreamModelId: 'test-chat',
          publicModelId: 'test-chat',
          kind: 'chat',
          endpoints: { openaiChatCompletions: {} },
          limits: { max_context_window_tokens: 128_000, max_prompt_tokens: 100_000, max_output_tokens: 4_096 },
          chat: { modalities: { input: ['text', 'image'], output: ['text'] } },
        },
        {
          upstreamModelId: 'test-embed',
          publicModelId: 'test-embed',
          kind: 'embedding',
          endpoints: { openaiEmbeddings: {} },
          limits: { max_context_window_tokens: 8_192 },
        },
        {
          upstreamModelId: 'test-image',
          publicModelId: 'test-image',
          kind: 'image',
          endpoints: { openaiImagesGenerations: {} },
        },
        {
          upstreamModelId: 'test-rerank',
          publicModelId: 'test-rerank',
          kind: 'rerank',
          endpoints: { rerank: {} },
          rerankTarget: { protocol: 'cohere-v1' },
          limits: { max_context_window_tokens: 4_096 },
        },
      ],
    },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'raw.githubusercontent.com') {
        return new Response(null, { status: 404 });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const ompResponse = await requestAppWithWarmModels('/v1/models', {
        headers: { 'x-api-key': apiKey.key, 'user-agent': 'omp/18.8.4' },
      });
      assertEquals(ompResponse.status, 200);
      const ompBody = await ompResponse.json() as { api: string; models: OmpModel[] };
      assertEquals(ompBody.api, 'floway:floway');
      assertEquals(ompBody.models.map(model => model.id), ['test-image', 'test-embed', 'test-chat']);
      // A prefix match is not an omp identity.
      const lookalike = await requestAppWithWarmModels('/v1/models', { headers: { 'x-api-key': apiKey.key, 'user-agent': 'floway-omp/1' } });
      const lookalikeBody = await lookalike.json() as { data: Array<{ id: string }> };
      assertEquals(lookalikeBody.data.map(model => model.id), ['test-rerank', 'test-image', 'test-embed', 'test-chat']);
    },
  );
});

test('the TypeSafe SDK user agent receives the { models } catalog its parsers require', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.upstreams.deleteAll();

  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_typesafe',
    name: 'Decision Provider',
    config: {
      baseUrl: 'https://decision.example.com',
      ingressHeadersRules: [],
      apiKey: 'sk-decision',
      endpoints: {},
      modelsFetch: { enabled: false, authStyle: 'bearer' },
      models: [{
        upstreamModelId: 'jev-1.13',
        publicModelId: 'jev-1.13',
        kind: 'decision',
        endpoints: { decision: {} },
        decisionTarget: { protocol: 'typesafe-systemone' },
      }],
    },
  }));

  // The warm helper only runs under an installed fetch mock.
  await withMockedFetch(
    () => { throw new Error('a manual custom model needs no fetch'); },
    async () => {
      const response = await requestAppWithWarmModels('/v1/models', {
        headers: { 'x-api-key': apiKey.key, 'user-agent': 'typesafe-sdk/0.7.5' },
      });
      assertEquals(response.status, 200);
      const body = (await response.json()) as { models: Array<{ name: string; description: string; release_date: string }> };
      assertEquals(body.models.map(model => model.name), ['jev-1.13']);
      // All three fields are required by both SDKs; a model with no date keeps the
      // epoch sentinel rather than omitting the key.
      assertEquals(body.models[0].description, 'jev-1.13');
      assertEquals(body.models[0].release_date, '1970-01-01');
    },
  );
});
