import { describe, expect, it } from 'vitest';

import { createTelemetryBucket, parseTelemetryHour, telemetryHourKey } from '../../src/common/telemetry-time.ts';

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
  it('aligns weeks to Monday even across a year boundary', () => {
    const map = createTelemetryBucket({ bucket: 'week', timeZone: 'Asia/Singapore', timezoneOffsetMinutes: 0 });
    expect(map('2025-12-31T20')).toBe('2025-12-29');
    expect(map('2026-01-04T16')).toBe('2026-01-05');
  });

  it('groups months and years by the requested local calendar', () => {
    const options = { timeZone: 'Asia/Singapore', timezoneOffsetMinutes: 0 };
    expect(createTelemetryBucket({ ...options, bucket: 'month' })('2026-04-30T20')).toBe('2026-05');
    expect(createTelemetryBucket({ ...options, bucket: 'year' })('2025-12-31T20')).toBe('2026');
  });

  it('preserves UTC instants for hourly dashboard buckets', () => {
    const map = createTelemetryBucket({ bucket: 'hour', timeZone: 'UTC', timezoneOffsetMinutes: 0 });
    expect(map('2026-11-01T05')).not.toBe(map('2026-11-01T06'));
  });
});
