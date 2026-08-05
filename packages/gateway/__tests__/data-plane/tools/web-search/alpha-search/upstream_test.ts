import { test, vi } from 'vitest';

import type { IngressHeaderRule, ModelCandidate } from '@floway-dev/provider';
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

const dispatcherFor = async (kind: 'codex' | 'custom', ingressHeaderRules: readonly IngressHeaderRule[] = []) => {
  let observedHeaders: Headers | undefined;
  const base = stubModelCandidate();
  const provider = {
    ...base.provider,
    upstreamId: 'search-upstream',
    kind,
    ingressHeaderRules,
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
  const { dispatcher, observedHeaders } = await dispatcherFor('codex');
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

test('Custom Alpha Search resolves instance passthrough and replacement rules', async () => {
  const { dispatcher, observedHeaders } = await dispatcherFor('custom', [
    { matcher: 'x-empty', value: '' },
    { matcher: 'x-overwrite', value: 'configured' },
    { matcher: 'x-passthrough', value: null },
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
    'x-empty': '',
    'x-overwrite': 'configured',
    'x-passthrough': 'client-passthrough',
  });
});
