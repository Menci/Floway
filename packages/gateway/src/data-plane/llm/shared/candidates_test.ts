import { describe, test } from 'vitest';

import { enumerateProviderCandidates } from './candidates.ts';
import { buildCustomUpstreamRecord, setupAppTest } from '../../../test-helpers.ts';
import { clearInFlightForTesting } from '../../providers/models-cache.ts';
import type { ModelEndpoints } from '@floway-dev/protocols/common';
import type { LlmTargetApi, UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

// Drains SWR background revalidate so a rejection surfaces in the runner
// instead of being swallowed.
const testScheduler = (promise: Promise<unknown>): void => {
  promise.catch(err => console.error('[background]', err));
};

// Azure resolves its catalog without HTTP, giving deterministic candidates.
const azureUpstream = (id: string, sortOrder: number, modelIds: string[], endpoints: ModelEndpoints): UpstreamRecord => ({
  id,
  provider: 'azure',
  name: id,
  enabled: true,
  sortOrder,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  config: {
    endpoint: `https://${id}.openai.azure.com`,
    apiKey: 'az-key',
    models: modelIds.map(upstreamModelId => ({ upstreamModelId, endpoints })),
  },
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
});

const pickMessages = (e: ModelEndpoints): LlmTargetApi | null =>
  e.messages ? 'messages' : null;

const pickMessagesOrResponses = (e: ModelEndpoints): LlmTargetApi | null =>
  e.messages ? 'messages' : e.responses ? 'responses' : null;

const pickResponses = (e: ModelEndpoints): LlmTargetApi | null =>
  e.responses ? 'responses' : null;

const pickAny = (e: ModelEndpoints): LlmTargetApi | null =>
  e.messages ? 'messages' : e.responses ? 'responses' : e.chatCompletions ? 'chat-completions' : null;

describe('enumerateProviderCandidates', () => {
  test('single provider with a matching binding yields one candidate', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(azureUpstream('up_a', 10, ['test-model'], { messages: {} }));

    const { candidates, sawModel } = await enumerateProviderCandidates({
      upstreamIds: null,
      model: 'test-model',
      pickTarget: pickMessages,
      scheduler: testScheduler,
      currentColo: 'TEST',
    });

    assertEquals(candidates.length, 1);
    assertEquals(candidates[0].provider.upstream, 'up_a');
    assertEquals(candidates[0].binding.upstreamModel.id, 'test-model');
    assertEquals(candidates[0].targetApi, 'messages');
    assertEquals(sawModel, true);
  });

  test('provider with binding but pickTarget returns null yields no candidate but sets sawModel', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(azureUpstream('up_chat', 10, ['test-model'], { chatCompletions: {} }));

    const { candidates, sawModel } = await enumerateProviderCandidates({
      upstreamIds: null,
      model: 'test-model',
      pickTarget: pickMessages,
      scheduler: testScheduler,
      currentColo: 'TEST',
    });

    assertEquals(candidates.length, 0);
    // The model exists on a provider — sawModel distinguishes this from a
    // model that no provider knows about, so the serve renders 400
    // model-unsupported instead of 404 model-missing.
    assertEquals(sawModel, true);
  });

  test('provider without a binding for the requested model yields no candidate and sawModel=false', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(azureUpstream('up_a', 10, ['other-model'], { messages: {} }));

    const { candidates, sawModel } = await enumerateProviderCandidates({
      upstreamIds: null,
      model: 'test-model',
      pickTarget: pickMessages,
      scheduler: testScheduler,
      currentColo: 'TEST',
    });

    assertEquals(candidates.length, 0);
    assertEquals(sawModel, false);
  });

  test('multiple providers: only those with the model produce candidates in sort_order', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(azureUpstream('up_first', 10, ['test-model'], { messages: {} }));
    await repo.upstreams.save(azureUpstream('up_second', 20, ['other-model'], { messages: {} }));
    await repo.upstreams.save(azureUpstream('up_third', 30, ['test-model'], { messages: {} }));

    const { candidates } = await enumerateProviderCandidates({
      upstreamIds: null,
      model: 'test-model',
      pickTarget: pickMessages,
      scheduler: testScheduler,
      currentColo: 'TEST',
    });

    assertEquals(candidates.length, 2);
    assertEquals(candidates[0].provider.upstream, 'up_first');
    assertEquals(candidates[1].provider.upstream, 'up_third');
  });

  test('upstreamIds filtering: only matching providers surface in given order', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(azureUpstream('up_a', 10, ['test-model'], { messages: {} }));
    await repo.upstreams.save(azureUpstream('up_b', 20, ['test-model'], { messages: {} }));
    await repo.upstreams.save(azureUpstream('up_c', 30, ['test-model'], { messages: {} }));

    const { candidates } = await enumerateProviderCandidates({
      upstreamIds: ['up_c', 'up_a'],
      model: 'test-model',
      pickTarget: pickMessages,
      scheduler: testScheduler,
      currentColo: 'TEST',
    });

    assertEquals(candidates.length, 2);
    assertEquals(candidates[0].provider.upstream, 'up_c');
    assertEquals(candidates[1].provider.upstream, 'up_a');
  });

  test('upstreamIds=null returns all enabled providers', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(azureUpstream('up_enabled', 10, ['test-model'], { messages: {} }));
    await repo.upstreams.save({
      ...azureUpstream('up_disabled', 20, ['test-model'], { messages: {} }),
      enabled: false,
    });

    const { candidates } = await enumerateProviderCandidates({
      upstreamIds: null,
      model: 'test-model',
      pickTarget: pickMessages,
      scheduler: testScheduler,
      currentColo: 'TEST',
    });

    assertEquals(candidates.length, 1);
    assertEquals(candidates[0].provider.upstream, 'up_enabled');
  });

  test('pickTarget preference: multi-endpoint binding picks according to pickTarget logic', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(azureUpstream('up_multi', 10, ['test-model'], { messages: {}, responses: {} }));

    const { candidates: msgCandidates } = await enumerateProviderCandidates({
      upstreamIds: null,
      model: 'test-model',
      pickTarget: pickMessagesOrResponses,
      scheduler: testScheduler,
      currentColo: 'TEST',
    });
    assertEquals(msgCandidates.length, 1);
    assertEquals(msgCandidates[0].targetApi, 'messages');

    const { candidates: resCandidates } = await enumerateProviderCandidates({
      upstreamIds: null,
      model: 'test-model',
      pickTarget: pickResponses,
      scheduler: testScheduler,
      currentColo: 'TEST',
    });
    assertEquals(resCandidates.length, 1);
    assertEquals(resCandidates[0].targetApi, 'responses');
  });

  test('pickTarget returning null filters out an otherwise-matching provider', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(azureUpstream('up_chat', 10, ['test-model'], { chatCompletions: {} }));

    const { candidates: anyCandidates } = await enumerateProviderCandidates({
      upstreamIds: null,
      model: 'test-model',
      pickTarget: pickAny,
      scheduler: testScheduler,
      currentColo: 'TEST',
    });
    assertEquals(anyCandidates.length, 1);
    assertEquals(anyCandidates[0].targetApi, 'chat-completions');

    const { candidates: msgCandidates, sawModel } = await enumerateProviderCandidates({
      upstreamIds: null,
      model: 'test-model',
      pickTarget: pickMessages,
      scheduler: testScheduler,
      currentColo: 'TEST',
    });
    assertEquals(msgCandidates.length, 0);
    // pickTarget filtered out, but the model exists — sawModel stays true.
    assertEquals(sawModel, true);
  });

  // Regression: a single upstream whose catalog fetch rejects must not poison
  // the loop. The healthy upstreams still produce candidates and the broken
  // upstream's display name surfaces via failedUpstreams so the eventual
  // serve-side error renderer can mention it.
  test('a single rejecting upstream does not block candidates from healthy upstreams', async () => {
    clearInFlightForTesting();
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(buildCustomUpstreamRecord({
      id: 'up_broken',
      name: 'Broken upstream',
      sortOrder: 1,
      config: { baseUrl: 'https://broken.example.com', bearerToken: 'sk-x', endpoints: { messages: {} } },
    }));
    await repo.upstreams.save(azureUpstream('up_ok', 2, ['test-model'], { messages: {} }));

    await withMockedFetch(
      request => {
        const url = new URL(request.url);
        if (url.hostname === 'broken.example.com' && url.pathname === '/v1/models') {
          return jsonResponse({ error: 'upstream went down' }, 502);
        }
        throw new Error(`Unhandled fetch ${request.url}`);
      },
      async () => {
        const { candidates, sawModel, failedUpstreams } = await enumerateProviderCandidates({
          upstreamIds: null,
          model: 'test-model',
          pickTarget: pickMessages,
          scheduler: testScheduler,
          currentColo: 'TEST',
        });

        assertEquals(candidates.length, 1);
        assertEquals(candidates[0].provider.upstream, 'up_ok');
        assertEquals(sawModel, true);
        assertEquals(failedUpstreams, ['Broken upstream']);
      },
    );
  });

  // When every upstream's catalog rejects, the request gets an empty candidate
  // list and sawModel=false — the LLM serve sites turn that into model-missing
  // with the failed-upstream parenthetical attached.
  test('all upstreams rejecting yields no candidates, sawModel=false, and every name in failedUpstreams', async () => {
    clearInFlightForTesting();
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(buildCustomUpstreamRecord({
      id: 'up_a',
      name: 'A',
      sortOrder: 1,
      config: { baseUrl: 'https://a.example.com', bearerToken: 'sk-x', endpoints: { messages: {} } },
    }));
    await repo.upstreams.save(buildCustomUpstreamRecord({
      id: 'up_b',
      name: 'B',
      sortOrder: 2,
      config: { baseUrl: 'https://b.example.com', bearerToken: 'sk-x', endpoints: { messages: {} } },
    }));

    await withMockedFetch(
      request => {
        const url = new URL(request.url);
        if (url.pathname === '/v1/models') return jsonResponse({ error: 'down' }, 502);
        throw new Error(`Unhandled fetch ${request.url}`);
      },
      async () => {
        const { candidates, sawModel, failedUpstreams } = await enumerateProviderCandidates({
          upstreamIds: null,
          model: 'test-model',
          pickTarget: pickMessages,
          scheduler: testScheduler,
          currentColo: 'TEST',
        });

        assertEquals(candidates.length, 0);
        assertEquals(sawModel, false);
        assertEquals(failedUpstreams, ['A', 'B']);
      },
    );
  });
});
