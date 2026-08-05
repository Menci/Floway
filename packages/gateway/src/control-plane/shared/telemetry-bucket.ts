export type TelemetryBucketGranularity = 'hour' | '4h' | '8h' | 'day' | 'all';

export interface TelemetryBucketOptions {
  bucket: TelemetryBucketGranularity;
  timeZone?: string;
  timezoneOffsetMinutes: number;
}

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
    if (bucket === 'hour') return hour;
    const utcMs = Date.parse(`${hour}:00:00Z`);
    const local = formatter === null
      ? new Date(utcMs - timezoneOffsetMinutes * 60_000).toISOString().slice(0, 13)
      : (() => {
          const parts = formatter.formatToParts(new Date(utcMs));
          return `${part(parts, 'year')}-${part(parts, 'month')}-${part(parts, 'day')}T${part(parts, 'hour')}`;
        })();
    if (bucket === 'day') return local.slice(0, 10);
    const hourOfDay = Number(local.slice(11, 13));
    const divisor = bucket === '4h' ? 4 : 8;
    const aligned = hourOfDay - (hourOfDay % divisor);
    return `${local.slice(0, 11)}${String(aligned).padStart(2, '0')}`;
  };
};
