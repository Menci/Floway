import { test } from 'vitest';

import { normalizeDisabledPublicModelIds, parseDisabledPublicModelIdsWire } from '../../src/repo/disabled-public-models.ts';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

test('normalizeDisabledPublicModelIds trims, drops empties, and de-dupes preserving order', () => {
  assertEquals(
    normalizeDisabledPublicModelIds([' gpt-4o ', 'claude', 'gpt-4o', '', '  ', 'claude']),
    ['gpt-4o', 'claude'],
  );
});

test('parseDisabledPublicModelIdsWire rejects non-array and non-string shapes', async () => {
  await assertRejects(
    () => parseDisabledPublicModelIdsWire({}),
    Error,
  );
  await assertRejects(
    () => parseDisabledPublicModelIdsWire(['ok', 7]),
    Error,
  );
});
