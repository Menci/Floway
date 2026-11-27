import { describe, expect, test, vi } from 'vitest';

import { createGatewayServices } from '../../../src/data-plane/pipeline/services.ts';
import { resolveModelCandidates as resolveModelCandidatesRaw } from '../../../src/data-plane/upstreams/resolution.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, setupAppTest, testAdminUser, warmModelsForTest } from '../../test-utils/app.ts';
import { assertEquals, jsonResponse, withMockedFetch as withMockedFetchRaw } from '@floway-dev/test-utils';

const withMockedFetch = <T>(
  handler: Parameters<typeof withMockedFetchRaw>[0],
  fn: () => Promise<T>,
): Promise<T> => withMockedFetchRaw(handler, async () => {
  await warmModelsForTest();
  return await fn();
});

const resolveModelCandidates = (
  input: Omit<Parameters<typeof resolveModelCandidatesRaw>[0], 'subject'>,
) => resolveModelCandidatesRaw({ subject: testAdminUser, ...input });

test('a cold candidate read returns empty without triggering upstream I/O', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord());
  const fetch = vi.fn(() => jsonResponse({ object: 'list', data: [{ id: 'eventual-model' }] }));

  await withMockedFetchRaw(
    fetch,
    async () => {
      const result = await resolveModelCandidates({
        upstreamIds: null,
        randomizeUpstreams: false,
        model: 'eventual-model',
        kind: 'chat',
      });
      expect(result.candidates).toEqual([]);
      expect(result.sawModel).toBe(false);
    },
  );

  expect(fetch).not.toHaveBeenCalled();
});

test('the pipeline discovers indexed, authorized candidates and only dials a resolved upstream', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.upstreams.deleteAll();
  for (const id of ['allowed', 'denied', 'out-of-key']) {
    await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({ id, name: id }));
  }
  const principal = { kind: 'user' as const, id: apiKey.userId };
  await repo.accessRecords.deleteByPrincipal(principal);
  for (const id of ['allowed', 'out-of-key']) {
    await repo.accessRecords.save({
      principal, scope: { kind: 'upstream', upstreamId: id }, sortOrder: 0, values: { 'Model.Use': true },
    });
  }

  const fetch = vi.fn((request: Request) => new URL(request.url).pathname.endsWith('/models')
    ? jsonResponse({ object: 'list', data: [{ id: 'm' }] })
    : new Response('fetched'));
  await withMockedFetch(fetch, async () => {
    fetch.mockClear();
    const list = vi.spyOn(repo.upstreams, 'list').mockRejectedValue(new Error('request scanned upstreams'));
    const resolve = vi.spyOn(repo.upstreamModels, 'resolve');
    try {
      const services = createGatewayServices({
        apiKey: { ...apiKey, upstreamIds: ['allowed', 'denied'] },
        subject: { id: apiKey.userId, isAdmin: false },
        runtimeLocation: 'TEST',
        dump: null,
      });
      const result = await services.catalogCandidates({ kind: 'chat', model: 'm' });
      expect(result.sawModel).toBe(true);
      expect(result.candidates.map(({ upstream, model }) => [upstream.id, model.id])).toEqual([['allowed', 'm']]);
      expect(result.candidates[0]?.upstream).not.toHaveProperty('state');
      expect(resolve.mock.calls).toEqual([[{ modelIds: ['m'], upstreamIds: ['allowed', 'denied'] }]]);
      const indexed: Awaited<ReturnType<typeof repo.upstreamModels.resolve>> = await resolve.mock.results[0]!.value;
      const match = indexed.find(({ upstream }) => upstream.id === 'allowed')!;
      expect(result.candidates[0]?.model.enabledFlags).toEqual([...match.model.enabledFlags]);
      expect(list).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      await expect(services.catalogCandidates({ kind: 'chat', model: 'm', upstreamId: 'out-of-key' }))
        .resolves.toEqual({ candidates: [], sawModel: false });
      expect(resolve).toHaveBeenCalledOnce();
      expect(() => services.fetcher('denied')).toThrow('No data-plane fetcher for resolved upstream denied');
      const response = await services.fetcher('allowed')('https://upstream.example.com/v1/chat/completions', { method: 'POST' });
      await expect(response.text()).resolves.toBe('fetched');
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      resolve.mockRestore();
      list.mockRestore();
    }
  });
});

test('randomizes upstream candidate groups without splitting or reordering a group', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  for (const [id, name, sortOrder] of [['up_a', 'A', 1], ['up_b', 'B', 2]] as const) {
    await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
      id,
      name,
      sortOrder,
      config: { baseUrl: `https://${name.toLowerCase()}.example.com`, apiKey: `sk-${name.toLowerCase()}`, endpoints: { openaiChatCompletions: {} }, ingressHeadersRules: [] },
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
        const resolved = await resolveModelCandidates({
          upstreamIds: null,
          randomizeUpstreams: true,
          model: 'or/gpt-4o',
          kind: 'chat',
        });
        assertEquals(
          resolved.candidates.map(candidate => `${candidate.model.id}@${candidate.upstream.id}`),
          ['or/gpt-4o@up_b', 'gpt-4o@up_b', 'or/gpt-4o@up_a', 'gpt-4o@up_a'],
        );
        expect(random).toHaveBeenCalledOnce();
      } finally {
        random.mockRestore();
      }
    },
  );
});

test('resolveModelCandidates: healthy upstream still resolves alongside a rejecting one', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();

  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_broken',
    name: 'Broken upstream',
    sortOrder: 1,
    config: { baseUrl: 'https://broken.example.com', apiKey: 'sk-x', endpoints: { openaiChatCompletions: {} }, ingressHeadersRules: [] },
  }));
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_ok',
    name: 'Healthy upstream',
    sortOrder: 2,
    config: { baseUrl: 'https://ok.example.com', apiKey: 'sk-x', endpoints: { openaiChatCompletions: {} }, ingressHeadersRules: [] },
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
      const resolvedExisting = await resolveModelCandidates({ upstreamIds: null, randomizeUpstreams: false, model: 'ok-model', kind: 'chat' });
      assertEquals(resolvedExisting.candidates.map(m => m.upstream.id), ['up_ok']);
      assertEquals(resolvedExisting.candidates[0]?.model.id, 'ok-model');

      const resolvedMissing = await resolveModelCandidates({ upstreamIds: null, randomizeUpstreams: false, model: 'unknown-model', kind: 'chat' });
      assertEquals(resolvedMissing.candidates.length, 0);
    },
  );
});

// The alias walk visits every target, tags each real-catalog candidate
// with that target's rule overlay, flattens across targets in `selection`
// order, and dedups by (model, upstream, rules). Two targets pointing at
// the same real model with the same rules collapse; the same pair with
// distinct rules stays as two candidates so both can be attempted.
describe('resolveModelCandidates alias walk (flat + dedup)', () => {
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
      config: { baseUrl: 'https://a.example.com', apiKey: 'sk-a', endpoints: { openaiChatCompletions: {} }, ingressHeadersRules: [] },
    }));
    await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
      id: 'up_b', name: 'B', sortOrder: 2,
      config: { baseUrl: 'https://b.example.com', apiKey: 'sk-b', endpoints: { openaiChatCompletions: {} }, ingressHeadersRules: [] },
    }));
  };

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
        const resolved = await resolveModelCandidates({
          upstreamIds: null, randomizeUpstreams: false, model: 'interleaved-duplicates', kind: 'chat',
        });
        expect(resolved.candidates.map(candidate => ({
          binding: `${candidate.model.id}@${candidate.upstream.id}`,
          effort: candidate.rules?.reasoning?.effort,
        }))).toEqual([
          { binding: 'gpt-5@up_a', effort: 'low' },
          { binding: 'claude@up_b', effort: 'high' },
        ]);
      },
    );
  });
});
