import { describe, expect, test, vi } from 'vitest';

import { listModelProviders } from '../../../src/data-plane/providers/registry.ts';
import { enumerateModelCandidates, enumerateRealModelCandidates } from '../../../src/data-plane/providers/resolution.ts';
import { modelsRefreshTarget, refreshModels } from '../../../src/execution/models-refresh.ts';
import { buildCustomUpstreamRecord, copilotModels, setupAppTest, warmModelsForTest } from '../../test-utils/app.ts';
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

test('enumerateModelCandidates blocks a cold catalog fetch after client disconnect', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save(buildCustomUpstreamRecord({
    config: {
      baseUrl: 'https://custom.example.com',
      authStyle: 'bearer',
      ingressHeadersRules: [],
      apiKey: 'sk-custom',
      endpoints: { messages: {} },
    },
  }));
  const controller = new AbortController();
  const reason = new Error('client disconnected');
  controller.abort(reason);
  let fetches = 0;

  await withMockedFetchRaw(
    () => {
      fetches += 1;
      return jsonResponse({ object: 'list', data: [] });
    },
    async () => {
      let caught: unknown;
      try {
        await enumerateModelCandidates({
          upstreamIds: null,
          model: 'gpt-test',
          kind: 'chat',
          scheduler: testScheduler,
          runtimeLocation: 'TEST',
          clientDisconnectSignal: controller.signal,
        });
      } catch (error) {
        caught = error;
      }
      assertEquals(caught, reason);
      assertEquals(fetches, 0);
    },
  );
});

test('a scheduled cold refresh survives disconnect after execution starts', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save(buildCustomUpstreamRecord());
  const originalBegin = repo.upstreams.beginModelsRefresh.bind(repo.upstreams);
  let releaseBegin: (() => void) | null = null;
  vi.spyOn(repo.upstreams, 'beginModelsRefresh').mockImplementation(async input => {
    await new Promise<void>(resolve => { releaseBegin = resolve; });
    return await originalBegin(input);
  });
  const controller = new AbortController();
  const background: Promise<unknown>[] = [];
  let fetches = 0;

  await withMockedFetchRaw(
    () => {
      fetches++;
      return jsonResponse({ object: 'list', data: [{ id: 'eventual-model' }] });
    },
    async () => {
      await enumerateModelCandidates({
        upstreamIds: null,
        model: 'eventual-model',
        kind: 'chat',
        scheduler: promise => { background.push(promise); },
        runtimeLocation: 'TEST',
        clientDisconnectSignal: controller.signal,
      });
      await vi.waitFor(() => expect(releaseBegin).not.toBeNull());
      controller.abort(new Error('client disconnected'));
      releaseBegin!();
      await Promise.all(background);
    },
  );

  expect(fetches).toBe(1);
  expect((await repo.upstreams.getById('up_custom'))?.modelsCache).toMatchObject({
    lastError: null,
    models: [{ id: 'eventual-model' }],
  });
});

test('enumerateModelCandidates strips an -YYYYMMDD suffix when nothing matched and retries across every visible upstream', async () => {
  const { repo } = await setupAppTest();

  await repo.upstreams.save(
    buildCustomUpstreamRecord({
      config: {
        baseUrl: 'https://custom.example.com',
        authStyle: 'bearer',
        ingressHeadersRules: [],
        apiKey: 'sk-custom',
        endpoints: { messages: {} },
      },
    }),
  );

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
        return jsonResponse(copilotModels([{ id: 'claude-opus-4.7', supported_endpoints: ['/v1/messages'] }]));
      }
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({
          object: 'list',
          data: [{ id: 'claude-opus-4-7' }],
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resolved = await enumerateModelCandidates({ upstreamIds: null, model: 'claude-opus-4-7-20300101', kind: 'chat', scheduler: testScheduler, runtimeLocation: 'TEST' });

      // No upstream's catalog literally lists `claude-opus-4-7-20300101`,
      // so the resolver retries against the stripped `claude-opus-4-7`,
      // which both upstreams expose. Both candidates end up in the match
      // list in configured `sort_order`.
      assertEquals(resolved.candidates.map(m => m.provider.upstreamId).sort(), ['up_copilot', 'up_custom'].sort());
      assertEquals(resolved.candidates.map(m => m.model.id), ['claude-opus-4-7', 'claude-opus-4-7']);
    },
  );
});

test('enumerateModelCandidates does not retry when the inbound id has no dated suffix', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save(
    buildCustomUpstreamRecord({
      config: {
        baseUrl: 'https://custom.example.com',
        authStyle: 'bearer',
        ingressHeadersRules: [],
        apiKey: 'sk-custom',
        endpoints: { messages: {} },
      },
    }),
  );

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'claude-opus-4-7' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      // Plain typo / unknown id — no dated suffix, no retry.
      const resolved = await enumerateModelCandidates({ upstreamIds: null, model: 'claude-opus-4-7-unknown', kind: 'chat', scheduler: testScheduler, runtimeLocation: 'TEST' });
      assertEquals(resolved.candidates.length, 0);
    },
  );
});

test('enumerateModelCandidates prefers the literal dated id over the stripped base when the catalog lists both', async () => {
  // The dated-suffix retry is a SECOND attempt, gated on the first
  // attempt finding nothing. When the upstream catalog already lists the
  // dated id verbatim, the first attempt wins and the stripped form
  // never enters the candidate list.
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save(
    buildCustomUpstreamRecord({
      config: {
        baseUrl: 'https://custom.example.com',
        authStyle: 'bearer',
        ingressHeadersRules: [],
        apiKey: 'sk-custom',
        endpoints: { messages: {} },
      },
    }),
  );

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({
          object: 'list',
          data: [
            { id: 'claude-sonnet-4-5' },
            { id: 'claude-sonnet-4-5-20251101' },
          ],
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resolved = await enumerateModelCandidates({ upstreamIds: null, model: 'claude-sonnet-4-5-20251101', kind: 'chat', scheduler: testScheduler, runtimeLocation: 'TEST' });
      assertEquals(resolved.candidates.length, 1);
      assertEquals(resolved.candidates[0]?.model.id, 'claude-sonnet-4-5-20251101');
    },
  );
});

test('enumerateRealModelCandidates only loads the selected providers\' catalogs', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_first',
    name: 'First',
    sortOrder: 0,
    config: { baseUrl: 'https://first.example.com', authStyle: 'bearer', apiKey: 'sk-first', endpoints: { responses: {} }, ingressHeadersRules: [] },
  }));
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_second',
    name: 'Second',
    sortOrder: 100,
    config: { baseUrl: 'https://second.example.com', authStyle: 'bearer', apiKey: 'sk-second', endpoints: { responses: {} }, ingressHeadersRules: [] },
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
      await refreshModels(modelsRefreshTarget(first), 'TEST', { bypassBackoff: true, includeDiscovered: false });
      const warmed = (await listModelProviders(null)).find(provider => provider.upstreamId === 'up_first');
      if (!warmed) throw new Error('warmed provider missing');
      const { candidates } = await enumerateRealModelCandidates('target-model', 'chat', [warmed], { fetcherForUpstream: () => directFetcher, scheduler: testScheduler, runtimeLocation: 'TEST' });

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
  await repo.upstreams.save({
    id: 'up_x',
    kind: 'azure',
    name: 'X',
    enabled: true,
    sortOrder: 1,
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
    config: {
      endpoint: 'https://example.openai.azure.com',
      apiKey: 'az-key',
      models: [
        { upstreamModelId: 'enabled-model', endpoints: { chatCompletions: {} } },
        { upstreamModelId: 'disabled-model', endpoints: { chatCompletions: {} } },
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
  const enabled = await enumerateRealModelCandidates('enabled-model', 'chat', providers, { fetcherForUpstream: () => directFetcher, scheduler: testScheduler, runtimeLocation: 'TEST' });
  const disabled = await enumerateRealModelCandidates('disabled-model', 'chat', providers, { fetcherForUpstream: () => directFetcher, scheduler: testScheduler, runtimeLocation: 'TEST' });
  assertEquals(enabled.candidates[0]?.model.id, 'enabled-model');
  assertEquals(disabled.candidates.length, 0);
});

test('a recorded refresh failure is irrelevant when the prefix policy cannot address the model id', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_prefixed_failure',
    name: 'Prefixed failure',
    modelPrefix: { prefix: 'tenant/', addressable: ['prefixed'], listed: ['prefixed'] },
    config: { baseUrl: 'https://prefixed-failure.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { chatCompletions: {} }, ingressHeadersRules: [] },
  }));

  await withMockedFetch(
    request => {
      if (new URL(request.url).hostname === 'prefixed-failure.example.com') return jsonResponse({ error: 'down' }, 502);
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resolved = await enumerateModelCandidates({
        upstreamIds: null,
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

  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_broken',
    name: 'Broken upstream',
    sortOrder: 1,
    config: { baseUrl: 'https://broken.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { chatCompletions: {} }, ingressHeadersRules: [] },
  }));
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_ok',
    name: 'Healthy upstream',
    sortOrder: 2,
    config: { baseUrl: 'https://ok.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { chatCompletions: {} }, ingressHeadersRules: [] },
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
      const resolvedExisting = await enumerateModelCandidates({ upstreamIds: null, model: 'ok-model', kind: 'chat', scheduler: testScheduler, runtimeLocation: 'TEST' });
      assertEquals(resolvedExisting.candidates.map(m => m.provider.upstreamId), ['up_ok']);
      assertEquals(resolvedExisting.candidates[0]?.model.id, 'ok-model');
      assertEquals(resolvedExisting.failedUpstreams, ['Broken upstream']);

      // A model nobody currently knows about must NOT rethrow the broken
      // upstream's catalog error — the caller's failure renderer is the right
      // place to surface that, parenthetically, alongside the model-missing
      // body.
      const resolvedMissing = await enumerateModelCandidates({ upstreamIds: null, model: 'unknown-model', kind: 'chat', scheduler: testScheduler, runtimeLocation: 'TEST' });
      assertEquals(resolvedMissing.candidates.length, 0);
      assertEquals(resolvedMissing.failedUpstreams, ['Broken upstream']);
    },
  );
});

// A wrong-kind match (`sawAnyId=true, candidates=[]`) must short-circuit the
// dated-suffix retry — the suffix strip cannot turn a wrong-kind id into a
// right-kind one. The catalog carries the literal dated id as a chat model;
// requesting it with `kind: 'image'` produces sawAnyId=true on the first
// attempt, so the resolver returns immediately rather than walking the
// stripped form.
test('enumerateModelCandidates does NOT trigger the dated-suffix retry on a wrong-kind sawAnyId match', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_chat_only',
    name: 'ChatOnly',
    sortOrder: 1,
    config: { baseUrl: 'https://chatonly.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { chatCompletions: {} }, ingressHeadersRules: [] },
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
        model: 'claude-opus-4-7-20251231',
        kind: 'image',
        scheduler: testScheduler,
        runtimeLocation: 'TEST',
      });
      assertEquals(resolved.candidates, []);
      // `sawModel: true` pins that only the first attempt ran: the resolver
      // assigns `sawModel: second.sawAnyId` after retry (overwrite, not OR),
      // so a second walk against the stripped `claude-opus-4-7` (absent from
      // this fixture's catalog) would flip sawModel to false.
      assertEquals(resolved.sawModel, true);
      assertEquals(resolved.failedUpstreams, []);
    },
  );
});

// failedUpstreams across the two retry attempts must dedupe: a single broken
// upstream that rejects both walks reports its name once, not twice.
test('enumerateModelCandidates deduplicates failedUpstreams across the dated-suffix retry attempts', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_broken',
    name: 'Broken',
    sortOrder: 1,
    config: { baseUrl: 'https://broken.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { chatCompletions: {} }, ingressHeadersRules: [] },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'broken.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ error: 'upstream went down' }, 502);
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resolved = await enumerateModelCandidates({
        upstreamIds: null,
        model: 'claude-opus-4-7-20251231',
        kind: 'chat',
        scheduler: testScheduler,
        runtimeLocation: 'TEST',
      });
      assertEquals(resolved.candidates.length, 0);
      // The same broken upstream appears in both attempts' failedUpstreams;
      // the outer resolver collapses the duplicate via a Set.
      assertEquals(resolved.failedUpstreams.length, 1);
      assertEquals(resolved.failedUpstreams[0], 'Broken');
    },
  );
});

test('an AbortError from background catalog refresh does not abort model resolution', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_aborting',
    name: 'Aborting',
    sortOrder: 1,
    config: { baseUrl: 'https://aborting.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { chatCompletions: {} }, ingressHeadersRules: [] },
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
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_a', name: 'A', sortOrder: 1 }));

  const resolved = await enumerateModelCandidates({
    upstreamIds: [],
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
    await repo.upstreams.save(buildCustomUpstreamRecord({
      id: 'up_a', name: 'A', sortOrder: 1,
      config: { baseUrl: 'https://a.example.com', authStyle: 'bearer', apiKey: 'sk-a', endpoints: { chatCompletions: {} }, ingressHeadersRules: [] },
    }));
    await repo.upstreams.save(buildCustomUpstreamRecord({
      id: 'up_b', name: 'B', sortOrder: 2,
      config: { baseUrl: 'https://b.example.com', authStyle: 'bearer', apiKey: 'sk-b', endpoints: { chatCompletions: {} }, ingressHeadersRules: [] },
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
          upstreamIds: null, model: 'smart', kind: 'chat', scheduler: testScheduler, runtimeLocation: 'TEST',
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
          upstreamIds: null, model: 'random-alias', kind: 'chat', scheduler: testScheduler, runtimeLocation: 'TEST',
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
          upstreamIds: null, model: 'dup-alias', kind: 'chat', scheduler: testScheduler, runtimeLocation: 'TEST',
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
          upstreamIds: null, model: 'interleaved-duplicates', kind: 'chat', scheduler: testScheduler, runtimeLocation: 'TEST',
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
          upstreamIds: null, model: 'two-rules', kind: 'chat', scheduler: testScheduler, runtimeLocation: 'TEST',
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
          upstreamIds: null, model: 'fallback', kind: 'chat', scheduler: testScheduler, runtimeLocation: 'TEST',
        });
        // The `missing` target contributes nothing; the `gpt-5` target
        // contributes one candidate carrying its own rule overlay.
        assertEquals(resolved.candidates.length, 1);
        assertEquals(resolved.candidates[0]!.rules?.verbosity, 'high');
      },
    );
  });
});
