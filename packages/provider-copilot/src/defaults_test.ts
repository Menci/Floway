import { test } from 'vitest';

import { defaultFlagsForCopilotModel } from './defaults.ts';
import type { ProviderModel } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

// Minimal ProviderModel stand-in — defaultFlagsForCopilotModel only reads `id`,
// so `kind`/`endpoints`/`limits` can be blank shape-satisfiers.
const model = (id: string): Omit<ProviderModel, 'enabledFlags'> => ({
  id,
  kind: 'chat',
  endpoints: {},
  limits: {},
});

const OVERLAY_ON = { 'demote-interleaved-system-to-user': true } as const;
const OVERLAY_OFF = {} as const;

// Copilot's public model ids arrive here in dash-separated minor form
// (finalizeCopilotModels routes them through copilotPublicModelId, which
// rewrites `4.8` → `4-8`). Parsing must therefore accept dashes; whole-
// number releases (`claude-sonnet-5`) skip the minor slot and count as
// `[N, 0]`. Sub-family names are treated as opaque — the version tuple
// is the sole gate, so a future `claude-<newfamily>-<N.M>` routes the
// same way as opus/sonnet/haiku.
test('defaultFlagsForCopilotModel forces demote on Claude < 4.8', () => {
  assertEquals(defaultFlagsForCopilotModel(model('claude-opus-4-7')), OVERLAY_ON);
  assertEquals(defaultFlagsForCopilotModel(model('claude-sonnet-4-6')), OVERLAY_ON);
  assertEquals(defaultFlagsForCopilotModel(model('claude-haiku-4-5')), OVERLAY_ON);
  assertEquals(defaultFlagsForCopilotModel(model('claude-opus-3-5')), OVERLAY_ON);
  assertEquals(defaultFlagsForCopilotModel(model('claude-newfamily-4-7')), OVERLAY_ON);
});

test('defaultFlagsForCopilotModel leaves demote inherited for Claude >= 4.8', () => {
  assertEquals(defaultFlagsForCopilotModel(model('claude-opus-4-8')), OVERLAY_OFF);
  assertEquals(defaultFlagsForCopilotModel(model('claude-opus-5-0')), OVERLAY_OFF);
  assertEquals(defaultFlagsForCopilotModel(model('claude-sonnet-5')), OVERLAY_OFF);
  assertEquals(defaultFlagsForCopilotModel(model('claude-haiku-6')), OVERLAY_OFF);
  assertEquals(defaultFlagsForCopilotModel(model('claude-newfamily-5-0')), OVERLAY_OFF);
});

test('defaultFlagsForCopilotModel accepts dotted minor form for forward-compat', () => {
  assertEquals(defaultFlagsForCopilotModel(model('claude-opus-4.7')), OVERLAY_ON);
  assertEquals(defaultFlagsForCopilotModel(model('claude-opus-4.8')), OVERLAY_OFF);
});

test('defaultFlagsForCopilotModel returns empty for non-Claude ids', () => {
  assertEquals(defaultFlagsForCopilotModel(model('gpt-5')), OVERLAY_OFF);
  assertEquals(defaultFlagsForCopilotModel(model('gpt-4o')), OVERLAY_OFF);
  assertEquals(defaultFlagsForCopilotModel(model('o1-mini')), OVERLAY_OFF);
});

test('defaultFlagsForCopilotModel falls back to demote-on when a Claude id carries no version', () => {
  // Safer than defaulting off — a Claude id we cannot version-parse
  // might route through Vertex, which still rejects inline system turns.
  // Only a positive supportsInlineSystem match (regex + `>= 4.8` version
  // tuple) flips the overlay to empty.
  assertEquals(defaultFlagsForCopilotModel(model('claude-opus')), OVERLAY_ON);
  assertEquals(defaultFlagsForCopilotModel(model('claude-sonnet-4-5-20250929')), OVERLAY_ON);
});
