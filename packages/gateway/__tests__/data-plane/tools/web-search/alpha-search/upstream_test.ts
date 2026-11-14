import { expect, test, vi } from 'vitest';

import type { InboundHeaderMatcher, ModelCandidate } from '@floway-dev/provider';
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
const { enumerateModelCandidates } = await import('../../../../../src/data-plane/providers/resolution.ts');

const context: Parameters<typeof resolveAlphaSearchDispatcher>[0] = {
  config: { upstreamId: 'search-upstream', model: 'search-model' },
  subject: { id: 1, username: 'admin', passwordHash: null, isAdmin: true, createdAt: '', deletedAt: null },
  upstreamIds: null,
  scheduler: promise => { void promise; },
  runtimeLocation: 'TEST',
};

const dispatcherFor = async (kind: 'codex' | 'custom', inboundHeaderAllowlist: readonly InboundHeaderMatcher[] = []) => {
  let observedHeaders: Headers | undefined;
  const base = stubModelCandidate();
  const provider = {
    ...base.provider,
    upstreamId: context.config.upstreamId,
    kind,
    inboundHeaderAllowlist,
    instance: stubProvider({
      callAlphaSearch: async (_model, _body, _signal, opts) => {
        observedHeaders = opts.headers;
        return { response: new Response('{}'), modelKey: 'search-model' };
      },
    }),
  };
  resolvedCandidate = stubModelCandidate({ provider });
  const dispatcher = await resolveAlphaSearchDispatcher(context);
  return { dispatcher, observedHeaders: () => observedHeaders };
};

test('Alpha Search reports a missing model when the selection has no permitted candidate', async () => {
  resolvedCandidate = undefined;
  await expect(resolveAlphaSearchDispatcher(context)).rejects.toBeInstanceOf(AlphaSearchModelNotFoundError);
});

test('Alpha Search does not resolve a model outside the API key upstream scope', async () => {
  vi.mocked(enumerateModelCandidates).mockClear();
  await expect(resolveAlphaSearchDispatcher({ ...context, upstreamIds: [] })).rejects.toBeInstanceOf(AlphaSearchModelNotFoundError);
  expect(enumerateModelCandidates).not.toHaveBeenCalled();
});

test('Alpha Search preserves unexpected resolution failures', async () => {
  const failure = new Error('resolution failed');
  vi.mocked(enumerateModelCandidates).mockRejectedValueOnce(failure);
  await expect(resolveAlphaSearchDispatcher(context)).rejects.toBe(failure);
});

test('Alpha Search rejects unsupported providers as configuration failures', async () => {
  const candidate = stubModelCandidate();
  resolvedCandidate = { ...candidate, provider: { ...candidate.provider, upstreamId: context.config.upstreamId, kind: 'copilot' } };
  await expect(resolveAlphaSearchDispatcher(context)).rejects.toThrow('Selected upstream does not support OpenAI search passthrough');
});

test('Codex Alpha Search receives only its declared turn metadata', async () => {
  const { dispatcher, observedHeaders } = await dispatcherFor('codex', ['x-codex-turn-metadata']);
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

test('Custom Alpha Search admits configured names before the provider call', async () => {
  const { dispatcher, observedHeaders } = await dispatcherFor('custom', [
    'x-empty',
    'x-overwrite',
    'x-passthrough',
  ]);
  await dispatcher({}, undefined, new Headers({
    authorization: 'Bearer secret',
    'x-empty': 'client-empty',
    'x-debug': 'discard',
    'x-overwrite': 'client-overwrite',
    'x-passthrough': 'client-passthrough',
  }));

  const headers = observedHeaders();
  assertExists(headers);
  assertEquals(Object.fromEntries(headers), {
    'x-empty': 'client-empty',
    'x-overwrite': 'client-overwrite',
    'x-passthrough': 'client-passthrough',
  });
});
