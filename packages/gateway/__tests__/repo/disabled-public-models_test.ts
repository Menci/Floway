import { test } from 'vitest';

import { normalizeDisabledPublicModelIds, parseDisabledPublicModelIdsWire } from '../../src/repo/disabled-public-models.ts';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

test('normalizeDisabledPublicModelIds trims, drops empties, and de-dupes preserving order', () => {
  assertEquals(
    normalizeDisabledPublicModelIds([' gpt-4o ', 'claude', 'gpt-4o', '', '  ', 'claude']),
    ['gpt-4o', 'claude'],
  );
});

test('normalizeDisabledPublicModelIds rejects non-string entries', async () => {
  await assertRejects(
    () => normalizeDisabledPublicModelIds([1 as unknown as string]),
    Error,
    'disabledPublicModelIds entries must be strings',
  );
});

test('parseDisabledPublicModelIdsWire treats an absent field as the empty set', () => {
  assertEquals(parseDisabledPublicModelIdsWire(undefined), []);
});

test('parseDisabledPublicModelIdsWire normalizes a present array', () => {
  assertEquals(parseDisabledPublicModelIdsWire([' a ', 'a', 'b']), ['a', 'b']);
});

test('parseDisabledPublicModelIdsWire rejects non-array and non-string shapes', async () => {
  await assertRejects(
    () => parseDisabledPublicModelIdsWire({}),
    Error,
    'disabled_public_model_ids must be an array of strings',
  );
  await assertRejects(
    () => parseDisabledPublicModelIdsWire(['ok', 7]),
    Error,
    'disabled_public_model_ids entries must be strings',
  );
});
