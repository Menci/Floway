import { describe, expect, test } from 'vitest';

import { CURSOR_CONTEXT_TTL_MS, clearContextThrottleForTesting, contextCacheKey, readObservedContext, shouldPersistContext, withObservedContext } from './context-window.ts';
import type { CursorUpstreamState } from './state.ts';

const baseState = (): CursorUpstreamState => ({
  accounts: [{ userId: 'u1', refresh_token: 'r', state: 'active', state_updated_at: 'x', accessToken: null }],
});

describe('contextCacheKey', () => {
  test('separates the two Max-Mode variants', () => {
    expect(contextCacheKey('claude-opus-4-8', false)).toBe('norm:claude-opus-4-8');
    expect(contextCacheKey('claude-opus-4-8', true)).toBe('max:claude-opus-4-8');
  });
});

describe('withObservedContext / readObservedContext', () => {
  const now = 1_000_000;

  test('round-trips an observation for the matching mode', () => {
    const state = withObservedContext(baseState(), 'claude-opus-4-8', false, 200_000, now);
    expect(readObservedContext(state, 'claude-opus-4-8', false, now)).toBe(200_000);
    // Different mode is a separate slot — no bleed.
    expect(readObservedContext(state, 'claude-opus-4-8', true, now)).toBeNull();
  });

  test('is a pure copy — original state is untouched', () => {
    const state = baseState();
    const next = withObservedContext(state, 'gpt-5.5', false, 272_000, now);
    expect(state.modelContext).toBeUndefined();
    expect(next.modelContext).toEqual({ 'norm:gpt-5.5': { maxTokens: 272_000, at: now } });
  });

  test('returns null for an unknown model and for a stale entry', () => {
    const state = withObservedContext(baseState(), 'gpt-5.5', false, 272_000, now);
    expect(readObservedContext(state, 'composer-2.5', false, now)).toBeNull();
    expect(readObservedContext(state, 'gpt-5.5', false, now + CURSOR_CONTEXT_TTL_MS + 1)).toBeNull();
    expect(readObservedContext(state, 'gpt-5.5', false, now + CURSOR_CONTEXT_TTL_MS - 1)).toBe(272_000);
  });
});

describe('shouldPersistContext throttle', () => {
  test('allows the first attempt then suppresses within the TTL, per model+mode', () => {
    clearContextThrottleForTesting();
    const now = 5_000_000;
    expect(shouldPersistContext('up', 'gpt-5.5', false, now)).toBe(true);
    expect(shouldPersistContext('up', 'gpt-5.5', false, now + 1000)).toBe(false); // throttled
    expect(shouldPersistContext('up', 'gpt-5.5', true, now)).toBe(true); // other mode, distinct
    expect(shouldPersistContext('up2', 'gpt-5.5', false, now)).toBe(true); // other upstream, distinct
    expect(shouldPersistContext('up', 'gpt-5.5', false, now + CURSOR_CONTEXT_TTL_MS + 1)).toBe(true); // past TTL
  });
});
