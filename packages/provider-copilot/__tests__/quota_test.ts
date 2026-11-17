import { expect, test, vi } from 'vitest';

import { fetchCopilotUsage, parseCopilotQuotaHeaders, projectCopilotSeat, projectCopilotUsageResponse, putCopilotQuota, type CopilotUsageResponse } from '../src/quota.ts';
import { directFetcher, initProviderRepo } from '@floway-dev/provider';
import { assertEquals, withMockedFetch } from '@floway-dev/test-utils';

const NOW = new Date('2026-08-01T19:42:34.000Z');

test('fetchCopilotUsage reads quota from the selected GHE.com tenant API', async () => {
  await withMockedFetch(
    request => {
      assertEquals(request.url, 'https://api.octocorp.ghe.com/copilot_internal/user');
      assertEquals(request.headers.get('authorization'), 'token ghu_ghe');
      return new Response('{}');
    },
    async () => {
      const response = await fetchCopilotUsage('octocorp.ghe.com', 'ghu_ghe', directFetcher);
      assertEquals(response.status, 200);
    },
  );
});

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

// A body on the pre-2026-06 shape leaves `quota_snapshots` empty or absent and
// reports through `limited_user_quotas`, which we do not read. Same null
// contract as the header path: no buckets is "nothing observed", so an
// operator's refresh against such a body neither fails nor overwrites what the
// headers already harvested.
test('projectCopilotUsageResponse reports a body with no quota buckets as no observation', () => {
  assertEquals(projectCopilotUsageResponse({}, NOW), null);
  assertEquals(projectCopilotUsageResponse({ quota_snapshots: {} }, NOW), null);
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

test('putCopilotQuota rejects malformed entitlement before writing state or metrics', async () => {
  const saveState = vi.fn();
  const recordUpstreamMetric = vi.fn();
  initProviderRepo(() => ({
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

// "Nothing observed" rather than "a seat with no plan": the operator's refresh
// must not blank a reading an earlier one stored.
test('the seat projection reports nothing when the body names neither', () => {
  assertEquals(projectCopilotSeat({ quota_snapshots: {} }, NOW), null);
  assertEquals(projectCopilotSeat({ copilot_plan: '', access_type_sku: '' }, NOW), null);
});
