import { expect, test, vi } from 'vitest';

import { defineStage, pipeline, terminal } from '@floway-dev/pipeline';
import type { InboundHeaderMatcher, ModelCandidate, HttpOutcome, ProviderPipelineAlphaSearchInput, ProviderPipelineServices } from '@floway-dev/provider';
import { assertEquals, assertExists, stubModelCandidate, stubProvider } from '@floway-dev/test-utils';

let resolvedCandidate: ModelCandidate | undefined;
vi.mock('../../../../../src/data-plane/providers/resolution.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../../../../../src/data-plane/providers/resolution.ts')>();
  return {
    ...original,
    enumerateModelCandidates: vi.fn(async () => ({
      candidates: resolvedCandidate === undefined ? [] : [resolvedCandidate],
      sawModel: resolvedCandidate !== undefined,
      failedUpstreams: [],
    })),
  };
});

const { AlphaSearchModelNotFoundError, resolveAlphaSearchDispatcher } = await import('../../../../../src/data-plane/tools/web-search/alpha-search/upstream.ts');

const context: Parameters<typeof resolveAlphaSearchDispatcher>[0] = {
  config: { upstreamId: 'search-upstream', model: 'search-model' },
  subject: { id: 1, username: 'admin', passwordHash: null, isAdmin: true, createdAt: '', deletedAt: null },
  upstreamIds: null,
  scheduler: promise => { void promise; },
  runtimeLocation: 'TEST',
};

const dispatcherFor = async (kind: 'chatgpt' | 'custom', inboundHeaderAllowlist: readonly InboundHeaderMatcher[] = []) => {
  let observedHeaders: Headers | undefined;
  const base = stubModelCandidate();
  const provider = {
    ...base.provider,
    upstreamId: context.config.upstreamId,
    kind,
    inboundHeaderAllowlist,
    instance: stubProvider(),
    pipelines: {
      alphaSearch: pipeline<ProviderPipelineAlphaSearchInput>('test.alphaSearch')
        .use(defineStage<ProviderPipelineAlphaSearchInput, Record<never, never>, HttpOutcome, HttpOutcome, never, ProviderPipelineServices>({
          name: 'test.alphaSearch.request',
          execute: async (facts, _next, _env) => {
            observedHeaders = new Headers(facts['request.inboundHeaders'].map(([name, value]): [string, string] => [
              name,
              typeof value === 'string' ? value : value.reveal(),
            ]));
            return {
              status: 200,
              statusText: 'OK',
              headers: [],
              body: null,
              timing: { startedAtMs: 0, headersAtMs: 0 },
            };
          },
        }))
        .end(terminal<ProviderPipelineAlphaSearchInput, HttpOutcome, ProviderPipelineServices>({
          name: 'unreachable',
          execute: async () => {
            throw new Error('unreachable');
          },
        })),
    },
  };
  resolvedCandidate = stubModelCandidate({ provider });
  const dispatcher = await resolveAlphaSearchDispatcher(context);
  return { dispatcher, observedHeaders: () => observedHeaders };
};

test('Alpha Search reports a missing model when the selection has no permitted candidate', async () => {
  resolvedCandidate = undefined;
  await expect(resolveAlphaSearchDispatcher(context)).rejects.toBeInstanceOf(AlphaSearchModelNotFoundError);
});

test('Alpha Search rejects unsupported providers as configuration failures', async () => {
  const candidate = stubModelCandidate();
  resolvedCandidate = { ...candidate, provider: { ...candidate.provider, upstreamId: context.config.upstreamId, kind: 'copilot' } };
  await expect(resolveAlphaSearchDispatcher(context)).rejects.toThrow();
});

test('ChatGPT Alpha Search receives only its declared turn metadata', async () => {
  const { dispatcher, observedHeaders } = await dispatcherFor('chatgpt', ['x-codex-turn-metadata']);
  await dispatcher({}, undefined, new Headers({
    authorization: 'Bearer secret',
    'x-codex-turn-metadata': '{"turn_id":"turn-1"}',
    'x-debug': 'discard',
  }));

  const headers = observedHeaders();
  assertExists(headers);
  assertEquals(Object.fromEntries(headers), {
    'x-codex-turn-metadata': '{"turn_id":"turn-1"}',
  });
});
