import { test } from 'vitest';

import { OPTIONAL_FLAG_IDS, resolveEffectiveFlags } from '../src/flags.ts';
import { assertEquals } from '@floway-dev/test-utils';

const FLAG_ID_PATTERN = /^[a-z][a-z0-9-]+$/;

test('provider flags: every catalog id is kebab-case', () => {
  for (const id of OPTIONAL_FLAG_IDS) {
    assertEquals(FLAG_ID_PATTERN.test(id), true, `id ${id} must be kebab-case`);
  }
});

// Layer precedence is one rule applied consistently: later layers win, a `true`
// adds, a `false` removes (including a flag an earlier layer added), and an
// absent key inherits. Each row is one position in that order.
test.each([
  ['no layers', [], []],
  ['a true flag adds it', [{ 'strip-prompt-cache-key': true }], ['strip-prompt-cache-key']],
  ['a later layer forces off an earlier true', [{ 'strip-prompt-cache-key': true }, { 'strip-prompt-cache-key': false }], []],
  ['a still-later layer forces on again', [{ 'strip-prompt-cache-key': true }, { 'strip-prompt-cache-key': false }, { 'strip-prompt-cache-key': true }], ['strip-prompt-cache-key']],
  ['an upstream force-on adds a flag', [{ 'vendor-deepseek': true }], ['vendor-deepseek']],
  ['a model force-off wins over an upstream force-on', [{ 'vendor-deepseek': true }, { 'vendor-deepseek': false }], []],
  ['a later layer wins when both set the same flag', [{ 'vendor-qwen': false }, { 'vendor-qwen': true }], ['vendor-qwen']],
  ['undefined layers are skipped', [undefined, { 'strip-prompt-cache-key': true }, undefined], ['strip-prompt-cache-key']],
])('provider flags: resolveEffectiveFlags — %s', (_label, layers, expected) => {
  assertEquals([...resolveEffectiveFlags(layers as Parameters<typeof resolveEffectiveFlags>[0])].sort(), expected);
});
