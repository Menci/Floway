import { describe, expect, test } from 'vitest';

import { claudeCodeRateLimitedUntil, parseClaudeCodeQuotaHeaders } from '../src/quota.ts';

describe('parseClaudeCodeQuotaHeaders — coercion edge cases', () => {
  test('fallback header is the literal token `available` — anything else is `false`', () => {
    expect(parseClaudeCodeQuotaHeaders(new Headers({ 'anthropic-ratelimit-unified-fallback': 'available' })).fallbackAvailable).toBe(true);
    expect(parseClaudeCodeQuotaHeaders(new Headers({ 'anthropic-ratelimit-unified-fallback': 'true' })).fallbackAvailable).toBe(false);
    // Absence stays null so the dashboard can distinguish "no signal" from
    // "fallback signal with a non-`available` value".
    expect(parseClaudeCodeQuotaHeaders(new Headers({})).fallbackAvailable).toBeNull();
  });
});

describe('claudeCodeRateLimitedUntil', () => {
  const now = Date.parse('2026-11-13T00:00:00Z');
  const sessionReset = '2026-11-13T05:00:00.000Z';
  const weekReset = '2026-11-18T00:00:00.000Z';
  const snapshot = (headers: Record<string, string>, modelId?: string) => ({
    fetchedAt: now,
    modelId,
    data: parseClaudeCodeQuotaHeaders(new Headers({
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-reset': String(Date.parse(weekReset) / 1000),
      ...headers,
    })),
  });

  test.each(['seven_day_overage_included', 'future_model_limit'])('a %s rejection only gates the observed model', claim => {
    const entry = snapshot({ 'anthropic-ratelimit-unified-representative-claim': claim }, 'claude-fable-5-1');
    expect(claudeCodeRateLimitedUntil(entry, now)).toBeNull();
    expect(claudeCodeRateLimitedUntil(entry, now, 'claude-opus-5-5')).toBeNull();
    expect(claudeCodeRateLimitedUntil(entry, now, 'claude-fable-5-1')).toBe(weekReset);
    expect(claudeCodeRateLimitedUntil({ ...entry, modelId: undefined }, now, 'claude-fable-5-1')).toBeNull();
  });

  test('a shared rejection alongside Fable exhaustion uses the shared reset for sibling models', () => {
    const entry = snapshot({
      'anthropic-ratelimit-unified-representative-claim': 'seven_day_overage_included',
      'anthropic-ratelimit-unified-5h-status': 'rejected',
      'anthropic-ratelimit-unified-5h-reset': String(Date.parse(sessionReset) / 1000),
    }, 'claude-fable-5-1');
    expect(claudeCodeRateLimitedUntil(entry, now)).toBe(sessionReset);
    expect(claudeCodeRateLimitedUntil(entry, now, 'claude-opus-5-5')).toBe(sessionReset);
    expect(claudeCodeRateLimitedUntil(entry, now, 'claude-fable-5-1')).toBe(weekReset);
    expect(claudeCodeRateLimitedUntil(entry, Date.parse(sessionReset), 'claude-opus-5-5')).toBeNull();
    expect(claudeCodeRateLimitedUntil(entry, Date.parse(sessionReset), 'claude-fable-5-1')).toBe(weekReset);
  });

  test('extra usage still serves requests while unified status is allowed_warning', () => {
    const entry = snapshot({
      'anthropic-ratelimit-unified-status': 'allowed_warning',
      'anthropic-ratelimit-unified-representative-claim': 'seven_day',
      'anthropic-ratelimit-unified-7d-status': 'rejected',
      'anthropic-ratelimit-unified-7d-reset': String(Date.parse(weekReset) / 1000),
      'anthropic-ratelimit-unified-overage-status': 'allowed',
    }, 'claude-fable-5-1');
    expect(claudeCodeRateLimitedUntil(entry, now, 'claude-fable-5-1')).toBeNull();
  });

  test.each([String(now / 1000), 'invalid'])('an elapsed or unusable reset (%s) cannot gate a request', reset => {
    const entry = snapshot({
      'anthropic-ratelimit-unified-representative-claim': 'seven_day',
      'anthropic-ratelimit-unified-reset': reset,
    });
    expect(claudeCodeRateLimitedUntil(entry, now)).toBeNull();
  });
});
