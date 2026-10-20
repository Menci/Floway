export const QUOTA_DISPLAYS = ['remaining', 'used'] as const;

/**
 * How a quota percentage is read: how much of an allowance is left, or how much
 * of it has been spent.
 */
export type QuotaDisplay = (typeof QUOTA_DISPLAYS)[number];

export const SUPPORTED_LANGUAGES = ['en', 'zh-Hans'] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const DEFAULT_LANGUAGE: SupportedLanguage = 'en';

export interface UserPreferences {
  quotaDisplay: QuotaDisplay;
  /**
   * The dashboard language. `null` follows the browser, which is what an
   * account that has never chosen a language reads.
   */
  language: SupportedLanguage | null;
}

export const defaultUserPreferences: UserPreferences = {
  quotaDisplay: 'remaining',
  language: null,
};

const isQuotaDisplay = (value: unknown): value is QuotaDisplay =>
  QUOTA_DISPLAYS.includes(value as QuotaDisplay);

const isSupportedLanguage = (value: unknown): value is SupportedLanguage =>
  SUPPORTED_LANGUAGES.includes(value as SupportedLanguage);

/**
 * Reads a preferences object from storage, a backup, or a request. Absent
 * fields take their defaults; a present field whose value this build does not
 * know is corruption rather than a preference, so it throws.
 */
export const parseUserPreferences = (value: unknown): UserPreferences => {
  if (value === undefined || value === null) return { ...defaultUserPreferences };
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('preferences must be an object');
  const record = value as Record<string, unknown>;

  const quotaDisplay = record.quotaDisplay === undefined ? defaultUserPreferences.quotaDisplay : record.quotaDisplay;
  if (!isQuotaDisplay(quotaDisplay)) {
    throw new TypeError(`preferences.quotaDisplay is not one of ${QUOTA_DISPLAYS.join(', ')}`);
  }

  const language = record.language === undefined ? defaultUserPreferences.language : record.language;
  if (language !== null && !isSupportedLanguage(language)) {
    throw new TypeError(`preferences.language is not one of ${[...SUPPORTED_LANGUAGES, 'null'].join(', ')}`);
  }

  return { quotaDisplay, language };
};

export const serializeUserPreferences = (preferences: UserPreferences): string => JSON.stringify(preferences);

export const parseStoredUserPreferences = (raw: string, context: string): UserPreferences => {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (cause) {
    throw new TypeError(`${context}: preferences is not valid JSON`, { cause });
  }
  try {
    return parseUserPreferences(value);
  } catch (cause) {
    throw new TypeError(`${context}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
};
