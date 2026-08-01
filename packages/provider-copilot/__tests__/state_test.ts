import { test } from 'vitest';

import { assertCopilotUpstreamState, readCopilotUpstreamState, type CopilotUpstreamState } from '../src/state.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

test('readCopilotUpstreamState passes through a complete new-shape entry verbatim', () => {
  const seeded = {
    knownModels: null,
    copilotToken: { token: 'tok', expiresAt: 2_000_000, baseUrl: 'https://api.individual.githubcopilot.com' },
    quotaSnapshot: null,
  } satisfies CopilotUpstreamState;
  const round = readCopilotUpstreamState(JSON.parse(JSON.stringify(seeded)));
  assertEquals(round.copilotToken, seeded.copilotToken);
});

// Regression: pre-refactor rows persisted `{token, expiresAt}` without
// baseUrl. The strict asserter must throw on read so the data-plane call
// fails loudly until migration 0037_copilot_drop_legacy_state_shape strips
// the partial entry; treating the legacy shape as "stale token, refresh
// silently" would have hidden a real data-shape drift behind a refresh
// loop, and CLAUDE.md disallows code-level compat for old data shapes.
test('readCopilotUpstreamState throws on a legacy copilotToken entry that lacks baseUrl', () => {
  const legacy = {
    knownModels: null,
    copilotToken: { token: 'tok', expiresAt: 2_000_000 },
  };
  assertThrows(
    () => readCopilotUpstreamState(legacy),
    TypeError,
    'CopilotUpstreamState.copilotToken.baseUrl must be a non-empty string',
  );
});

test('readCopilotUpstreamState treats a copilotToken:null state as valid', () => {
  const round = readCopilotUpstreamState({ knownModels: null, copilotToken: null });
  assertEquals(round.copilotToken, null);
});

test('readCopilotUpstreamState treats a state without copilotToken key as valid', () => {
  const round = readCopilotUpstreamState({ knownModels: null });
  assertEquals(round.copilotToken, null);
});

test('readCopilotUpstreamState collapses null/undefined raw to empty state', () => {
  assertEquals(readCopilotUpstreamState(null), { knownModels: null, copilotToken: null, quotaSnapshot: null });
  assertEquals(readCopilotUpstreamState(undefined), { knownModels: null, copilotToken: null, quotaSnapshot: null });
});

test('assertCopilotUpstreamState rejects an unknown top-level key', () => {
  assertThrows(
    () => assertCopilotUpstreamState({ knownModels: null, copilotToken: null, unexpected: 1 }),
    TypeError,
    "CopilotUpstreamState has unexpected key 'unexpected'",
  );
});

test('assertCopilotUpstreamState rejects an unknown key inside copilotToken', () => {
  assertThrows(
    () => assertCopilotUpstreamState({
      knownModels: null,
      copilotToken: { token: 'tok', expiresAt: 1, baseUrl: 'https://api.individual.githubcopilot.com', unexpected: true },
    }),
    TypeError,
    "CopilotUpstreamState.copilotToken has unexpected key 'unexpected'",
  );
});

// A key that also names an Object.prototype member is still an unknown key.
test('assertCopilotUpstreamState rejects prototype-named keys', () => {
  for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assertThrows(
      () => assertCopilotUpstreamState(JSON.parse(`{"knownModels":null,"copilotToken":null,"${key}":1}`)),
      TypeError,
      `CopilotUpstreamState has unexpected key '${key}'`,
    );
    assertThrows(
      () => assertCopilotUpstreamState(JSON.parse(
        `{"knownModels":null,"copilotToken":{"token":"tok","expiresAt":1,"baseUrl":"https://api.individual.githubcopilot.com","${key}":1}}`,
      )),
      TypeError,
      `CopilotUpstreamState.copilotToken has unexpected key '${key}'`,
    );
  }
});
