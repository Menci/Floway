import { test } from 'vitest';

import { createTelemetryBucket } from '../../../src/control-plane/shared/telemetry-bucket.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('hour buckets retain the caller-requested local wall clock', () => {
  const bucketFor = createTelemetryBucket({
    bucket: 'hour',
    timeZone: 'America/New_York',
    timezoneOffsetMinutes: 240,
  });

  // The fall-back transition repeats 01:00 with two different UTC offsets.
  assertEquals(bucketFor('2026-11-01T05'), '2026-11-01T01');
  assertEquals(bucketFor('2026-11-01T06'), '2026-11-01T01');
});

test('UTC hour buckets preserve distinct instants across DST fall-back', () => {
  const bucketFor = createTelemetryBucket({
    bucket: 'hour',
    timeZone: 'UTC',
    timezoneOffsetMinutes: 0,
  });

  assertEquals(bucketFor('2026-11-01T05'), '2026-11-01T05');
  assertEquals(bucketFor('2026-11-01T06'), '2026-11-01T06');
});
