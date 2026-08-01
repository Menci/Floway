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

// A body on the pre-2026-06 shape leaves `quota_snapshots` empty or absent and
// reports through `limited_user_quotas`, which we do not read. Same null
// contract as the header path: no buckets is "nothing observed", so an
// operator's refresh against such a body neither fails nor overwrites what the
// headers already harvested.
test('projectCopilotUsageResponse reports a body with no quota buckets as no observation', () => {
  assertEquals(projectCopilotUsageResponse({}, NOW), null);
  assertEquals(projectCopilotUsageResponse({ quota_snapshots: {} }, NOW), null);
});

// Captured from a live `free_limited_copilot` seat on 2026-07-08
// (https://github.com/TopiCsarno/yapcap/blob/152ea67c3abd44776268627d58533003099da951/fixtures/copilot/copilot_user_response.json).
// The seat meters chat and completions and reports `premium_interactions` as
// `entitlement: 0` — an allotment it does not have, not one it has exhausted.
test('projectCopilotUsageResponse keeps a free seat’s metered buckets and its zero-entitlement one apart', () => {
  const projected = projectCopilotUsageResponse({
    quota_reset_date_utc: '2026-08-01T00:00:00.000Z',
    quota_snapshots: {
      chat: { entitlement: 200, unlimited: false, quota_remaining: 200, percent_remaining: 100, overage_count: 0, overage_permitted: false },
      completions: { entitlement: 2000, unlimited: false, quota_remaining: 2000, percent_remaining: 100, overage_count: 0, overage_permitted: false },
      premium_interactions: { entitlement: 0, unlimited: false, quota_remaining: 0, percent_remaining: 0, overage_count: 0, overage_permitted: false },
    },
  }, NOW);

  assertEquals(projected?.quotas.chat.entitlement, 200);
  assertEquals(projected?.quotas.completions.entitlement, 2000);
  // Projected verbatim; the dashboard reads `entitlement > 0` to tell a bucket
  // the seat does not have from one it has burned through.
  assertEquals(projected?.quotas.premium_interactions.entitlement, 0);
  assertEquals(projected?.quotas.premium_interactions.unlimited, false);
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

// `percent_remaining` is optional; deriving it from the two fields we do
// require is arithmetic, not a default standing in for an unknown.
test('projectCopilotUsageResponse derives percent_remaining when the body omits it', () => {
  const projected = projectCopilotUsageResponse({
    quota_snapshots: {
      completions: { entitlement: 2000, quota_remaining: 1500 },
    },
  }, NOW);

  assertEquals(projected?.quotas.completions.percent_remaining, 75);
});

// Both sources can report an empty reset instant — `rst=` with no value, or
// `quota_reset_date_utc: ""`. Rendering either produces "Invalid Date".
test('both quota sources report an unparseable reset instant as none', () => {
  const fromBody = projectCopilotUsageResponse({
    quota_reset_date_utc: '',
    quota_snapshots: { chat: { entitlement: 200, quota_remaining: 200, percent_remaining: 100 } },
  }, NOW);
  assertEquals(fromBody?.reset_at, null);

  const fromHeaders = parseCopilotQuotaHeaders(
    new Headers({ 'x-quota-snapshot-chat': 'ent=200&ov=0.0&ovPerm=false&rem=100.0&rst=&totRem=200' }),
    NOW,
  );
  assertEquals(fromHeaders?.reset_at, null);
});
