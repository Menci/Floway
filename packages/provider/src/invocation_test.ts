import { test } from 'vitest';

import { directFetcher, type ModelCandidate } from './index.ts';
import { providerModelOf } from './invocation.ts';
import { assertEquals, assertThrows, stubModelCandidate, stubProvider, stubProviderModel } from '@floway-dev/test-utils';

test('providerModelOf returns the ProviderModel keyed on the candidate provider upstream, verbatim', () => {
  const providerModel = stubProviderModel({ id: 'gpt-9', enabledFlags: new Set(['flag-a']) });
  const candidate = stubModelCandidate({
    model: {
      id: 'gpt-9',
      providerModels: { 'test-upstream': providerModel },
    },
  });

  const resolved = providerModelOf(candidate);

  assertEquals(resolved, providerModel);
  assertEquals(resolved.enabledFlags, new Set(['flag-a']));
});

test('providerModelOf throws when the candidate names an upstream missing from providerModels', () => {
  const candidate = stubModelCandidate({
    model: {
      id: 'orphan-model',
      providerModels: {},
    },
  });

  assertThrows(
    () => providerModelOf(candidate),
    Error,
    "providerModelOf: model 'orphan-model' has no providerModel for 'test-upstream'",
  );
});

test('providerModelOf throws when providerModels only carries entries for other upstreams', () => {
  const candidate = stubModelCandidate({
    model: {
      providerModels: { 'other-upstream': stubProviderModel({ id: 'wrong' }) },
    },
  });

  assertThrows(
    () => providerModelOf(candidate),
    Error,
    "no providerModel for 'test-upstream'",
  );
});

test('providerModelOf throws the alias-row diagnostic when the candidate names an alias-synthesized row', () => {
  // Alias-row `InternalModel`s never reach dispatch — the resolver expands
  // them at request entry. If one slips through anyway (or a caller builds a
  // ModelCandidate off a listing row by mistake), `providerModelOf` names
  // the failure mode distinctly so the diagnostic points at the misuse
  // rather than at a missing upstream. `stubModelCandidate` rejects
  // `aliasedFrom` at the type level (real-row stubs only), so we build the
  // candidate literally.
  const candidate: ModelCandidate = {
    provider: {
      upstream: 'test-upstream',
      kind: 'custom',
      name: 'Test Upstream',
      disabledPublicModelIds: [],
      modelPrefix: null,
      instance: stubProvider(),
      supportsResponsesItemReference: false,
    },
    model: {
      id: 'gpt-fast',
      kind: 'chat',
      limits: {},
      endpoints: { chatCompletions: {}, responses: {}, messages: {} },
      aliasedFrom: {
        selection: 'first-available',
        targets: [{ target_model_id: 'gpt-5.4', rules: {} }],
      },
    },
    fetcher: directFetcher,
  };

  assertThrows(
    () => providerModelOf(candidate),
    Error,
    "providerModelOf: model 'gpt-fast' is an alias row; the resolver should have expanded it to a target row before dispatch",
  );
});
