import { test } from 'vitest';

import { createTelemetryBucket } from '../../../src/control-plane/shared/telemetry-bucket.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('telemetry buckets use the offset in force at each instant across DST', () => {
  const bucketFor = createTelemetryBucket({
    bucket: 'hour',
    timeZone: 'America/New_York',
    timezoneOffsetMinutes: 240,
  });

  // The fall-back transition repeats 01:00 with two different UTC offsets.
  assertEquals(bucketFor('2026-11-01T05'), '2026-11-01T01');
  assertEquals(bucketFor('2026-11-01T06'), '2026-11-01T01');
});
