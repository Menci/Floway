import { test } from 'vitest';

import { isKnownFlagId, OPTIONAL_FLAGS, resolveEffectiveFlags } from '../src/flags.ts';
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

test('provider flags: resolveEffectiveFlags — no layers → empty set', () => {
  const set = resolveEffectiveFlags([]);
  assertEquals([...set].sort(), []);
});

test('provider flags: resolveEffectiveFlags — a layer with a true flag adds it', () => {
  const set = resolveEffectiveFlags([{ 'retry-cyber-policy': true }]);
  assertEquals([...set].sort(), ['retry-cyber-policy']);
});

test('provider flags: resolveEffectiveFlags — a later layer can force-off an earlier true', () => {
  const set = resolveEffectiveFlags([
    { 'retry-cyber-policy': true },
    { 'retry-cyber-policy': false },
  ]);
  assertEquals([...set].sort(), []);
});

test('provider flags: resolveEffectiveFlags — a still-later layer can force-on again', () => {
  const set = resolveEffectiveFlags([
    { 'retry-cyber-policy': true },
    { 'retry-cyber-policy': false },
    { 'retry-cyber-policy': true },
  ]);
  assertEquals([...set].sort(), ['retry-cyber-policy']);
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
  const set = resolveEffectiveFlags([undefined, { 'retry-cyber-policy': true }, undefined]);
  assertEquals([...set].sort(), ['retry-cyber-policy']);
});
