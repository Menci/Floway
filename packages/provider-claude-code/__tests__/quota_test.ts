import { describe, expect, test } from 'vitest';

import { parseClaudeCodeQuotaHeaders } from '../src/quota.ts';

// Captured from a real Anthropic /v1/messages?beta=true response on the
// Sonnet 4.5 plan tier, 2026-06-19. Used as the primary parser fixture.
// `anthropic-ratelimit-unified-fallback: available` is the steady-state
// signal — Anthropic sends it on every successful response to mean "a
// degraded-mode fallback service is reachable if primary capacity flips".
const fullProbeHeaders = new Headers({
  'anthropic-ratelimit-unified-status': 'allowed',
  'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-5h-reset': '1781805000',
  'anthropic-ratelimit-unified-5h-utilization': '0.0',
  'anthropic-ratelimit-unified-7d-status': 'allowed',
  'anthropic-ratelimit-unified-7d-reset': '1782039600',
  'anthropic-ratelimit-unified-7d-utilization': '0.0',
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  'anthropic-ratelimit-unified-fallback': 'available',
  'anthropic-ratelimit-unified-fallback-percentage': '0.5',
  'anthropic-ratelimit-unified-reset': '1781805000',
  'anthropic-ratelimit-unified-overage-disabled-reason': 'out_of_credits',
  'anthropic-ratelimit-unified-overage-status': 'rejected',
});

// Older / pre-5h-7d shape: only representative-claim, reset, fallback
// percentage, and overage status.
const olderShapeHeaders = new Headers({
  'anthropic-ratelimit-unified-status': 'allowed_warning',
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  'anthropic-ratelimit-unified-reset': '1781805000',
  'anthropic-ratelimit-unified-fallback-percentage': '0.5',
  'anthropic-ratelimit-unified-overage-status': 'allowed',
});

describe('parseClaudeCodeQuotaHeaders — newer 5h/7d shape', () => {
  const snap = parseClaudeCodeQuotaHeaders(fullProbeHeaders);

  test('parses top-level fields', () => {
    expect(snap.status).toBe('allowed');
    expect(snap.representativeClaim).toBe('five_hour');
    expect(snap.fallbackPercentage).toBe(0.5);
    expect(snap.fallbackAvailable).toBe(true);
    expect(snap.reset).toBe(new Date(1781805000 * 1000).toISOString());
  });

  test('parses 5h window', () => {
    expect(snap.fiveHour).toEqual({
      status: 'allowed',
      utilization: 0,
      reset: new Date(1781805000 * 1000).toISOString(),
    });
  });

  test('parses 7d window', () => {
    expect(snap.sevenDay).toEqual({
      status: 'allowed',
      utilization: 0,
      reset: new Date(1782039600 * 1000).toISOString(),
      surpassedThreshold: null,
    });
  });

  test('parses overage block including disabledReason', () => {
    expect(snap.overage).toEqual({
      status: 'rejected',
      reset: null,
      utilization: null,
      disabledReason: 'out_of_credits',
    });
  });

  test('mirrors every anthropic-ratelimit-* header into raw', () => {
    expect(snap.raw).toMatchObject({
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-reset': '1781805000',
      'anthropic-ratelimit-unified-overage-status': 'rejected',
      'anthropic-ratelimit-unified-fallback': 'available',
    });
    expect(Object.keys(snap.raw)).toHaveLength(13);
  });
});

describe('parseClaudeCodeQuotaHeaders — older shape without 5h/7d', () => {
  const snap = parseClaudeCodeQuotaHeaders(olderShapeHeaders);

  test('5h/7d nested objects come out null when their headers are absent', () => {
    expect(snap.fiveHour).toBeNull();
    expect(snap.sevenDay).toBeNull();
  });

  test('overage parses with the fields present and nulls the missing ones', () => {
    expect(snap.overage).toEqual({
      status: 'allowed',
      reset: null,
      utilization: null,
      disabledReason: null,
    });
  });

  test('keeps top-level fields populated', () => {
    expect(snap.status).toBe('allowed_warning');
    expect(snap.representativeClaim).toBe('five_hour');
    expect(snap.fallbackPercentage).toBe(0.5);
    expect(snap.reset).toBe(new Date(1781805000 * 1000).toISOString());
  });

  test('raw map carries only what arrived', () => {
    expect(Object.keys(snap.raw).sort()).toEqual([
      'anthropic-ratelimit-unified-fallback-percentage',
      'anthropic-ratelimit-unified-overage-status',
      'anthropic-ratelimit-unified-representative-claim',
      'anthropic-ratelimit-unified-reset',
      'anthropic-ratelimit-unified-status',
    ]);
  });
});

describe('parseClaudeCodeQuotaHeaders — empty input', () => {
  const snap = parseClaudeCodeQuotaHeaders(new Headers({}));

  test('all known fields read as null and raw is empty', () => {
    expect(snap.status).toBeNull();
    expect(snap.reset).toBeNull();
    expect(snap.fallbackAvailable).toBeNull();
    expect(snap.fallbackPercentage).toBeNull();
    expect(snap.representativeClaim).toBeNull();
    expect(snap.fiveHour).toBeNull();
    expect(snap.sevenDay).toBeNull();
    expect(snap.overage).toBeNull();
    expect(snap.raw).toEqual({});
  });
});

describe('parseClaudeCodeQuotaHeaders — coercion edge cases', () => {
  test('non-numeric reset survives as null', () => {
    const h = new Headers({ 'anthropic-ratelimit-unified-reset': 'soon' });
    expect(parseClaudeCodeQuotaHeaders(h).reset).toBeNull();
  });

  test('7d surpassed-threshold parses as boolean', () => {
    const h = new Headers({
      'anthropic-ratelimit-unified-7d-status': 'allowed_warning',
      'anthropic-ratelimit-unified-7d-surpassed-threshold': 'true',
    });
    expect(parseClaudeCodeQuotaHeaders(h).sevenDay?.surpassedThreshold).toBe(true);
  });

  test('fallback header is the literal token `available` — anything else is `false`', () => {
    expect(parseClaudeCodeQuotaHeaders(new Headers({ 'anthropic-ratelimit-unified-fallback': 'available' })).fallbackAvailable).toBe(true);
    expect(parseClaudeCodeQuotaHeaders(new Headers({ 'anthropic-ratelimit-unified-fallback': 'unavailable' })).fallbackAvailable).toBe(false);
    expect(parseClaudeCodeQuotaHeaders(new Headers({ 'anthropic-ratelimit-unified-fallback': 'true' })).fallbackAvailable).toBe(false);
    // Absence stays null so the dashboard can distinguish "no signal" from
    // "fallback signal with a non-`available` value".
    expect(parseClaudeCodeQuotaHeaders(new Headers({})).fallbackAvailable).toBeNull();
  });

  test('overage utilization parses as number', () => {
    const h = new Headers({
      'anthropic-ratelimit-unified-overage-status': 'allowed',
      'anthropic-ratelimit-unified-overage-utilization': '0.42',
      'anthropic-ratelimit-unified-overage-reset': '1781805000',
    });
    const snap = parseClaudeCodeQuotaHeaders(h);
    expect(snap.overage?.utilization).toBe(0.42);
    expect(snap.overage?.reset).toBe(new Date(1781805000 * 1000).toISOString());
  });
});
