import { afterEach, expect, test, vi } from 'vitest';

import { GatewayRequestDirectory } from '../../../src/data-plane/pipeline/services.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, setupAppTest, testAdminUser, warmModelsForTest } from '../../test-utils/app.ts';
import { jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

afterEach(() => vi.restoreAllMocks());

const directory = (runtimeLocation = 'TEST') => new GatewayRequestDirectory({
  user: testAdminUser,
  upstreamIds: null,
  randomizeUpstreams: false,
  runtimeLocation,
  backgroundScheduler: promise => { void promise; },
});

test('GatewayRequestDirectory schedules a cold model refresh without waiting for upstream I/O', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord());
  const background: Promise<unknown>[] = [];
  let releaseFetch: ((response: Response) => void) | undefined;
  const fetch = vi.fn(() => new Promise<Response>(resolve => { releaseFetch = resolve; }));

  await withMockedFetch(fetch, async () => {
    const resolved = await new GatewayRequestDirectory({
      user: testAdminUser,
      upstreamIds: null,
      randomizeUpstreams: false,
      runtimeLocation: 'TEST',
      backgroundScheduler: promise => { background.push(promise); },
    }).enumerateCandidates('eventual-model', 'chat');
    expect(resolved.candidates).toEqual([]);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    releaseFetch!(jsonResponse({ object: 'list', data: [{ id: 'eventual-model' }] }));
    await Promise.all(background);
  });

  const warm = await directory().enumerateCandidates('eventual-model', 'chat');
  expect(warm.candidates.map(candidate => `${candidate.modelId}@${candidate.upstreamId}`)).toEqual(['eventual-model@up_custom']);
});

test('GatewayRequestDirectory randomizes provider groups without splitting their candidates', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  for (const [id, host, sortOrder] of [['up_a', 'a', 1], ['up_b', 'b', 2]] as const) {
    await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
      id,
      name: id,
      sortOrder,
      config: { baseUrl: `https://${host}.example.com`, apiKey: `sk-${host}`, endpoints: { openaiChatCompletions: {} }, ingressHeadersRules: [] },
      modelPrefix: { prefix: 'or/', addressable: ['unprefixed', 'prefixed'], listed: ['unprefixed', 'prefixed'] },
    }));
  }
  await withMockedFetch(
    request => {
      const host = new URL(request.url).hostname;
      if (host === 'a.example.com' || host === 'b.example.com') {
        return jsonResponse({ object: 'list', data: [{ id: 'or/gpt-4o' }, { id: 'gpt-4o' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      await warmModelsForTest();
      const random = vi.spyOn(Math, 'random').mockReturnValue(0);
      const resolved = await new GatewayRequestDirectory({
        user: testAdminUser,
        upstreamIds: null,
        randomizeUpstreams: true,
        runtimeLocation: 'TEST',
        backgroundScheduler: promise => { void promise; },
      }).enumerateCandidates('or/gpt-4o', 'chat');
      expect(resolved.candidates.map(candidate => `${candidate.modelId}@${candidate.upstreamId}`)).toEqual([
        'or/gpt-4o@up_b', 'gpt-4o@up_b', 'or/gpt-4o@up_a', 'gpt-4o@up_a',
      ]);
      expect(random).toHaveBeenCalledOnce();
    },
  );
});

test('GatewayRequestDirectory keeps healthy candidates and reports failed upstreams', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_broken', name: 'Broken upstream', sortOrder: 1,
    config: { baseUrl: 'https://broken.example.com', apiKey: 'sk-x', endpoints: { openaiChatCompletions: {} }, ingressHeadersRules: [] },
  }));
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_ok', name: 'Healthy upstream', sortOrder: 2,
    config: { baseUrl: 'https://ok.example.com', apiKey: 'sk-x', endpoints: { openaiChatCompletions: {} }, ingressHeadersRules: [] },
  }));
  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'broken.example.com') return jsonResponse({ error: 'down' }, 502);
      if (url.hostname === 'ok.example.com') return jsonResponse({ object: 'list', data: [{ id: 'ok-model', supported_endpoints: ['/chat/completions'] }] });
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      await warmModelsForTest();
      const resolved = await directory().enumerateCandidates('ok-model', 'chat');
      expect(resolved.candidates.map(candidate => candidate.upstreamId)).toEqual(['up_ok']);
      expect(resolved.failedUpstreams).toEqual(['Broken upstream']);
    },
  );
});

test('GatewayRequestDirectory flattens and deduplicates alias targets in selection order', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_a', name: 'A', sortOrder: 1,
    config: { baseUrl: 'https://a.example.com', apiKey: 'sk-a', endpoints: { openaiChatCompletions: {} }, ingressHeadersRules: [] },
  }));
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_b', name: 'B', sortOrder: 2,
    config: { baseUrl: 'https://b.example.com', apiKey: 'sk-b', endpoints: { openaiChatCompletions: {} }, ingressHeadersRules: [] },
  }));
  await repo.modelAliases.insert({
    id: 'alias_interleaved',
    name: 'interleaved',
    kind: 'chat',
    selection: 'first-available',
    targets: [
      { target_model_id: 'gpt-5', rules: { reasoning: { effort: 'low' } } },
      { target_model_id: 'claude', rules: { reasoning: { effort: 'high' } } },
      { target_model_id: 'gpt-5', rules: { reasoning: { effort: 'low' } } },
    ],
    displayName: null,
    visibleInModelsList: true,
    announcedMetadata: null,
    sortOrder: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'a.example.com') return jsonResponse({ object: 'list', data: [{ id: 'gpt-5' }] });
      if (url.hostname === 'b.example.com') return jsonResponse({ object: 'list', data: [{ id: 'claude' }] });
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      await warmModelsForTest();
      const resolved = await directory().enumerateCandidates('interleaved', 'chat');
      expect(resolved.candidates.map(candidate => ({
        binding: `${candidate.modelId}@${candidate.upstreamId}`,
        effort: candidate.rules?.reasoning?.effort,
      }))).toEqual([
        { binding: 'gpt-5@up_a', effort: 'low' },
        { binding: 'claude@up_b', effort: 'high' },
      ]);
    },
  );
});
