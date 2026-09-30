import { test, vi } from 'vitest';

import { providerEntry } from '../../../../../src/data-plane/pipeline/provider-entry.ts';
import { mockGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import { stubProviderPipeline } from '../../../../test-utils/provider-pipeline.ts';
import { run } from '@floway-dev/pipeline';
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

const { resolveAlphaSearchCandidate } = await import('../../../../../src/data-plane/tools/web-search/alpha-search/upstream.ts');

const dispatcherFor = async (kind: 'codex' | 'custom', inboundHeaderAllowlist: readonly InboundHeaderMatcher[] = []) => {
  let observedHeaders: Headers | undefined;
  const base = stubModelCandidate();
  const provider = {
    ...base.provider,
    upstreamId: 'search-upstream',
    kind,
    inboundHeaderAllowlist,
    pipelines: {
      alphaSearch: stubProviderPipeline('alphaSearch', async (_model, _body, _signal, opts) => {
        observedHeaders = opts.headers;
        return { response: new Response('{}'), modelKey: 'search-model' };
      }),
    },
    instance: stubProvider({
      callAlphaSearch: async (_model, _body, _signal, opts) => {
        observedHeaders = opts.headers;
        return { response: new Response('{}'), modelKey: 'search-model' };
      },
    }),
  };
  resolvedCandidate = stubModelCandidate({ provider });
  const dispatcher = await resolveAlphaSearchCandidate({
    config: { upstreamId: provider.upstreamId, model: 'search-model' },
    upstreamIds: null,
    scheduler: promise => { void promise; },
    runtimeLocation: 'TEST',
  });
  return {
    dispatcher: async (body: Record<string, unknown>, _signal: AbortSignal | undefined, headers: Headers) => {
      const pipeline = dispatcher.provider.pipelines.alphaSearch;
      if (pipeline === undefined) throw new Error('Missing selected Alpha Search pipeline');
      const entry = providerEntry({ 'route.attempt': { candidateId: 0, upstreamId: 'search-upstream', modelId: 'search-model', flags: [] }, 'ingress.http.headers': [...headers] }, dispatcher, body);
      const executed = await run(pipeline, entry, { gateway: mockGatewayCtx() });
      await executed.drain();
    }, observedHeaders: () => observedHeaders,
  };
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
