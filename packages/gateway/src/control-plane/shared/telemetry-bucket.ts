export type TelemetryBucketGranularity = 'hour' | '4h' | '8h' | 'day' | 'all';

export const telemetryBucket = (
  hour: string,
  bucket: TelemetryBucketGranularity,
  timezoneOffsetMinutes: number,
): string => {
  if (bucket === 'all') return 'all';
  const utcMs = Date.parse(`${hour}:00:00Z`);
  const localMs = utcMs - timezoneOffsetMinutes * 60_000;
  const localIso = new Date(localMs).toISOString();
  if (bucket === 'hour') return localIso.slice(0, 13);
  if (bucket === 'day') return localIso.slice(0, 10);
  const hourOfDay = Number(localIso.slice(11, 13));
  const divisor = bucket === '4h' ? 4 : 8;
  const aligned = hourOfDay - (hourOfDay % divisor);
  return `${localIso.slice(0, 11)}${String(aligned).padStart(2, '0')}`;
};
