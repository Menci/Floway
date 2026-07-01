import { test } from 'vitest';

import { providerModelOf } from './invocation.ts';
import { assertEquals, assertThrows, stubModelCandidate, stubProviderModel } from '@floway-dev/test-utils';

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
