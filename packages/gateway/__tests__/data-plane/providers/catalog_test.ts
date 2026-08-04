import { describe, test } from 'vitest';

import { compareModelIds, getModelsFromProviders } from '../../../src/data-plane/providers/catalog.ts';
import { clearInFlightForTesting } from '../../../src/data-plane/providers/models-cache.ts';
import { listModelProviders } from '../../../src/data-plane/providers/registry.ts';
import { enumerateModelCandidates } from '../../../src/data-plane/providers/resolution.ts';
import { buildCustomUpstreamRecord, copilotModels, setupAppTest } from '../../test-utils/app.ts';
import { directFetcher, type InternalModel, type ProviderModel } from '@floway-dev/provider';
import { assertEquals, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const realProviderModels = (model: InternalModel | undefined): Record<string, ProviderModel> => {
  if (model?.providerModels === undefined) throw new Error(`expected real InternalModel with providerModels, got ${JSON.stringify(model)}`);
  return model.providerModels;
};

const sortedIds = (ids: readonly string[]): string[] => [...ids].sort(compareModelIds);

const testScheduler = (promise: Promise<unknown>): void => {
  promise.catch(err => console.error('[background]', err));
};

test('compareModelIds pushes ids containing "/" to the tail', () => {
  assertEquals(sortedIds(['accounts/msft/x', 'gpt-4o', 'accounts/msft/y', 'claude-opus-4-7']), [
    'claude-opus-4-7',
    'gpt-4o',
    // Within the slashed group, the remaining keys still apply: same alpha
    // prefix "accounts", empty isolated-digit arrays, then descending lex.
    'accounts/msft/y',
    'accounts/msft/x',
  ]);
});

test('compareModelIds groups by leading [a-zA-Z]+ prefix, case-insensitive ascending', () => {
  // gpt and GPT collapse on key 1; their tied [4] digit array falls to
  // descending lex (lowercased), so 'gpt-4o-mini' beats 'gpt-4o'.
  assertEquals(sortedIds(['gpt-4o', 'claude-haiku-4-5', 'deepseek-v4-pro', 'GPT-4o-mini']), [
    'claude-haiku-4-5',
    'deepseek-v4-pro',
    'GPT-4o-mini',
    'gpt-4o',
  ]);
});

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

test('compareModelIds puts longer digit arrays before shorter ones (descending)', () => {
  // [5,5] beats every [4]; within the tied-[4] group, descending lex on the
  // full id puts 'gpt-4o' first, then 'gpt-4-turbo', then 'gpt-4' last.
  assertEquals(sortedIds(['gpt-5.5', 'gpt-4', 'gpt-4o', 'gpt-4-turbo']), [
    'gpt-5.5',
    'gpt-4o',
    'gpt-4-turbo',
    'gpt-4',
  ]);
});

test('compareModelIds ignores multi-digit runs such as dates', () => {
  // Both have digit array [4, 7]; descending lex tie-break puts the longer
  // dated id first.
  assertEquals(sortedIds(['claude-opus-4-7-20300101', 'claude-opus-4-7']), [
    'claude-opus-4-7-20300101',
    'claude-opus-4-7',
  ]);
});

test('compareModelIds sorts ids without a leading alpha prefix first', () => {
  assertEquals(sortedIds(['gpt-4o', 'o1-mini', '128k-context-model']), [
    '128k-context-model',
    'gpt-4o',
    'o1-mini',
  ]);
});

test('compareModelIds keeps case-only differences adjacent via lowercase tie-break', () => {
  // All lowercase to 'gpt-4o' so case-folded lex ties; raw descending then
  // picks lowercase letters before uppercase (g > G in ASCII).
  assertEquals(sortedIds(['GPT-4o', 'gpt-4o', 'gpt-4O']), [
    'gpt-4o',
    'gpt-4O',
    'GPT-4o',
  ]);
});

test('catalog assembly returns the merged catalog plus the per-id upstream index', async () => {
  const { repo } = await setupAppTest();

  await repo.upstreams.save(buildCustomUpstreamRecord());
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_disabled', enabled: false, sortOrder: 50 }));

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
            },
          ],
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const { models, upstreamsByPublicId } = await getModelsFromProviders(await listModelProviders(null), () => directFetcher, testScheduler);
      const model = models.find(candidate => candidate.id === 'shared-model');

      assertEquals(model?.display_name, 'Shared Model');
      // The merged endpoint surface is the OR of both upstreams' endpoint maps.
      assertEquals(model?.endpoints, { messages: {}, chatCompletions: {} });
      assertEquals(model?.kind, 'chat');
      // `providerData` (the per-provider wire id carrier) belongs to the
      // provider-emitted ProviderModel, not the gateway-merged catalog row.
      assertEquals(Object.hasOwn(model!, 'providerData'), false);
      // The reverse index lists every upstream that surfaced this id, in
      // enumeration order — copilot first, then custom.
      assertEquals(upstreamsByPublicId.get('shared-model')?.map(p => p.upstreamId), ['up_copilot', 'up_custom']);
      // Every contributing upstream keeps its own emitted `ProviderModel`
      // verbatim under `providerModels[<upstream>]` — merge unions the
      // outer `endpoints` but never rewrites the per-upstream capability
      // each provider originally advertised.
      assertEquals(Object.keys(realProviderModels(model)).sort(), ['up_copilot', 'up_custom']);
      assertEquals(realProviderModels(model)['up_copilot']?.endpoints, { messages: {} });
      assertEquals(realProviderModels(model)['up_custom']?.endpoints, { chatCompletions: {} });
      // `enabledFlags` is required on every ProviderModel — proves the
      // stored value is the provider-emitted shape (not a projected
      // subset).
      assertEquals(realProviderModels(model)['up_copilot']?.enabledFlags instanceof Set, true);
      assertEquals(realProviderModels(model)['up_custom']?.enabledFlags instanceof Set, true);

      const resolved = await enumerateModelCandidates({ upstreamIds: null, model: 'shared-model', kind: 'chat', scheduler: testScheduler, runtimeLocation: 'TEST' });
      assertEquals(resolved.candidates.map(m => m.provider.upstreamId), ['up_copilot', 'up_custom']);
      // Each match carries its own per-provider endpoints — no merge.
      assertEquals(resolved.candidates[0]?.model.endpoints, { messages: {} });
      assertEquals(resolved.candidates[1]?.model.endpoints, { chatCompletions: {} });
      // Each enumerated candidate seeds `providerModels[provider.upstreamId]`
      // so `providerModelOf(candidate)` resolves at dispatch time.
      assertEquals(Object.keys(realProviderModels(resolved.candidates[0]?.model)), ['up_copilot']);
      assertEquals(Object.keys(realProviderModels(resolved.candidates[1]?.model)), ['up_custom']);
      assertEquals(realProviderModels(resolved.candidates[0]?.model)['up_copilot']?.endpoints, { messages: {} });
      assertEquals(realProviderModels(resolved.candidates[1]?.model)['up_custom']?.endpoints, { chatCompletions: {} });
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
    sortOrder: over.sortOrder,
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
    config: {
      endpoint: 'https://example.openai.azure.com',
      apiKey: 'az-key',
      models: over.models.map(m => ({ ...m, endpoints: { chatCompletions: {} } })),
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
  await repo.upstreams.save(azureUpstream({
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
  await repo.upstreams.save(azureUpstream({
    id: 'up_b',
    sortOrder: 2,
    models: [{ upstreamModelId: 'gpt-shared' }],
    disabledPublicModelIds: [],
  }));

  const catalog = (await getModelsFromProviders(await listModelProviders(null), () => directFetcher, testScheduler)).models;
  assertEquals([...catalog.map(m => m.id)].sort(), ['gpt-keep', 'gpt-shared']);

  // The solo and override ids resolve to nothing (hidden + unroutable).
  assertEquals((await enumerateModelCandidates({ upstreamIds: null, model: 'gpt-solo', kind: 'chat', scheduler: testScheduler, runtimeLocation: 'TEST' })).candidates.length, 0);
  assertEquals((await enumerateModelCandidates({ upstreamIds: null, model: 'gpt-override', kind: 'chat', scheduler: testScheduler, runtimeLocation: 'TEST' })).candidates.length, 0);

  // The shared id survives because up_b allows it; only up_b binds it.
  const shared = await enumerateModelCandidates({ upstreamIds: null, model: 'gpt-shared', kind: 'chat', scheduler: testScheduler, runtimeLocation: 'TEST' });
  assertEquals(shared.candidates.map(m => m.provider.upstreamId), ['up_b']);

  // The untouched model still routes from up_a.
  const keep = await enumerateModelCandidates({ upstreamIds: null, model: 'gpt-keep', kind: 'chat', scheduler: testScheduler, runtimeLocation: 'TEST' });
  assertEquals(keep.candidates.map(m => m.provider.upstreamId), ['up_a']);
});

// Per-upstream catalog fetches fan out in parallel: total wall-clock time
// tracks the slowest upstream, not the sum. The bound is loose because CI
// timer noise eats into a tight `< sum` comparison; what matters is the
// ratio.
test('catalog assembly fans out per-upstream catalog fetches in parallel', async () => {
  clearInFlightForTesting();
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const FETCH_DELAY_MS = 60;
  const upstreams = [
    { id: 'up_p1', host: 'p1.example.com', model: 'p1-model' },
    { id: 'up_p2', host: 'p2.example.com', model: 'p2-model' },
    { id: 'up_p3', host: 'p3.example.com', model: 'p3-model' },
  ];
  for (const [index, u] of upstreams.entries()) {
    await repo.upstreams.save(buildCustomUpstreamRecord({
      id: u.id,
      name: u.id,
      sortOrder: index,
      config: { baseUrl: `https://${u.host}`, authStyle: 'bearer', apiKey: 'sk-x', endpoints: { chatCompletions: {} } },
    }));
  }

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      const match = upstreams.find(u => url.hostname === u.host);
      if (match && url.pathname === '/v1/models') {
        await new Promise(resolve => setTimeout(resolve, FETCH_DELAY_MS));
        return jsonResponse({ object: 'list', data: [{ id: match.model, supported_endpoints: ['/chat/completions'] }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const start = Date.now();
      const catalog = (await getModelsFromProviders(await listModelProviders(null), () => directFetcher, testScheduler)).models;
      const elapsed = Date.now() - start;

      assertEquals([...catalog.map(m => m.id)].sort(), ['p1-model', 'p2-model', 'p3-model']);
      // A serial walk would take >= 3 * FETCH_DELAY_MS; parallel is bounded by
      // ~FETCH_DELAY_MS plus per-test overhead. Half the serial budget is the
      // loosest threshold that still excludes any serial regression.
      const serialBudget = upstreams.length * FETCH_DELAY_MS;
      if (elapsed >= serialBudget / 2) {
        throw new Error(`expected parallel walk (~${FETCH_DELAY_MS}ms) but took ${elapsed}ms (serial would be ${serialBudget}ms)`);
      }
    },
  );
});

// A single upstream's catalog fetch failure is surfaced as `lastError` and
// recorded against `sawSuccess === true`; the public catalog still includes
// every successful upstream's models.
test('catalog assembly: a rejected provider does not block other providers', async () => {
  clearInFlightForTesting();
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();

  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_ok_1',
    name: 'OK 1',
    sortOrder: 1,
    config: { baseUrl: 'https://ok1.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { chatCompletions: {} } },
  }));
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_broken',
    name: 'Broken',
    sortOrder: 2,
    config: { baseUrl: 'https://broken.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { chatCompletions: {} } },
  }));
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_ok_2',
    name: 'OK 2',
    sortOrder: 3,
    config: { baseUrl: 'https://ok2.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { chatCompletions: {} } },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'ok1.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'ok-1-model', supported_endpoints: ['/chat/completions'] }] });
      }
      if (url.hostname === 'ok2.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'ok-2-model', supported_endpoints: ['/chat/completions'] }] });
      }
      if (url.hostname === 'broken.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ error: 'upstream went down' }, 502);
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const catalog = (await getModelsFromProviders(await listModelProviders(null), () => directFetcher, testScheduler)).models;
      assertEquals([...catalog.map(m => m.id)].sort(), ['ok-1-model', 'ok-2-model']);
    },
  );
});

// End-to-end listing checks for the prefix policy. The catalog walk goes
// through getModelsFromProviders, which threads custom upstreams' /v1/models
// responses through fetchUpstreamModelsCached just like production does.
describe('catalog listing under modelPrefix', () => {
  test('null prefix lists bare ids only (today\'s behavior)', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(buildCustomUpstreamRecord({
      id: 'up_plain',
      sortOrder: 1,
      config: { baseUrl: 'https://plain.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { chatCompletions: {} } },
    }));

    await withMockedFetch(
      request => {
        const url = new URL(request.url);
        if (url.hostname === 'plain.example.com' && url.pathname === '/v1/models') {
          return jsonResponse({ object: 'list', data: [{ id: 'gpt-4o', supported_endpoints: ['/chat/completions'] }] });
        }
        throw new Error(`Unhandled fetch ${request.url}`);
      },
      async () => {
        const catalog = (await getModelsFromProviders(await listModelProviders(null), () => directFetcher, testScheduler)).models;
        assertEquals(catalog.map(m => m.id), ['gpt-4o']);
      },
    );
  });

  test('listed=[prefixed] lists only the prefixed surface and routes the prefixed request to the upstream', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(buildCustomUpstreamRecord({
      id: 'up_prefixed',
      sortOrder: 1,
      config: { baseUrl: 'https://prefixed.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { chatCompletions: {} } },
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
        const catalog = (await getModelsFromProviders(await listModelProviders(null), () => directFetcher, testScheduler)).models;
        assertEquals(catalog.map(m => m.id), ['or/gpt-4o']);
        // Prefixed surface gets a synthesized display_name prepending the
        // upstream's display name so the dashboard tells the operator at a
        // glance which upstream a prefixed entry came from.
        assertEquals(catalog[0]?.display_name, 'Custom Provider: gpt-4o');

        // Regression: with `listed: ['prefixed']` the catalog walk emits only
        // the prefixed surface, so a byId-based routing lookup against the
        // stripped bare id would miss. Routing must instead consult each
        // scoped upstream's own catalog, where the bare id is always present.
        const resolved = await enumerateModelCandidates({ upstreamIds: null, model: 'or/gpt-4o', kind: 'chat', scheduler: testScheduler, runtimeLocation: 'TEST' });
        assertEquals(resolved.candidates.map(m => m.provider.upstreamId), ['up_prefixed']);
        assertEquals(resolved.candidates[0]?.model.id, 'gpt-4o');

        // The bare-id request must NOT route to a prefix-only-addressable
        // upstream, regardless of routing path.
        const bare = await enumerateModelCandidates({ upstreamIds: null, model: 'gpt-4o', kind: 'chat', scheduler: testScheduler, runtimeLocation: 'TEST' });
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
    await repo.upstreams.save(buildCustomUpstreamRecord({
      id: 'up_dual_addressable',
      sortOrder: 1,
      config: { baseUrl: 'https://dual.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { chatCompletions: {} } },
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
        const catalog = (await getModelsFromProviders(await listModelProviders(null), () => directFetcher, testScheduler)).models;
        assertEquals(catalog.map(m => m.id), ['or/gpt-4o']);

        const bare = await enumerateModelCandidates({ upstreamIds: null, model: 'gpt-4o', kind: 'chat', scheduler: testScheduler, runtimeLocation: 'TEST' });
        assertEquals(bare.candidates.map(m => m.provider.upstreamId), ['up_dual_addressable']);
        assertEquals(bare.candidates[0]?.model.id, 'gpt-4o');

        // The prefixed request enumerates both forms against `up_dual_addressable`:
        // the unprefixed lookup (`or/gpt-4o`) misses the upstream catalog, and
        // the prefix-stripped lookup (`gpt-4o`) hits — yielding a single match.
        const prefixed = await enumerateModelCandidates({ upstreamIds: null, model: 'or/gpt-4o', kind: 'chat', scheduler: testScheduler, runtimeLocation: 'TEST' });
        assertEquals(prefixed.candidates.map(m => m.provider.upstreamId), ['up_dual_addressable']);
        assertEquals(prefixed.candidates[0]?.model.id, 'gpt-4o');
      },
    );
  });

  test('listed=[unprefixed, prefixed] emits both surfaces, both upstreams enumerate on the shared bare id', async () => {
    // up_plain has no prefix and lists `gpt-4o`. up_dual exposes both forms.
    // The bare `gpt-4o` reaches both upstreams — the resolver enumerates
    // candidates from every match; the `or/gpt-4o` surface belongs solely
    // to up_dual because up_plain's catalog does not contain `or/gpt-4o`.
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(buildCustomUpstreamRecord({
      id: 'up_plain',
      sortOrder: 1,
      config: { baseUrl: 'https://plain.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { chatCompletions: {} } },
    }));
    await repo.upstreams.save(buildCustomUpstreamRecord({
      id: 'up_dual',
      sortOrder: 2,
      config: { baseUrl: 'https://dual.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { chatCompletions: {} } },
      modelPrefix: { prefix: 'or/', addressable: ['unprefixed', 'prefixed'], listed: ['unprefixed', 'prefixed'] },
    }));

    await withMockedFetch(
      request => {
        const url = new URL(request.url);
        if (url.hostname === 'plain.example.com' && url.pathname === '/v1/models') {
          return jsonResponse({ object: 'list', data: [{ id: 'gpt-4o', supported_endpoints: ['/chat/completions'] }] });
        }
        if (url.hostname === 'dual.example.com' && url.pathname === '/v1/models') {
          return jsonResponse({ object: 'list', data: [{ id: 'gpt-4o', supported_endpoints: ['/chat/completions'] }] });
        }
        throw new Error(`Unhandled fetch ${request.url}`);
      },
      async () => {
        const catalog = (await getModelsFromProviders(await listModelProviders(null), () => directFetcher, testScheduler)).models;
        assertEquals([...catalog.map(m => m.id)].sort(), ['gpt-4o', 'or/gpt-4o']);

        // Both upstreams enumerate against the bare id: up_plain via its only
        // form, up_dual via its unprefixed-addressable branch. Order follows
        // the configured sort_order across providers.
        const bare = await enumerateModelCandidates({ upstreamIds: null, model: 'gpt-4o', kind: 'chat', scheduler: testScheduler, runtimeLocation: 'TEST' });
        assertEquals(bare.candidates.map(m => m.provider.upstreamId), ['up_plain', 'up_dual']);

        // The prefixed id resolves only against up_dual: up_plain's catalog
        // does not contain `or/gpt-4o`, and up_dual's prefix-stripped lookup
        // hits its catalog's bare `gpt-4o`.
        const prefixed = await enumerateModelCandidates({ upstreamIds: null, model: 'or/gpt-4o', kind: 'chat', scheduler: testScheduler, runtimeLocation: 'TEST' });
        assertEquals(prefixed.candidates.map(m => m.provider.upstreamId), ['up_dual']);
      },
    );
  });

  test('dual-addressable upstream whose catalog literally lists both forms yields two candidates from one upstream', async () => {
    // up_dual is `addressable: ['unprefixed', 'prefixed']` AND its catalog
    // publishes both `gpt-4o` and `or/gpt-4o` as distinct entries. An
    // inbound `or/gpt-4o` triggers BOTH branches at the same upstream:
    // - unprefixed branch looks up `or/gpt-4o` → hits the literal `or/gpt-4o`
    //   catalog entry
    // - prefixed branch looks up `gpt-4o` (after strip) → hits the `gpt-4o`
    //   catalog entry
    // Both produce a candidate — no deduplication; the unprefixed branch
    // pushes first, matching `cfg.addressable`'s `unprefixed`-before-
    // `prefixed` iteration order (see `FORM_ORDER` in `model-prefix.ts`).
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(buildCustomUpstreamRecord({
      id: 'up_dual',
      sortOrder: 1,
      config: { baseUrl: 'https://dual.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { chatCompletions: {} } },
      modelPrefix: { prefix: 'or/', addressable: ['unprefixed', 'prefixed'], listed: ['unprefixed', 'prefixed'] },
    }));

    await withMockedFetch(
      request => {
        const url = new URL(request.url);
        if (url.hostname === 'dual.example.com' && url.pathname === '/v1/models') {
          return jsonResponse({
            object: 'list',
            data: [
              { id: 'gpt-4o', supported_endpoints: ['/chat/completions'] },
              { id: 'or/gpt-4o', supported_endpoints: ['/chat/completions'] },
            ],
          });
        }
        throw new Error(`Unhandled fetch ${request.url}`);
      },
      async () => {
        const resolved = await enumerateModelCandidates({ upstreamIds: null, model: 'or/gpt-4o', kind: 'chat', scheduler: testScheduler, runtimeLocation: 'TEST' });
        assertEquals(resolved.candidates.length, 2);
        assertEquals(resolved.candidates.map(c => c.provider.upstreamId), ['up_dual', 'up_dual']);
        // The unprefixed branch hits the `or/gpt-4o` literal entry first;
        // the prefixed branch's strip hits the bare `gpt-4o` entry.
        assertEquals(resolved.candidates.map(c => c.model.id), ['or/gpt-4o', 'gpt-4o']);
      },
    );
  });

  test('disabledPublicModelIds hides both bare and prefixed forms from the originating upstream', async () => {
    // up_dual exposes `gpt-4o` and `gpt-mini` under both forms, but the
    // operator disabled `gpt-4o` on this upstream. Neither `gpt-4o` nor
    // `or/gpt-4o` survives from up_dual; `gpt-mini` and `or/gpt-mini` stay.
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(buildCustomUpstreamRecord({
      id: 'up_dual',
      sortOrder: 1,
      config: { baseUrl: 'https://dual.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { chatCompletions: {} } },
      modelPrefix: { prefix: 'or/', addressable: ['unprefixed', 'prefixed'], listed: ['unprefixed', 'prefixed'] },
      disabledPublicModelIds: ['gpt-4o'],
    }));

    await withMockedFetch(
      request => {
        const url = new URL(request.url);
        if (url.hostname === 'dual.example.com' && url.pathname === '/v1/models') {
          return jsonResponse({
            object: 'list',
            data: [
              { id: 'gpt-4o', supported_endpoints: ['/chat/completions'] },
              { id: 'gpt-mini', supported_endpoints: ['/chat/completions'] },
            ],
          });
        }
        throw new Error(`Unhandled fetch ${request.url}`);
      },
      async () => {
        const catalog = (await getModelsFromProviders(await listModelProviders(null), () => directFetcher, testScheduler)).models;
        assertEquals([...catalog.map(m => m.id)].sort(), ['gpt-mini', 'or/gpt-mini']);
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
    await repo.upstreams.save(buildCustomUpstreamRecord({
      id: 'up_short_prefix',
      sortOrder: 1,
      config: { baseUrl: 'https://short.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { chatCompletions: {} } },
      modelPrefix: { prefix: 'aa/', addressable: ['prefixed'], listed: ['prefixed'] },
    }));
    await repo.upstreams.save(buildCustomUpstreamRecord({
      id: 'up_long_prefix',
      sortOrder: 2,
      config: { baseUrl: 'https://long.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { chatCompletions: {} } },
      modelPrefix: { prefix: 'aa/bb/', addressable: ['prefixed'], listed: ['prefixed'] },
    }));
    await repo.upstreams.save(buildCustomUpstreamRecord({
      id: 'up_bare',
      sortOrder: 3,
      config: { baseUrl: 'https://bare.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { chatCompletions: {} } },
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
        const resolved = await enumerateModelCandidates({ upstreamIds: null, model: 'aa/bb/gpt-5', kind: 'chat', scheduler: testScheduler, runtimeLocation: 'TEST' });
        assertEquals(resolved.candidates.map(m => m.provider.upstreamId), ['up_short_prefix', 'up_long_prefix', 'up_bare']);
        assertEquals(resolved.candidates.map(m => m.model.id), ['bb/gpt-5', 'gpt-5', 'aa/bb/gpt-5']);
      },
    );
  });
});
