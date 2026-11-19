import { test } from 'vitest';

import { defaultFlagsForCopilotModel } from '../src/defaults.ts';
import type { ProviderModel } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

// Minimal ProviderModel stand-in — defaultFlagsForCopilotModel only reads `id`,
// so `kind`/`endpoints`/`limits` can be blank shape-satisfiers.
const model = (id: string): Omit<ProviderModel, 'enabledFlags'> => ({
  id,
  upstreamModelId: id,
  opaqueBlobCompatibilityScope: { bindToUpstream: true },
  kind: 'chat',
  endpoints: {},
  limits: {},
});

const DISALLOWED_ONLY = { 'rewrite-disallowed-mid-conv-system-to-user': true } as const;
const REWRITE_ALL = {
  'rewrite-disallowed-mid-conv-system-to-user': true,
  'rewrite-mid-conv-system-to-user': true,
} as const;

test('defaultFlagsForCopilotModel rewrites only invalid placement for Claude >= 4.8', () => {
  assertEquals(defaultFlagsForCopilotModel(model('claude-opus-4-8')), DISALLOWED_ONLY);
  assertEquals(defaultFlagsForCopilotModel(model('claude-sonnet-5')), DISALLOWED_ONLY);
  assertEquals(defaultFlagsForCopilotModel(model('claude-newfamily-5-0')), DISALLOWED_ONLY);
});

test('defaultFlagsForCopilotModel falls back to rewrite-on when a Claude id carries no version', () => {
  // Safer than defaulting off — a Claude id we cannot version-parse
  // might route through Vertex, which still rejects inline system turns.
  // Only a positive supportsInlineSystem match (regex + `>= 4.8` version
  // tuple) narrows the overlay to invalid-placement rewriting.
  assertEquals(defaultFlagsForCopilotModel(model('claude-opus')), REWRITE_ALL);
  assertEquals(defaultFlagsForCopilotModel(model('claude-sonnet-4-5-20250929')), REWRITE_ALL);
});
