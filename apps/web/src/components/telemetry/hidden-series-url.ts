const hiddenSeriesFormatVersion = '2';

const decodeLegacyId = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    if (error instanceof URIError) return value;
    throw error;
  }
};

export const parseHiddenSeries = (search: URLSearchParams, key: string): string[] => {
  const version = search.get(`${key}v`);
  if (version === hiddenSeriesFormatVersion) return search.getAll(key);
  if (version === null) return (search.get(key) ?? '').split(',').map(decodeLegacyId).filter(Boolean);
  throw new RangeError(`Unsupported hidden-series URL format version: ${version}`);
};

export const serializeHiddenSeries = (
  search: URLSearchParams,
  key: string,
  values: readonly string[],
) => {
  if (values.length === 0) return;
  search.set(`${key}v`, hiddenSeriesFormatVersion);
  for (const value of [...values].sort()) search.append(key, value);
};
