export const TELEMETRY_HOUR_MS = 3_600_000;
const TELEMETRY_DAY_MS = 24 * TELEMETRY_HOUR_MS;
export const telemetryHourBucketSizes = { hour: 1, '2h': 2, '4h': 4, '6h': 6, '8h': 8, '12h': 12 } as const;
export type TelemetryHourlyBucket = keyof typeof telemetryHourBucketSizes;
export const telemetryBucketGranularities = [...Object.keys(telemetryHourBucketSizes) as TelemetryHourlyBucket[], 'day', 'week', 'month', 'year', 'all'] as const;
type NamedTelemetryBucket = typeof telemetryBucketGranularities[number];
export type TelemetryBucketGranularity = NamedTelemetryBucket | `${number}d`;

interface TelemetryBucketZone {
  timeZone?: string;
  timezoneOffsetMinutes: number;
}
export type TelemetryBucketOptions = TelemetryBucketZone & (
  { bucket: NamedTelemetryBucket; start?: string } | { bucket: `${number}d`; start: string }
);

export const isTelemetryHourlyBucket = (bucket: TelemetryBucketGranularity): bucket is TelemetryHourlyBucket => Object.hasOwn(telemetryHourBucketSizes, bucket);
export const isTelemetryBucketGranularity = (value: unknown): value is TelemetryBucketGranularity => typeof value === 'string' && (
  telemetryBucketGranularities.some(bucket => bucket === value)
  || /^[1-9]\d*d$/.test(value) && Number.isSafeInteger(Number(value.slice(0, -1)))
);

// UTC ordinals index civil dates; actual bucket boundaries retain local DST.
export const telemetryDayOrdinal = (date: string): number => Date.parse(`${date}T00:00:00Z`) / TELEMETRY_DAY_MS;

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

export const createTelemetryBucket = ({ bucket, timeZone, timezoneOffsetMinutes, start }: TelemetryBucketOptions) => {
  if (!isTelemetryBucketGranularity(bucket)) throw new RangeError('Invalid telemetry bucket granularity');
  const formatter = timeZone === undefined ? null : new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  const localTimestamp = (hour: string): string => {
    const utcMs = parseTelemetryHour(hour);
    return formatter === null
      ? new Date(utcMs - timezoneOffsetMinutes * 60_000).toISOString().slice(0, 13)
      : (() => {
          const parts = formatter.formatToParts(new Date(utcMs));
          return `${part(parts, 'year')}-${part(parts, 'month')}-${part(parts, 'day')}T${part(parts, 'hour')}`;
        })();
  };
  const dayBucket = (() => {
    if (!bucket.endsWith('d')) return null;
    if (start === undefined) throw new RangeError('Multi-day telemetry buckets require the query start');
    return { size: Number(bucket.slice(0, -1)), origin: telemetryDayOrdinal(localTimestamp(start).slice(0, 10)) };
  })();
  return (hour: string): string => {
    if (bucket === 'all') return 'all';
    const local = localTimestamp(hour);
    if (dayBucket !== null) {
      const { size, origin } = dayBucket;
      const index = Math.floor((telemetryDayOrdinal(local.slice(0, 10)) - origin) / size);
      return new Date((origin + index * size) * TELEMETRY_DAY_MS).toISOString().slice(0, 10);
    }
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
    const divisor = telemetryHourBucketSizes[bucket as TelemetryHourlyBucket];
    return `${local.slice(0, 11)}${String(hourOfDay - hourOfDay % divisor).padStart(2, '0')}`;
  };
};
