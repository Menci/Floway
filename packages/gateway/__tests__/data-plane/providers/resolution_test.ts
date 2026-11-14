import { describe, expect, test, vi } from 'vitest';

import { listModelProviders } from '../../../src/data-plane/providers/registry.ts';
import { enumerateModelCandidates as enumerateModelCandidatesRaw, enumerateRealModelCandidates as enumerateRealModelCandidatesRaw } from '../../../src/data-plane/providers/resolution.ts';
import { createModelsRefreshScheduler, modelsRefreshTarget, refreshModelsExplicit } from '../../../src/execution/models-refresh.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, setupAppTest, testAdminUser, warmModelsForTest } from '../../test-utils/app.ts';
import { directFetcher, type InternalModel, type ProviderModel } from '@floway-dev/provider';
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

const testScheduler = (promise: Promise<unknown>): void => {
  promise.catch(err => console.error('[background]', err));
};
const scheduleRefresh = createModelsRefreshScheduler('TEST', testScheduler);
const enumerateModelCandidates = (
  input: Omit<Parameters<typeof enumerateModelCandidatesRaw>[0], 'subject'>,
) => enumerateModelCandidatesRaw({ subject: testAdminUser, ...input });
const enumerateRealModelCandidates = (
  ...args: Parameters<typeof enumerateRealModelCandidatesRaw> extends [unknown, ...infer Rest] ? Rest : never
) => enumerateRealModelCandidatesRaw(testAdminUser, ...args);

test('a cold candidate read schedules refresh without waiting for upstream I/O', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord());
  const background: Promise<unknown>[] = [];
  let releaseFetch: ((response: Response) => void) | undefined;
  const fetch = vi.fn(() => new Promise<Response>(resolve => { releaseFetch = resolve; }));

  await withMockedFetchRaw(
    fetch,
    async () => {
      const result = await enumerateModelCandidates({
        upstreamIds: null,
        randomizeUpstreams: false,
        model: 'eventual-model',
        kind: 'chat',
        scheduler: promise => { background.push(promise); },
        runtimeLocation: 'TEST',
      });
      expect(result.candidates).toEqual([]);
      expect(background).toHaveLength(1);
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      releaseFetch!(jsonResponse({ object: 'list', data: [{ id: 'eventual-model' }] }));
      await Promise.all(background);
    },
  );

  expect(fetch).toHaveBeenCalledOnce();
  expect((await repo.upstreams.getById('up_custom'))?.modelsCache).toMatchObject({
    lastError: null,
    models: [{ id: 'eventual-model' }],
  });
});

test('enumerateModelCandidates shares one upstream snapshot across providers and dialers', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord());

  await withMockedFetch(
    () => jsonResponse({ object: 'list', data: [{ id: 'shared-model' }] }),
    async () => {
      const list = vi.spyOn(repo.upstreams, 'list');
      const resolved = await enumerateModelCandidates({
        upstreamIds: null,
        randomizeUpstreams: false,
        model: 'shared-model',
        kind: 'chat',
        scheduler: testScheduler,
        runtimeLocation: 'TEST',
      });

      expect(list).toHaveBeenCalledOnce();
      assertEquals(resolved.candidates.map(candidate => candidate.model.id), ['shared-model']);
    },
  );
});

test('scheduler registration failures propagate rather than looking like an upstream model-list failure', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    config: { baseUrl: 'https://custom.example.com', authStyle: 'none', endpoints: { openaiChatCompletions: {} }, ingressHeadersRules: [], modelsFetch: { enabled: false }, models: [] },
  }));
  const providers = await listModelProviders(null);
  await expect(enumerateRealModelCandidates('model', 'chat', providers, {
    fetcherForUpstream: () => directFetcher,
    randomizeUpstreams: false,
    scheduleRefresh: () => { throw new Error('scheduler unavailable'); },
  })).rejects.toThrow('scheduler unavailable');
});

test('enumerateRealModelCandidates only loads the selected providers\' catalogs', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_first',
    name: 'First',
    sortOrder: 0,
    config: { baseUrl: 'https://first.example.com', authStyle: 'bearer', apiKey: 'sk-first', endpoints: { openaiResponses: {} }, ingressHeadersRules: [] },
  }));
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_second',
    name: 'Second',
    sortOrder: 100,
    config: { baseUrl: 'https://second.example.com', authStyle: 'bearer', apiKey: 'sk-second', endpoints: { openaiResponses: {} }, ingressHeadersRules: [] },
  }));

  const providers = await listModelProviders(null);
  let secondModelsFetches = 0;

  await withMockedFetchRaw(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'first.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ data: [{ id: 'target-model' }] });
      }
      if (url.hostname === 'second.example.com' && url.pathname === '/v1/models') {
        secondModelsFetches++;
        return jsonResponse({ data: [{ id: 'target-model' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const first = await repo.upstreams.getById(providers[0].upstreamId);
      if (first === null) throw new Error('first upstream missing');
      await refreshModelsExplicit(modelsRefreshTarget(first), 'TEST');
      const warmed = (await listModelProviders(null)).find(provider => provider.upstreamId === 'up_first');
      if (!warmed) throw new Error('warmed provider missing');
      const { candidates } = await enumerateRealModelCandidates('target-model', 'chat', [warmed], { fetcherForUpstream: () => directFetcher, randomizeUpstreams: false, scheduleRefresh });

      assertEquals(candidates[0]?.model.id, 'target-model');
      assertEquals(candidates[0]?.provider.upstreamId, 'up_first');
      expect(candidates[0]?.fetcher).toBe(directFetcher);
      // Every enumerated candidate seeds `providerModels[provider.upstreamId]`
      // so `providerModelOf(candidate)` resolves at dispatch time.
      assertEquals(Object.keys(realProviderModels(candidates[0]?.model)), ['up_first']);
    },
  );

  assertEquals(secondModelsFetches, 0);
});

test('enumerateRealModelCandidates rejects a model id disabled on that upstream (filter parity with the catalog)', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, {
    id: 'up_x',
    kind: 'azure',
    name: 'X',
    enabled: true,
    usageRefreshIntervalMinutes: 0,
    sortOrder: 1,
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
    config: {
      endpoint: 'https://example.openai.azure.com',
      apiKey: 'az-key',
      models: [
        { upstreamModelId: 'enabled-model', endpoints: { openaiChatCompletions: {} } },
        { upstreamModelId: 'disabled-model', endpoints: { openaiChatCompletions: {} } },
      ],
    },
    flagOverrides: {},
    disabledPublicModelIds: ['disabled-model'],
    proxyFallbackList: [],
    modelPrefix: null,
    modelsCache: null,
    hue: 210,
    state: null,
  });

  await warmModelsForTest();
  const providers = await listModelProviders(null);
  const enabled = await enumerateRealModelCandidates('enabled-model', 'chat', providers, { fetcherForUpstream: () => directFetcher, randomizeUpstreams: false, scheduleRefresh });
  const disabled = await enumerateRealModelCandidates('disabled-model', 'chat', providers, { fetcherForUpstream: () => directFetcher, randomizeUpstreams: false, scheduleRefresh });
  assertEquals(enabled.candidates[0]?.model.id, 'enabled-model');
  assertEquals(disabled.candidates.length, 0);
});

test('randomizes upstream candidate groups without splitting or reordering a group', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  for (const [id, name, sortOrder] of [['up_a', 'A', 1], ['up_b', 'B', 2]] as const) {
    await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
      id,
      name,
      sortOrder,
      config: { baseUrl: `https://${name.toLowerCase()}.example.com`, authStyle: 'bearer', apiKey: `sk-${name.toLowerCase()}`, endpoints: { openaiChatCompletions: {} }, ingressHeadersRules: [] },
      modelPrefix: { prefix: 'or/', addressable: ['unprefixed', 'prefixed'], listed: ['unprefixed', 'prefixed'] },
    }));
  }

  await withMockedFetch(
    request => {
      const hostname = new URL(request.url).hostname;
      if (hostname === 'a.example.com' || hostname === 'b.example.com') {
        return jsonResponse({ object: 'list', data: [{ id: 'or/gpt-4o' }, { id: 'gpt-4o' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const random = vi.spyOn(Math, 'random').mockReturnValue(0);
      try {
        const resolved = await enumerateModelCandidates({
          upstreamIds: null,
          randomizeUpstreams: true,
          model: 'or/gpt-4o',
          kind: 'chat',
          scheduler: testScheduler,
          runtimeLocation: 'TEST',
        });
        assertEquals(
          resolved.candidates.map(candidate => `${candidate.model.id}@${candidate.provider.upstreamId}`),
          ['or/gpt-4o@up_b', 'gpt-4o@up_b', 'or/gpt-4o@up_a', 'gpt-4o@up_a'],
        );
        expect(random).toHaveBeenCalledOnce();
      } finally {
        random.mockRestore();
      }
    },
  );
});

test('a recorded refresh failure is irrelevant when the prefix policy cannot address the model id', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_prefixed_failure',
    name: 'Prefixed failure',
    modelPrefix: { prefix: 'tenant/', addressable: ['prefixed'], listed: ['prefixed'] },
    config: { baseUrl: 'https://prefixed-failure.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { openaiChatCompletions: {} }, ingressHeadersRules: [] },
  }));

  await withMockedFetch(
    request => {
      if (new URL(request.url).hostname === 'prefixed-failure.example.com') return jsonResponse({ error: 'down' }, 502);
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resolved = await enumerateModelCandidates({
        upstreamIds: null,
        randomizeUpstreams: false,
        model: 'unprefixed-model',
        kind: 'chat',
        scheduler: testScheduler,
        runtimeLocation: 'TEST',
      });
      expect(resolved.failedUpstreams).toEqual([]);
    },
  );
});

// A persisted refresh error must not hide healthy siblings. The broken
// upstream's display name flows back via `failedUpstreams` while its empty
// or last-known-good snapshot stays independent of the current request.
test('enumerateModelCandidates: healthy upstream still resolves alongside a rejecting one, with failedUpstreams reported', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();

  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_broken',
    name: 'Broken upstream',
    sortOrder: 1,
    config: { baseUrl: 'https://broken.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { openaiChatCompletions: {} }, ingressHeadersRules: [] },
  }));
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_ok',
    name: 'Healthy upstream',
    sortOrder: 2,
    config: { baseUrl: 'https://ok.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { openaiChatCompletions: {} }, ingressHeadersRules: [] },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'broken.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ error: 'upstream went down' }, 502);
      }
      if (url.hostname === 'ok.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'ok-model', supported_endpoints: ['/chat/completions'] }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resolvedExisting = await enumerateModelCandidates({ upstreamIds: null, randomizeUpstreams: false, model: 'ok-model', kind: 'chat', scheduler: testScheduler, runtimeLocation: 'TEST' });
      assertEquals(resolvedExisting.candidates.map(m => m.provider.upstreamId), ['up_ok']);
      assertEquals(resolvedExisting.candidates[0]?.model.id, 'ok-model');
      assertEquals(resolvedExisting.failedUpstreams, ['Broken upstream']);

      // A model nobody currently knows about must NOT rethrow the broken
      // upstream's catalog error — the caller's failure renderer is the right
      // place to surface that, parenthetically, alongside the model-missing
      // body.
      const resolvedMissing = await enumerateModelCandidates({ upstreamIds: null, randomizeUpstreams: false, model: 'unknown-model', kind: 'chat', scheduler: testScheduler, runtimeLocation: 'TEST' });
      assertEquals(resolvedMissing.candidates.length, 0);
      assertEquals(resolvedMissing.failedUpstreams, ['Broken upstream']);
    },
  );
});

// Resolution is a single catalog exact-match. A client that pins a vendor release
// date (`claude-opus-4-7-20251231`) addresses an id no upstream publishes, and
// that must surface as model-missing instead of silently retrying the bare id.
test('enumerateModelCandidates does not strip a -YYYYMMDD suffix the catalog does not list', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_dated',
    name: 'Dated',
    sortOrder: 1,
    config: { baseUrl: 'https://dated.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { anthropicMessages: {} }, ingressHeadersRules: [] },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'dated.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'claude-opus-4-7' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resolved = await enumerateModelCandidates({
        upstreamIds: null,
        randomizeUpstreams: false,
        model: 'claude-opus-4-7-20251231',
        kind: 'chat',
        scheduler: testScheduler,
        runtimeLocation: 'TEST',
      });
      assertEquals(resolved.candidates, []);
      assertEquals(resolved.sawModel, false);
    },
  );
});

// A wrong-kind match yields `sawModel=true, candidates=[]`: the id is known to
// the upstream but under a different kind, which the failure renderer surfaces
// as "model unsupported" rather than "model missing".
test('enumerateModelCandidates reports sawModel for a wrong-kind catalog match', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_chat_only',
    name: 'ChatOnly',
    sortOrder: 1,
    config: { baseUrl: 'https://chatonly.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { openaiChatCompletions: {} }, ingressHeadersRules: [] },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'chatonly.example.com' && url.pathname === '/v1/models') {
        // The dated form is literally present in the catalog (chat-kind).
        return jsonResponse({ object: 'list', data: [{ id: 'claude-opus-4-7-20251231', supported_endpoints: ['/chat/completions'] }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resolved = await enumerateModelCandidates({
        upstreamIds: null,
        randomizeUpstreams: false,
        model: 'claude-opus-4-7-20251231',
        kind: 'image',
        scheduler: testScheduler,
        runtimeLocation: 'TEST',
      });
      assertEquals(resolved.candidates, []);
      assertEquals(resolved.sawModel, true);
      assertEquals(resolved.failedUpstreams, []);
    },
  );
});

test('an AbortError from background catalog refresh does not abort model resolution', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_aborting',
    name: 'Aborting',
    sortOrder: 1,
    config: { baseUrl: 'https://aborting.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { openaiChatCompletions: {} }, ingressHeadersRules: [] },
  }));

  const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'aborting.example.com' && url.pathname === '/v1/models') {
        throw abortError;
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resolved = await enumerateModelCandidates({
        upstreamIds: null,
        randomizeUpstreams: false,
        model: 'any-model',
        kind: 'chat',
        scheduler: testScheduler,
        runtimeLocation: 'TEST',
      });
      expect(resolved.candidates).toEqual([]);
      expect(resolved.failedUpstreams).toEqual(['Aborting']);
    },
  );
});

// Empty visible upstream list: a caller cap pinned to an empty set yields
// `{candidates: [], sawModel: false, failedUpstreams: []}` without any
// upstream fetch. The failure renderer surfaces this as a model-missing 404
// without re-deriving the empty-cap branch.
test('enumerateModelCandidates returns the empty triple when the visible upstream list is empty', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  // A populated catalog is the case under test: the empty cap, not an empty
  // catalog, is what yields the empty triple.
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({ id: 'up_a', name: 'A', sortOrder: 1 }));

  const resolved = await enumerateModelCandidates({
    upstreamIds: [],
    randomizeUpstreams: false,
    model: 'any-model',
    kind: 'chat',
    scheduler: testScheduler,
    runtimeLocation: 'TEST',
  });
  assertEquals(resolved.candidates, []);
  assertEquals(resolved.sawModel, false);
  assertEquals(resolved.failedUpstreams, []);
});

// The alias walk visits every target, tags each real-catalog candidate
// with that target's rule overlay, flattens across targets in `selection`
// order, and dedups by (model, upstream, rules). Two targets pointing at
// the same real model with the same rules collapse; the same pair with
// distinct rules stays as two candidates so both can be attempted.
describe('enumerateModelCandidates alias walk (flat + dedup)', () => {
  const aliasCommon = {
    displayName: null,
    visibleInModelsList: true,
    announcedMetadata: null,
    sortOrder: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as const;

  const buildCatalogFetch = (byModel: Record<string, readonly string[]>) => (request: Request): Response => {
    const url = new URL(request.url);
    if (url.hostname === 'a.example.com' && url.pathname === '/v1/models') {
      return jsonResponse({ object: 'list', data: byModel.up_a.map(id => ({ id })) });
    }
    if (url.hostname === 'b.example.com' && url.pathname === '/v1/models') {
      return jsonResponse({ object: 'list', data: byModel.up_b.map(id => ({ id })) });
    }
    throw new Error(`Unhandled fetch ${request.url}`);
  };

  const seedUpstreams = async (repo: Awaited<ReturnType<typeof setupAppTest>>['repo']): Promise<void> => {
    await repo.upstreams.deleteAll();
    await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
      id: 'up_a', name: 'A', sortOrder: 1,
      config: { baseUrl: 'https://a.example.com', authStyle: 'bearer', apiKey: 'sk-a', endpoints: { openaiChatCompletions: {} }, ingressHeadersRules: [] },
    }));
    await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
      id: 'up_b', name: 'B', sortOrder: 2,
      config: { baseUrl: 'https://b.example.com', authStyle: 'bearer', apiKey: 'sk-b', endpoints: { openaiChatCompletions: {} }, ingressHeadersRules: [] },
    }));
  };

  test('flattens across targets in declaration order for first-available', async () => {
    const { repo } = await setupAppTest();
    await seedUpstreams(repo);
    await repo.modelAliases.insert({
      id: 'alias_smart',
      name: 'smart', kind: 'chat', selection: 'first-available',
      targets: [
        { target_model_id: 'gpt-5', rules: {} },
        { target_model_id: 'claude', rules: {} },
      ],
      ...aliasCommon,
    });

    await withMockedFetch(
      buildCatalogFetch({ up_a: ['gpt-5'], up_b: ['claude'] }),
      async () => {
        const resolved = await enumerateModelCandidates({
          upstreamIds: null, randomizeUpstreams: false, model: 'smart', kind: 'chat', scheduler: testScheduler, runtimeLocation: 'TEST',
        });
        assertEquals(
          resolved.candidates.map(c => `${c.model.id}@${c.provider.upstreamId}`),
          ['gpt-5@up_a', 'claude@up_b'],
        );
      },
    );
  });

  test('shuffles the outer walk for random selection but keeps intra-target order', async () => {
    const { repo } = await setupAppTest();
    await seedUpstreams(repo);
    await repo.modelAliases.insert({
      id: 'alias_random-alias',
      name: 'random-alias', kind: 'chat', selection: 'random',
      targets: [
        { target_model_id: 'gpt-5', rules: {} },
        { target_model_id: 'claude', rules: {} },
      ],
      ...aliasCommon,
    });

    await withMockedFetch(
      buildCatalogFetch({ up_a: ['gpt-5', 'claude'], up_b: ['gpt-5', 'claude'] }),
      async () => {
        const resolved = await enumerateModelCandidates({
          upstreamIds: null, randomizeUpstreams: false, model: 'random-alias', kind: 'chat', scheduler: testScheduler, runtimeLocation: 'TEST',
        });
        // Each target contributes two candidates (up_a before up_b, the
        // configured sort order). The two two-candidate blocks stay together
        // regardless of the outer shuffle.
        const grouped = [resolved.candidates.slice(0, 2), resolved.candidates.slice(2, 4)];
        for (const block of grouped) {
          expect(block.map(c => c.provider.upstreamId)).toEqual(['up_a', 'up_b']);
        }
        const targetOrder = grouped.map(block => block[0]?.model.id);
        expect(new Set(targetOrder)).toEqual(new Set(['gpt-5', 'claude']));
      },
    );
  });

  test('randomizes upstream groups independently for each random alias target', async () => {
    const { repo } = await setupAppTest();
    await seedUpstreams(repo);
    await repo.modelAliases.insert({
      id: 'alias_random-both',
      name: 'random-both', kind: 'chat', selection: 'random',
      targets: [
        { target_model_id: 'gpt-5', rules: {} },
        { target_model_id: 'claude', rules: {} },
      ],
      ...aliasCommon,
    });

    await withMockedFetch(
      buildCatalogFetch({ up_a: ['gpt-5', 'claude'], up_b: ['gpt-5', 'claude'] }),
      async () => {
        const random = vi.spyOn(Math, 'random')
          .mockReturnValueOnce(0)
          .mockReturnValueOnce(0.999)
          .mockReturnValueOnce(0);
        try {
          const resolved = await enumerateModelCandidates({
            upstreamIds: null, randomizeUpstreams: true, model: 'random-both', kind: 'chat', scheduler: testScheduler, runtimeLocation: 'TEST',
          });
          expect(resolved.candidates.map(candidate => `${candidate.model.id}@${candidate.provider.upstreamId}`)).toEqual([
            'claude@up_a',
            'claude@up_b',
            'gpt-5@up_b',
            'gpt-5@up_a',
          ]);
          expect(random).toHaveBeenCalledTimes(3);
        } finally {
          random.mockRestore();
        }
      },
    );
  });

  test('dedups (model, upstream, rules) when two targets hit the same binding with identical rules', async () => {
    const { repo } = await setupAppTest();
    await seedUpstreams(repo);
    await repo.modelAliases.insert({
      id: 'alias_dup-alias',
      name: 'dup-alias', kind: 'chat', selection: 'first-available',
      targets: [
        { target_model_id: 'gpt-5', rules: { reasoning: { effort: 'low' } } },
        { target_model_id: 'gpt-5', rules: { reasoning: { effort: 'low' } } },
      ],
      ...aliasCommon,
    });

    await withMockedFetch(
      buildCatalogFetch({ up_a: ['gpt-5'], up_b: [] }),
      async () => {
        const resolved = await enumerateModelCandidates({
          upstreamIds: null, randomizeUpstreams: false, model: 'dup-alias', kind: 'chat', scheduler: testScheduler, runtimeLocation: 'TEST',
        });
        assertEquals(resolved.candidates.length, 1);
        assertEquals(resolved.candidates[0]!.model.id, 'gpt-5');
        assertEquals(resolved.candidates[0]!.provider.upstreamId, 'up_a');
      },
    );
  });

  test('keeps the first representative in its original position when duplicate bindings are interleaved', async () => {
    const { repo } = await setupAppTest();
    await seedUpstreams(repo);
    await repo.modelAliases.insert({
      id: 'alias_interleaved-duplicates',
      name: 'interleaved-duplicates', kind: 'chat', selection: 'first-available',
      targets: [
        { target_model_id: 'gpt-5', rules: { reasoning: { effort: 'low' } } },
        { target_model_id: 'claude', rules: { reasoning: { effort: 'high' } } },
        { target_model_id: 'gpt-5', rules: { reasoning: { effort: 'low' } } },
      ],
      ...aliasCommon,
    });

    await withMockedFetch(
      buildCatalogFetch({ up_a: ['gpt-5'], up_b: ['claude'] }),
      async () => {
        const resolved = await enumerateModelCandidates({
          upstreamIds: null, randomizeUpstreams: false, model: 'interleaved-duplicates', kind: 'chat', scheduler: testScheduler, runtimeLocation: 'TEST',
        });
        expect(resolved.candidates.map(candidate => ({
          binding: `${candidate.model.id}@${candidate.provider.upstreamId}`,
          effort: candidate.rules?.reasoning?.effort,
        }))).toEqual([
          { binding: 'gpt-5@up_a', effort: 'low' },
          { binding: 'claude@up_b', effort: 'high' },
        ]);
      },
    );
  });

  test('keeps two entries for the same (model, upstream) with distinct rules', async () => {
    const { repo } = await setupAppTest();
    await seedUpstreams(repo);
    await repo.modelAliases.insert({
      id: 'alias_two-rules',
      name: 'two-rules', kind: 'chat', selection: 'first-available',
      targets: [
        { target_model_id: 'gpt-5', rules: { reasoning: { effort: 'low' } } },
        { target_model_id: 'gpt-5', rules: { reasoning: { effort: 'high' } } },
      ],
      ...aliasCommon,
    });

    await withMockedFetch(
      buildCatalogFetch({ up_a: ['gpt-5'], up_b: [] }),
      async () => {
        const resolved = await enumerateModelCandidates({
          upstreamIds: null, randomizeUpstreams: false, model: 'two-rules', kind: 'chat', scheduler: testScheduler, runtimeLocation: 'TEST',
        });
        assertEquals(resolved.candidates.length, 2);
        expect(resolved.candidates.map(c => c.rules?.reasoning?.effort)).toEqual(['low', 'high']);
      },
    );
  });

  test('falls through to a later target when an earlier one has no kind-matching binding', async () => {
    const { repo } = await setupAppTest();
    await seedUpstreams(repo);
    await repo.modelAliases.insert({
      id: 'alias_fallback',
      name: 'fallback', kind: 'chat', selection: 'first-available',
      targets: [
        { target_model_id: 'missing', rules: { verbosity: 'low' } },
        { target_model_id: 'gpt-5', rules: { verbosity: 'high' } },
      ],
      ...aliasCommon,
    });

    await withMockedFetch(
      buildCatalogFetch({ up_a: ['gpt-5'], up_b: [] }),
      async () => {
        const resolved = await enumerateModelCandidates({
          upstreamIds: null, randomizeUpstreams: false, model: 'fallback', kind: 'chat', scheduler: testScheduler, runtimeLocation: 'TEST',
        });
        // The `missing` target contributes nothing; the `gpt-5` target
        // contributes one candidate carrying its own rule overlay.
        assertEquals(resolved.candidates.length, 1);
        assertEquals(resolved.candidates[0]!.rules?.verbosity, 'high');
      },
    );
  });
});
