export const TELEMETRY_HOUR_MS = 3_600_000;
export const telemetryBucketGranularities = ['hour', '4h', '8h', 'day', 'week', 'month', 'year', 'all'] as const;
export type TelemetryBucketGranularity = typeof telemetryBucketGranularities[number];

export interface TelemetryBucketOptions {
  bucket: TelemetryBucketGranularity;
  timeZone?: string;
  timezoneOffsetMinutes: number;
}

export const parseTelemetryHour = (hour: string): number => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(hour)) throw new RangeError('Telemetry timestamps must be UTC hours');
  const ms = Date.parse(`${hour}:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 13) !== hour) {
    throw new RangeError('Invalid telemetry UTC hour');
  }
  return ms;
};

export const telemetryHourKey = (ms: number): string => {
  if (!Number.isFinite(ms) || ms % TELEMETRY_HOUR_MS !== 0) throw new RangeError('Telemetry timestamps must align to UTC hours');
  return new Date(ms).toISOString().slice(0, 13);
};

const part = (parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes) => {
  const value = parts.find(candidate => candidate.type === type)?.value;
  if (value === undefined) throw new Error(`Timezone formatter omitted ${type}`);
  return value;
};

export const createTelemetryBucket = ({ bucket, timeZone, timezoneOffsetMinutes }: TelemetryBucketOptions) => {
  const formatter = timeZone === undefined ? null : new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  return (hour: string): string => {
    if (bucket === 'all') return 'all';
    const utcMs = parseTelemetryHour(hour);
    const local = formatter === null
      ? new Date(utcMs - timezoneOffsetMinutes * 60_000).toISOString().slice(0, 13)
      : (() => {
          const parts = formatter.formatToParts(new Date(utcMs));
          return `${part(parts, 'year')}-${part(parts, 'month')}-${part(parts, 'day')}T${part(parts, 'hour')}`;
        })();
    if (bucket === 'hour') return local;
    if (bucket === 'day') return local.slice(0, 10);
    if (bucket === 'month') return local.slice(0, 7);
    if (bucket === 'year') return local.slice(0, 4);
    if (bucket === 'week') {
      const date = new Date(`${local.slice(0, 10)}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
      return date.toISOString().slice(0, 10);
    }
    const hourOfDay = Number(local.slice(11, 13));
    const divisor = bucket === '4h' ? 4 : 8;
    return `${local.slice(0, 11)}${String(hourOfDay - hourOfDay % divisor).padStart(2, '0')}`;
  };
};
