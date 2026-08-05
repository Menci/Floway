import type { BackupFileData } from './file';
import type { TFunction } from '../../i18n/translation';

export const PREVIEW_LABEL_KEYS = [
  'users',
  'apiKeys',
  'upstreams',
  'proxies',
  'usage',
  'searchUsage',
  'performance',
] as const;

export const countRecords = (data: BackupFileData): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const key of PREVIEW_LABEL_KEYS) {
    const value = data[key];
    counts[key] = Array.isArray(value) ? value.length : 0;
  }
  return counts;
};

// `Intl.ListFormat` supplies the conjunction and the separators the reader's
// language actually uses -- "a, b, and c" against "a、b和c" -- neither of which
// a join can spell.
export const recordSummary = (
  counts: Record<string, number>,
  t: TFunction,
  locale: string,
): string => {
  const parts = PREVIEW_LABEL_KEYS
    .filter(key => counts[key] > 0)
    .map(key => t(`dashboard.backupRestore.import.imported.${key}`, {
      count: counts[key],
    }));
  return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(parts);
};
