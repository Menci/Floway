import { test } from 'vitest';

import { defaultsForProvider, getFlagCatalog, isKnownFlagId } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

test('provider flags: catalog ids are unique', () => {
  const ids = new Set<string>();
  for (const entry of getFlagCatalog()) {
    assertEquals(ids.has(entry.id), false);
    ids.add(entry.id);
  }
});

test('provider flags: every catalog entry has a non-empty label', () => {
  for (const entry of getFlagCatalog()) {
    assertEquals(typeof entry.label, 'string');
    assertEquals(entry.label.length > 0, true);
  }
});

test('provider flags: isKnownFlagId agrees with catalog', () => {
  for (const entry of getFlagCatalog()) {
    assertEquals(isKnownFlagId(entry.id), true);
  }
  assertEquals(isKnownFlagId('nonexistent-flag'), false);
});

const FLAG_ID_PATTERN = /^[a-z][a-z0-9-]+$/;

test('provider flags: every catalog id is kebab-case', () => {
  for (const entry of getFlagCatalog()) {
    assertEquals(FLAG_ID_PATTERN.test(entry.id), true, `id ${entry.id} must be kebab-case`);
  }
});

test('provider flags: every catalog entry has id, label, description string fields', () => {
  for (const entry of getFlagCatalog()) {
    assertEquals(typeof entry.id, 'string');
    assertEquals(entry.id.length > 0, true);
    assertEquals(typeof entry.label, 'string');
    assertEquals(typeof entry.description, 'string');
    assertEquals(entry.description.length > 0, true);
    assertEquals(Array.isArray(entry.defaultFor), true);
  }
});

test('provider flags: defaultsForProvider returns the catalog-declared defaults', () => {
  const copilotDefaults = [...defaultsForProvider('copilot')].sort();
  assertEquals(copilotDefaults, ['messages-web-search-shim', 'responses-image-generation-shim', 'responses-web-search-shim', 'retry-cyber-policy', 'strip-billing-attribution']);
  const azureDefaults = [...defaultsForProvider('azure')].sort();
  assertEquals(azureDefaults, ['messages-web-search-shim', 'responses-image-generation-shim', 'responses-web-search-shim', 'strip-billing-attribution']);
  assertEquals([...defaultsForProvider('custom')].sort(), ['messages-web-search-shim', 'responses-image-generation-shim', 'responses-web-search-shim', 'strip-billing-attribution']);
  // ollama gets responses-compact-shim by default (no native /v1/responses/compact endpoint).
  assertEquals([...defaultsForProvider('ollama')].sort(), ['messages-web-search-shim', 'responses-compact-shim', 'responses-image-generation-shim', 'responses-web-search-shim', 'strip-billing-attribution']);
  assertEquals([...defaultsForProvider('codex')].sort(), ['strip-billing-attribution']);
  // claude-code gets responses-compact-shim by default (Messages-only — any
  // Responses request that reaches a claude-code candidate needs the shim to
  // simulate compaction; the alternative is a hard reject from the provider).
  assertEquals([...defaultsForProvider('claude-code')].sort(), ['responses-compact-shim']);
});

test('provider flags: defaultsForProvider memoizes the set per provider kind', () => {
  assertEquals(defaultsForProvider('copilot') === defaultsForProvider('copilot'), true);
  assertEquals(defaultsForProvider('azure') === defaultsForProvider('azure'), true);
  assertEquals(defaultsForProvider('custom') === defaultsForProvider('custom'), true);
  assertEquals(defaultsForProvider('claude-code') === defaultsForProvider('claude-code'), true);
});
