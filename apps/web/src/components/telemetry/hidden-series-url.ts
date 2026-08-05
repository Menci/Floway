const hiddenSeriesFormatVersion = '2';

const decodeLegacyId = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    if (error instanceof URIError) return value;
    throw error;
  }
};

export const parseHiddenSeries = (search: URLSearchParams, key: string): string[] =>
  search.get(`${key}v`) === hiddenSeriesFormatVersion
    ? search.getAll(key)
    : (search.get(key) ?? '').split(',').map(decodeLegacyId).filter(Boolean);

export const serializeHiddenSeries = (
  search: URLSearchParams,
  key: string,
  values: readonly string[],
) => {
  if (values.length === 0) return;
  search.set(`${key}v`, hiddenSeriesFormatVersion);
  for (const value of [...values].sort()) search.append(key, value);
};
