import { test, vi } from 'vitest';

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

const { resolveAlphaSearchDispatcher } = await import('../../../../../src/data-plane/tools/web-search/alpha-search/upstream.ts');

const dispatcherFor = async (kind: 'codex' | 'custom', inboundHeaderAllowlist: readonly InboundHeaderMatcher[] = []) => {
  let observedHeaders: Headers | undefined;
  const base = stubModelCandidate();
  const provider = {
    ...base.provider,
    upstreamId: 'search-upstream',
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
  const dispatcher = await resolveAlphaSearchDispatcher({
    config: { upstreamId: provider.upstreamId, model: 'search-model' },
    upstreamIds: null,
    scheduler: promise => { void promise; },
    runtimeLocation: 'TEST',
  });
  return { dispatcher, observedHeaders: () => observedHeaders };
};

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

test('Custom Alpha Search receives no client headers', async () => {
  const { dispatcher, observedHeaders } = await dispatcherFor('custom');
  await dispatcher({}, undefined, new Headers({
    authorization: 'Bearer secret',
    'x-codex-turn-metadata': '{"turn_id":"turn-1"}',
    'x-debug': 'discard',
  }));

  const headers = observedHeaders();
  assertExists(headers);
  assertEquals([...headers], []);
});
