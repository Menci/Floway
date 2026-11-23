import { describe, test } from 'vitest';

import { enumerateModelCandidates } from './request-directory.ts';
import { toPublicModel } from '../../../src/data-plane/models/load.ts';
import { compareModelIds, getModelsFromProviders } from '../../../src/data-plane/providers/catalog.ts';
import { listModelProviders } from '../../../src/data-plane/providers/registry.ts';
import { createModelsRefreshScheduler } from '../../../src/execution/models-refresh.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, copilotModels, setupAppTest, warmModelsForTest } from '../../test-utils/app.ts';
import type { InternalModel, ProviderModel } from '@floway-dev/provider';
import { assertEquals, jsonResponse, withMockedFetch as withMockedFetchRaw } from '@floway-dev/test-utils';

const withMockedFetch = <T>(
  handler: Parameters<typeof withMockedFetchRaw>[0],
  fn: () => Promise<T>,
): Promise<T> => withMockedFetchRaw(handler, async () => {
  await warmModelsForTest();
  return await fn();
});

const realProviderModels = (model: InternalModel | undefined): Record<string, ProviderModel> => {
  if (model?.providerModels === undefined) throw new Error(`expected real InternalModel with providerModels, got ${JSON.stringify(model)}`);
  return model.providerModels;
};

const sortedIds = (ids: readonly string[]): string[] => [...ids].sort(compareModelIds);

const testScheduler = (promise: Promise<unknown>): void => {
  promise.catch(err => console.error('[background]', err));
};
const scheduleRefresh = createModelsRefreshScheduler('TEST', testScheduler);

test('compareModelIds orders isolated single digits descending element by element', () => {
  // Digit arrays: claude-opus-4-7 [4,7], claude-sonnet-4-6 [4,6],
  // claude-opus-4-5 / claude-haiku-4-5 [4,5]. Within the [4,5] tie, lex
  // descending picks 'claude-opus-4-5' over 'claude-haiku-4-5'.
  assertEquals(sortedIds(['claude-opus-4-7', 'claude-opus-4-5', 'claude-haiku-4-5', 'claude-sonnet-4-6']), [
    'claude-opus-4-7',
    'claude-sonnet-4-6',
    'claude-opus-4-5',
    'claude-haiku-4-5',
  ]);
});

test('catalog assembly returns the merged catalog plus the per-id upstream index', async () => {
  const { repo } = await setupAppTest();

  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord());
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({ id: 'up_disabled', enabled: false, usageRefreshIntervalMinutes: 0, sortOrder: 50 }));

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
        return jsonResponse(
          copilotModels([
            {
              id: 'shared-model',
              display_name: 'Shared Model',
              supported_endpoints: ['/v1/messages'],
            },
          ]),
        );
      }
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({
          object: 'list',
          data: [
            {
              id: 'shared-model',
              supported_endpoints: ['/chat/completions'],
              chat: { image_detail_original: true },
            },
          ],
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const { models, upstreamsByPublicId } = getModelsFromProviders(await listModelProviders(null), scheduleRefresh);
      const model = models.find(candidate => candidate.id === 'shared-model');

      assertEquals(model?.display_name, 'Shared Model');
      // The merged endpoint surface is the OR of both upstreams' endpoint maps.
      assertEquals(model?.endpoints, { anthropicMessages: {}, openaiChatCompletions: {} });
      assertEquals(model?.kind, 'chat');
      assertEquals(model?.chat?.image_detail_original, false);
      assertEquals(model?.opaqueBlobCompatibilityScope, { bindToUpstream: true });
      assertEquals(model && toPublicModel(model).opaqueBlobCompatibilityScope, { bindToUpstream: true });
      // The reverse index lists every upstream that surfaced this id, in
      // enumeration order — copilot first, then custom.
      assertEquals(upstreamsByPublicId.get('shared-model')?.map(p => p.upstreamId), ['up_copilot', 'up_custom']);
      // Every contributing upstream keeps its own emitted `ProviderModel`
      // verbatim under `providerModels[<upstream>]` — merge unions the
      // outer `endpoints` but never rewrites the per-upstream capability
      // each provider originally advertised.
      assertEquals(Object.keys(realProviderModels(model)).sort(), ['up_copilot', 'up_custom']);
      assertEquals(realProviderModels(model)['up_copilot']?.endpoints, { anthropicMessages: {} });
      assertEquals(realProviderModels(model)['up_custom']?.endpoints, { openaiChatCompletions: {} });
      assertEquals(realProviderModels(model)['up_copilot']?.chat?.image_detail_original, undefined);
      assertEquals(realProviderModels(model)['up_custom']?.chat?.image_detail_original, true);

      const resolved = await enumerateModelCandidates({ upstreamIds: null, randomizeUpstreams: false, model: 'shared-model', kind: 'chat', runtimeLocation: 'TEST' });
      assertEquals(resolved.candidates.map(m => m.upstreamId), ['up_copilot', 'up_custom']);
      // Each match carries its own per-provider endpoints — no merge.
      assertEquals(resolved.candidates[0]?.endpoints, { anthropicMessages: {} });
      assertEquals(resolved.candidates[1]?.endpoints, { openaiChatCompletions: {} });
    },
  );
});

test('disabledPublicModelIds hides models from the catalog and routing, per upstream', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const azureUpstream = (over: { id: string; sortOrder: number; models: { upstreamModelId: string; publicModelId?: string }[]; disabledPublicModelIds: string[] }) => ({
    id: over.id,
    kind: 'azure' as const,
    name: over.id,
    enabled: true,
    usageRefreshIntervalMinutes: 0,
    sortOrder: over.sortOrder,
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
    config: {
      endpoint: 'https://example.openai.azure.com',
      apiKey: 'az-key',
      models: over.models.map(m => ({ ...m, endpoints: { openaiChatCompletions: {} } })),
    },
    state: null,
    flagOverrides: {},
    disabledPublicModelIds: over.disabledPublicModelIds,
    proxyFallbackList: [],
    modelPrefix: null,
    modelsCache: null,
    hue: 210,
  });

  // up_a disables a solo model and a shared one (by public id, including a
  // publicModelId override); up_b still serves the shared id, enabled.
  await saveUpstreamForTest(repo.upstreams, azureUpstream({
    id: 'up_a',
    sortOrder: 1,
    models: [
      { upstreamModelId: 'gpt-keep' },
      { upstreamModelId: 'gpt-solo' },
      { upstreamModelId: 'gpt-shared' },
      { upstreamModelId: 'dep-x', publicModelId: 'gpt-override' },
    ],
    disabledPublicModelIds: ['gpt-solo', 'gpt-shared', 'gpt-override'],
  }));
  await saveUpstreamForTest(repo.upstreams, azureUpstream({
    id: 'up_b',
    sortOrder: 2,
    models: [{ upstreamModelId: 'gpt-shared' }],
    disabledPublicModelIds: [],
  }));

  await warmModelsForTest();
  const catalog = getModelsFromProviders(await listModelProviders(null), scheduleRefresh).models;
  assertEquals([...catalog.map(m => m.id)].sort(), ['gpt-keep', 'gpt-shared']);

  // The solo and override ids resolve to nothing (hidden + unroutable).
  assertEquals((await enumerateModelCandidates({ upstreamIds: null, randomizeUpstreams: false, model: 'gpt-solo', kind: 'chat', runtimeLocation: 'TEST' })).candidates.length, 0);
  assertEquals((await enumerateModelCandidates({ upstreamIds: null, randomizeUpstreams: false, model: 'gpt-override', kind: 'chat', runtimeLocation: 'TEST' })).candidates.length, 0);

  // The shared id survives because up_b allows it; only up_b binds it.
  const shared = await enumerateModelCandidates({ upstreamIds: null, randomizeUpstreams: false, model: 'gpt-shared', kind: 'chat', runtimeLocation: 'TEST' });
  assertEquals(shared.candidates.map(m => m.upstreamId), ['up_b']);

  // The untouched model still routes from up_a.
  const keep = await enumerateModelCandidates({ upstreamIds: null, randomizeUpstreams: false, model: 'gpt-keep', kind: 'chat', runtimeLocation: 'TEST' });
  assertEquals(keep.candidates.map(m => m.upstreamId), ['up_a']);
});

// End-to-end listing checks for the prefix policy. The catalog walk goes
// through getModelsFromProviders, which threads custom upstreams' /v1/models
// responses through readUpstreamModelsSnapshotAndScheduleRefresh just like production does.
describe('catalog listing under modelPrefix', () => {
  test('listed=[prefixed] lists only the prefixed surface and routes the prefixed request to the upstream', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
      id: 'up_prefixed',
      sortOrder: 1,
      config: { baseUrl: 'https://prefixed.example.com', apiKey: 'sk-x', endpoints: { openaiChatCompletions: {} }, ingressHeadersRules: [] },
      modelPrefix: { prefix: 'or/', addressable: ['prefixed'], listed: ['prefixed'] },
    }));

    await withMockedFetch(
      request => {
        const url = new URL(request.url);
        if (url.hostname === 'prefixed.example.com' && url.pathname === '/v1/models') {
          return jsonResponse({ object: 'list', data: [{ id: 'gpt-4o', supported_endpoints: ['/chat/completions'] }] });
        }
        throw new Error(`Unhandled fetch ${request.url}`);
      },
      async () => {
        const catalog = getModelsFromProviders(await listModelProviders(null), scheduleRefresh).models;
        assertEquals(catalog.map(m => m.id), ['or/gpt-4o']);
        // Prefixed surface gets a synthesized display_name prepending the
        // upstream's display name so the dashboard tells the operator at a
        // glance which upstream a prefixed entry came from.
        assertEquals(catalog[0]?.display_name, 'Custom Provider: gpt-4o');

        // Regression: with `listed: ['prefixed']` the catalog walk emits only
        // the prefixed surface, so a byId-based routing lookup against the
        // stripped bare id would miss. Routing must instead consult each
        // scoped upstream's own catalog, where the bare id is always present.
        const resolved = await enumerateModelCandidates({ upstreamIds: null, randomizeUpstreams: false, model: 'or/gpt-4o', kind: 'chat', runtimeLocation: 'TEST' });
        assertEquals(resolved.candidates.map(m => m.upstreamId), ['up_prefixed']);
        assertEquals(resolved.candidates[0]?.modelId, 'gpt-4o');

        // The bare-id request must NOT route to a prefix-only-addressable
        // upstream, regardless of routing path.
        const bare = await enumerateModelCandidates({ upstreamIds: null, randomizeUpstreams: false, model: 'gpt-4o', kind: 'chat', runtimeLocation: 'TEST' });
        assertEquals(bare.candidates.length, 0);
      },
    );
  });

  test('addressable=[unprefixed, prefixed] + listed=[prefixed] routes both surface forms', async () => {
    // The upstream is bare-id-addressable but only the prefixed form appears
    // in /v1/models. Routing must still resolve a bare-id request via the
    // upstream's own catalog (addressable=['unprefixed', 'prefixed'] keeps it
    // in the candidate set), and a prefixed request via the prefix-strip +
    // per-provider catalog lookup.
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
      id: 'up_dual_addressable',
      sortOrder: 1,
      config: { baseUrl: 'https://dual.example.com', apiKey: 'sk-x', endpoints: { openaiChatCompletions: {} }, ingressHeadersRules: [] },
      modelPrefix: { prefix: 'or/', addressable: ['unprefixed', 'prefixed'], listed: ['prefixed'] },
    }));

    await withMockedFetch(
      request => {
        const url = new URL(request.url);
        if (url.hostname === 'dual.example.com' && url.pathname === '/v1/models') {
          return jsonResponse({ object: 'list', data: [{ id: 'gpt-4o', supported_endpoints: ['/chat/completions'] }] });
        }
        throw new Error(`Unhandled fetch ${request.url}`);
      },
      async () => {
        const catalog = getModelsFromProviders(await listModelProviders(null), scheduleRefresh).models;
        assertEquals(catalog.map(m => m.id), ['or/gpt-4o']);

        const bare = await enumerateModelCandidates({ upstreamIds: null, randomizeUpstreams: false, model: 'gpt-4o', kind: 'chat', runtimeLocation: 'TEST' });
        assertEquals(bare.candidates.map(m => m.upstreamId), ['up_dual_addressable']);
        assertEquals(bare.candidates[0]?.modelId, 'gpt-4o');

        // The prefixed request enumerates both forms against `up_dual_addressable`:
        // the unprefixed lookup (`or/gpt-4o`) misses the upstream catalog, and
        // the prefix-stripped lookup (`gpt-4o`) hits — yielding a single match.
        const prefixed = await enumerateModelCandidates({ upstreamIds: null, randomizeUpstreams: false, model: 'or/gpt-4o', kind: 'chat', runtimeLocation: 'TEST' });
        assertEquals(prefixed.candidates.map(m => m.upstreamId), ['up_dual_addressable']);
        assertEquals(prefixed.candidates[0]?.modelId, 'gpt-4o');
      },
    );
  });

  // Regression for the three-upstream case the routing-primitive refactor was
  // motivated by. The same public id `aa/bb/gpt-5` is reachable through three
  // configured paths: an `aa/`-prefixed upstream whose catalog carries the id
  // `bb/gpt-5`, a longer `aa/bb/`-prefixed upstream whose catalog carries the
  // id `gpt-5`, and a bare upstream whose catalog literally carries
  // `aa/bb/gpt-5`. Every upstream must enumerate as an independent match —
  // an earlier iteration of the resolver returned only the first match and
  // would have shadowed two of them.
  test('three upstreams advertising the same public id via different paths all enumerate as matches', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
      id: 'up_short_prefix',
      sortOrder: 1,
      config: { baseUrl: 'https://short.example.com', apiKey: 'sk-x', endpoints: { openaiChatCompletions: {} }, ingressHeadersRules: [] },
      modelPrefix: { prefix: 'aa/', addressable: ['prefixed'], listed: ['prefixed'] },
    }));
    await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
      id: 'up_long_prefix',
      sortOrder: 2,
      config: { baseUrl: 'https://long.example.com', apiKey: 'sk-x', endpoints: { openaiChatCompletions: {} }, ingressHeadersRules: [] },
      modelPrefix: { prefix: 'aa/bb/', addressable: ['prefixed'], listed: ['prefixed'] },
    }));
    await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
      id: 'up_bare',
      sortOrder: 3,
      config: { baseUrl: 'https://bare.example.com', apiKey: 'sk-x', endpoints: { openaiChatCompletions: {} }, ingressHeadersRules: [] },
    }));

    await withMockedFetch(
      request => {
        const url = new URL(request.url);
        if (url.hostname === 'short.example.com' && url.pathname === '/v1/models') {
          return jsonResponse({ object: 'list', data: [{ id: 'bb/gpt-5', supported_endpoints: ['/chat/completions'] }] });
        }
        if (url.hostname === 'long.example.com' && url.pathname === '/v1/models') {
          return jsonResponse({ object: 'list', data: [{ id: 'gpt-5', supported_endpoints: ['/chat/completions'] }] });
        }
        if (url.hostname === 'bare.example.com' && url.pathname === '/v1/models') {
          return jsonResponse({ object: 'list', data: [{ id: 'aa/bb/gpt-5', supported_endpoints: ['/chat/completions'] }] });
        }
        throw new Error(`Unhandled fetch ${request.url}`);
      },
      async () => {
        const resolved = await enumerateModelCandidates({ upstreamIds: null, randomizeUpstreams: false, model: 'aa/bb/gpt-5', kind: 'chat', runtimeLocation: 'TEST' });
        assertEquals(resolved.candidates.map(m => m.upstreamId), ['up_short_prefix', 'up_long_prefix', 'up_bare']);
        assertEquals(resolved.candidates.map(m => m.modelId), ['bb/gpt-5', 'gpt-5', 'aa/bb/gpt-5']);
      },
    );
  });
});
