import { test, vi } from 'vitest';

import type { CustomIngressHeaderRule, ModelCandidate, Provider } from '@floway-dev/provider';
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

const dispatcherFor = async (kind: 'codex' | 'custom', ingressHeaderRules: readonly CustomIngressHeaderRule[] = []) => {
  let observedHeaders: Headers | undefined;
  const base = stubModelCandidate();
  if (base.provider.kind !== 'custom') throw new Error('stubModelCandidate default must be Custom');
  const common = {
    ...base.provider,
    upstreamId: 'search-upstream',
    instance: stubProvider({
      callAlphaSearch: async (_model, _body, _signal, opts) => {
        observedHeaders = opts.headers;
        return { response: new Response('{}'), modelKey: 'search-model' };
      },
    }),
  };
  const provider: Provider = kind === 'custom'
    ? { ...common, kind, ingressHeaderRules }
    : (() => {
        const { ingressHeaderRules: _customRules, ...standard } = common;
        return { ...standard, kind };
      })();
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

test('Custom Alpha Search admits configured names before the provider call', async () => {
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
    'x-empty': 'client-empty',
    'x-overwrite': 'client-overwrite',
    'x-passthrough': 'client-passthrough',
  });
});
