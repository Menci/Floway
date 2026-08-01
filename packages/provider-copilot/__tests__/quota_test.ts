import { test } from 'vitest';

import { parseCopilotQuotaHeaders, projectCopilotUsageResponse, type CopilotUsageResponse } from '../src/quota.ts';
import { assertEquals } from '@floway-dev/test-utils';

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

// Copilot names its buckets in an open string — `premium_models` shows up
// alongside the three above — so an unfamiliar id is kept, not dropped.
test('parseCopilotQuotaHeaders keeps a quota id it has never seen', () => {
  const snapshot = parseCopilotQuotaHeaders(
    new Headers({ 'x-quota-snapshot-premium_models': 'ent=1000&ov=0.0&ovPerm=false&rem=42.5&rst=2026-09-01T00%3A00%3A00Z&totRem=425' }),
    NOW,
  );

  assertEquals(snapshot?.quotas.premium_models.quota_remaining, 425);
});

test('parseCopilotQuotaHeaders returns null when the response carries no quota headers', () => {
  assertEquals(parseCopilotQuotaHeaders(new Headers({ 'x-request-id': 'r1' }), NOW), null);
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
    access_type_sku: 'copilot_pro',
    copilot_plan: 'individual',
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

// The REST body is the only source for a seat that has never served a request,
// and it may omit the UTC reset instant; the snapshot says so rather than
// inventing one.
test('projectCopilotUsageResponse reports a missing reset instant as null', () => {
  const projected = projectCopilotUsageResponse({
    access_type_sku: 'copilot_pro',
    copilot_plan: 'individual',
    quota_snapshots: {
      premium_interactions: {
        entitlement: 300,
        overage_count: 0,
        overage_permitted: false,
        percent_remaining: 90,
        quota_remaining: 270,
        unlimited: false,
      },
    },
  }, NOW);

  assertEquals(projected?.reset_at, null);
  assertEquals(projected?.quotas.premium_interactions.quota_remaining, 270);
});

// A free / limited seat omits `quota_snapshots` entirely and reports through
// `limited_user_quotas` instead. Same null contract as the header path: no
// buckets is "nothing observed", so an operator's refresh on such a seat
// neither fails nor overwrites what the headers already harvested.
test('projectCopilotUsageResponse reports a body with no quota buckets as no observation', () => {
  assertEquals(projectCopilotUsageResponse({
    access_type_sku: 'free_limited_copilot',
    copilot_plan: 'free',
  }, NOW), null);
  assertEquals(projectCopilotUsageResponse({
    access_type_sku: 'copilot_pro',
    copilot_plan: 'individual',
    quota_snapshots: {},
  }, NOW), null);
});
