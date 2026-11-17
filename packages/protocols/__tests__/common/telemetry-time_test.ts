import { describe, expect, it } from 'vitest';

import { createTelemetryBucket, isTelemetryBucketGranularity, parseTelemetryHour, telemetryHourKey } from '../../src/common/telemetry-time.ts';

describe('telemetry hour boundaries', () => {
  it('accepts only real UTC source hours', () => {
    expect(telemetryHourKey(parseTelemetryHour('2026-05-05T20'))).toBe('2026-05-05T20');
    for (const value of ['2026-02-30T20', '2026-05-05T24', '2026-05-05T20:30', '2026-05-05T20Z']) {
      expect(() => parseTelemetryHour(value)).toThrow(RangeError);
    }
    expect(() => telemetryHourKey(Date.UTC(2026, 4, 5, 20, 30))).toThrow(RangeError);
  });
});

describe('telemetry calendar buckets', () => {

  it('anchors multi-day buckets across month and DST boundaries', () => {
    const map = createTelemetryBucket({ bucket: '3d', start: '2026-10-30T04', timeZone: 'America/New_York', timezoneOffsetMinutes: 240 });
    expect(map('2026-11-02T04')).toBe('2026-10-30');
    expect(map('2026-11-02T05')).toBe('2026-11-02');
    expect(map('2026-11-05T04')).toBe('2026-11-02');
    expect(map('2026-11-05T05')).toBe('2026-11-05');
  });

  it('accepts canonical positive day spans and rejects invalid wire grains', () => {
    for (const value of ['2h', '6h', '12h', '1d', '2d', '1530d']) expect(isTelemetryBucketGranularity(value)).toBe(true);
    for (const value of ['0d', '-2d', '2.5d', '02d', '1e3d', '9007199254740992d', '3h']) expect(isTelemetryBucketGranularity(value)).toBe(false);
  });

  it('retains the requested local wall clock through the repeated DST hour', () => {
    const map = createTelemetryBucket({ bucket: 'hour', timeZone: 'America/New_York', timezoneOffsetMinutes: 240 });
    expect(map('2026-11-01T05')).toBe('2026-11-01T01');
    expect(map('2026-11-01T06')).toBe('2026-11-01T01');
  });

  it('aligns weeks to Monday even across a year boundary', () => {
    const map = createTelemetryBucket({ bucket: 'week', timeZone: 'Asia/Singapore', timezoneOffsetMinutes: 0 });
    expect(map('2025-12-31T20')).toBe('2025-12-29');
    expect(map('2026-01-04T16')).toBe('2026-01-05');
  });
});
