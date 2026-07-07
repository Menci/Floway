import { test } from 'vitest';

import { isKnownFlagId, OPTIONAL_FLAGS } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

test('provider flags: catalog ids are unique', () => {
  const ids = new Set<string>();
  for (const entry of OPTIONAL_FLAGS) {
    assertEquals(ids.has(entry.id), false);
    ids.add(entry.id);
  }
});

test('provider flags: every catalog entry has a non-empty label', () => {
  for (const entry of OPTIONAL_FLAGS) {
    assertEquals(typeof entry.label, 'string');
    assertEquals(entry.label.length > 0, true);
  }
});

test('provider flags: isKnownFlagId agrees with catalog', () => {
  for (const entry of OPTIONAL_FLAGS) {
    assertEquals(isKnownFlagId(entry.id), true);
  }
  assertEquals(isKnownFlagId('nonexistent-flag'), false);
});

const FLAG_ID_PATTERN = /^[a-z][a-z0-9-]+$/;

test('provider flags: every catalog id is kebab-case', () => {
  for (const entry of OPTIONAL_FLAGS) {
    assertEquals(FLAG_ID_PATTERN.test(entry.id), true, `id ${entry.id} must be kebab-case`);
  }
});

test('provider flags: every catalog entry has id, label, description string fields', () => {
  for (const entry of OPTIONAL_FLAGS) {
    assertEquals(typeof entry.id, 'string');
    assertEquals(entry.id.length > 0, true);
    assertEquals(typeof entry.label, 'string');
    assertEquals(typeof entry.description, 'string');
    assertEquals(entry.description.length > 0, true);
  }
});
