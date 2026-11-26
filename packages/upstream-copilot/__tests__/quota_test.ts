import { expect, test, vi } from 'vitest';

import { parseCopilotQuotaHeaders, projectCopilotUsageResponse, putCopilotQuota, type CopilotUsageResponse } from '../src/quota.ts';
import { assertEquals } from '@floway-dev/test-utils';
import { initUpstreamRuntimeRepo } from '@floway-dev/upstream';

const NOW = new Date('2026-08-01T19:42:34.000Z');

// Verbatim from a live enterprise seat's /chat/completions response.
const liveHeaders = (): Headers => new Headers({
  'x-quota-snapshot-chat': 'ent=-1&ov=0.0&ovPerm=false&rem=100.0&rst=2026-09-01T00%3A00%3A00Z&totRem=-1',
  'x-quota-snapshot-completions': 'ent=-1&ov=0.0&ovPerm=false&rem=100.0&rst=2026-09-01T00%3A00%3A00Z&totRem=-1',
  'x-quota-snapshot-premium_interactions': 'ent=10000000&ov=0.0&ovPerm=true&rem=97.1&rst=2026-09-01T00%3A00%3A00Z&totRem=9719759.1',
  'x-request-id': '6DCA4747-6149-496A-AAD8-BD82A1D5D6F5',
});

test('parseCopilotQuotaHeaders reads every bucket a live response reports', () => {
  const snapshot = parseCopilotQuotaHeaders(liveHeaders(), NOW);

  assertEquals(snapshot?.observed_at, '2026-08-01T19:42:34.000Z');
  assertEquals(snapshot?.reset_at, '2026-09-01T00:00:00Z');
  assertEquals(Object.keys(snapshot?.quotas ?? {}).sort(), ['chat', 'completions', 'premium_interactions']);
  assertEquals(snapshot?.quotas.premium_interactions, {
    entitlement: 10_000_000,
    overage_count: 0,
    overage_permitted: true,
    percent_remaining: 97.1,
    quota_remaining: 9_719_759.1,
    unlimited: false,
  });
  // `ent=-1` is the unlimited sentinel the REST body reports as a separate flag.
  assertEquals(snapshot?.quotas.chat.unlimited, true);
  assertEquals(snapshot?.quotas.chat.entitlement, -1);
});

// A half-parsed bucket would render as a confident zero on the dashboard, so
// it is dropped while its well-formed siblings survive.
test('parseCopilotQuotaHeaders drops a bucket missing a numeric field', () => {
  const snapshot = parseCopilotQuotaHeaders(
    new Headers({
      'x-quota-snapshot-chat': 'ovPerm=false&rst=2026-09-01T00%3A00%3A00Z',
      'x-quota-snapshot-premium_interactions': 'ent=300&ov=0.0&ovPerm=false&rem=90.0&rst=2026-09-01T00%3A00%3A00Z&totRem=270',
    }),
    NOW,
  );

  assertEquals(Object.keys(snapshot?.quotas ?? {}), ['premium_interactions']);
});

test('parseCopilotQuotaHeaders ignores a prototype-polluting quota id', () => {
  const snapshot = parseCopilotQuotaHeaders(
    new Headers({
      'x-quota-snapshot-__proto__': 'ent=1&ov=0.0&ovPerm=false&rem=1.0&rst=2026-09-01T00%3A00%3A00Z&totRem=1',
      'x-quota-snapshot-chat': 'ent=300&ov=0.0&ovPerm=false&rem=90.0&rst=2026-09-01T00%3A00%3A00Z&totRem=270',
    }),
    NOW,
  );

  assertEquals(Object.keys(snapshot?.quotas ?? {}), ['chat']);
  assertEquals(Object.getPrototypeOf(snapshot?.quotas ?? {}), Object.prototype);
});

test('projectCopilotUsageResponse lands on the same shape the headers produce', () => {
  const body: CopilotUsageResponse = {
    quota_reset_date_utc: '2026-09-01T00:00:00.000Z',
    quota_snapshots: {
      premium_interactions: {
        entitlement: 10_000_000,
        overage_count: 0,
        overage_permitted: true,
        percent_remaining: 97.1,
        quota_remaining: 9_719_759.1,
        unlimited: false,
      },
    },
  };

  const projected = projectCopilotUsageResponse(body, NOW);
  const fromHeaders = parseCopilotQuotaHeaders(liveHeaders(), NOW);

  assertEquals(projected?.quotas.premium_interactions, fromHeaders?.quotas.premium_interactions);
  assertEquals(projected?.observed_at, '2026-08-01T19:42:34.000Z');
  assertEquals(projected?.reset_at, '2026-09-01T00:00:00.000Z');
});

// Every field on this endpoint is optional per GitHub's own SDK schema. A
// bucket without a cap or a remainder cannot be rendered honestly, so it is
// dropped the way the header path drops a half-parsed one.
test('projectCopilotUsageResponse drops a bucket whose cap or remainder is missing', () => {
  const projected = projectCopilotUsageResponse({
    quota_snapshots: {
      chat: { percent_remaining: 50 },
      completions: { entitlement: 2000, quota_remaining: 1500 },
    },
  }, NOW);

  assertEquals(Object.keys(projected?.quotas ?? {}), ['completions']);
});

test('putCopilotQuota rejects malformed entitlement before writing state or metrics', async () => {
  const saveState = vi.fn();
  const recordUpstreamMetric = vi.fn();
  initUpstreamRuntimeRepo(() => ({
    recordUpstreamMetric,
    upstreams: { getById: vi.fn(), saveState },
  }));

  await expect(putCopilotQuota('copilot', {
    observed_at: NOW.toISOString(),
    reset_at: null,
    quotas: {
      malformed: { entitlement: -2, quota_remaining: 0, percent_remaining: 0, overage_count: 0, overage_permitted: false, unlimited: false },
    },
  })).rejects.toThrow(TypeError);
  expect(saveState).not.toHaveBeenCalled();
  expect(recordUpstreamMetric).not.toHaveBeenCalled();
});
