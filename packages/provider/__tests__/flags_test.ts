import { test } from 'vitest';

import { isKnownFlagId, OPTIONAL_FLAG_IDS, resolveEffectiveFlags } from '../src/flags.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('provider flags: catalog ids are unique', () => {
  const ids = new Set<string>();
  for (const id of OPTIONAL_FLAG_IDS) {
    assertEquals(ids.has(id), false);
    ids.add(id);
  }
});

test('provider flags: isKnownFlagId agrees with catalog', () => {
  for (const id of OPTIONAL_FLAG_IDS) {
    assertEquals(isKnownFlagId(id), true);
  }
  assertEquals(isKnownFlagId('nonexistent-flag'), false);
});

const FLAG_ID_PATTERN = /^[a-z][a-z0-9-]+$/;

test('provider flags: every catalog id is kebab-case', () => {
  for (const id of OPTIONAL_FLAG_IDS) {
    assertEquals(FLAG_ID_PATTERN.test(id), true, `id ${id} must be kebab-case`);
  }
});

test('provider flags: resolveEffectiveFlags — no layers → empty set', () => {
  const set = resolveEffectiveFlags([]);
  assertEquals([...set].sort(), []);
});

test('provider flags: resolveEffectiveFlags — a layer with a true flag adds it', () => {
  const set = resolveEffectiveFlags([{ 'strip-prompt-cache-key': true }]);
  assertEquals([...set].sort(), ['strip-prompt-cache-key']);
});

test('provider flags: resolveEffectiveFlags — a later layer can force-off an earlier true', () => {
  const set = resolveEffectiveFlags([
    { 'strip-prompt-cache-key': true },
    { 'strip-prompt-cache-key': false },
  ]);
  assertEquals([...set].sort(), []);
});

test('provider flags: resolveEffectiveFlags — a still-later layer can force-on again', () => {
  const set = resolveEffectiveFlags([
    { 'strip-prompt-cache-key': true },
    { 'strip-prompt-cache-key': false },
    { 'strip-prompt-cache-key': true },
  ]);
  assertEquals([...set].sort(), ['strip-prompt-cache-key']);
});

test('provider flags: resolveEffectiveFlags — upstream layer force-on adds a flag', () => {
  const set = resolveEffectiveFlags([{ 'vendor-deepseek': true }]);
  assertEquals([...set].sort(), ['vendor-deepseek']);
});

test('provider flags: resolveEffectiveFlags — model layer force-off wins over upstream force-on', () => {
  const set = resolveEffectiveFlags([
    { 'vendor-deepseek': true },
    { 'vendor-deepseek': false },
  ]);
  assertEquals([...set].sort(), []);
});

test('provider flags: resolveEffectiveFlags — later layer wins when both set the same flag', () => {
  const set = resolveEffectiveFlags([
    { 'vendor-qwen': false },
    { 'vendor-qwen': true },
  ]);
  assertEquals([...set].sort(), ['vendor-qwen']);
});

test('provider flags: resolveEffectiveFlags — undefined layers are skipped', () => {
  const set = resolveEffectiveFlags([undefined, { 'strip-prompt-cache-key': true }, undefined]);
  assertEquals([...set].sort(), ['strip-prompt-cache-key']);
});
