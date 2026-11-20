import { test } from 'vitest';

import { resolveEffectiveFlags } from '../src/flags.ts';
import { assertEquals } from '@floway-dev/test-utils';

// Layer precedence is one rule applied consistently: later layers win, a `true`
// adds, a `false` removes (including a flag an earlier layer added), and an
// absent key inherits. Each row is one position in that order.
test.each([
  ['a later layer forces off an earlier true', [{ 'strip-prompt-cache-key': true }, { 'strip-prompt-cache-key': false }], []],
  ['undefined layers are skipped', [undefined, { 'strip-prompt-cache-key': true }, undefined], ['strip-prompt-cache-key']],
])('provider flags: resolveEffectiveFlags — %s', (_label, layers, expected) => {
  assertEquals([...resolveEffectiveFlags(layers as Parameters<typeof resolveEffectiveFlags>[0])].sort(), expected);
});
