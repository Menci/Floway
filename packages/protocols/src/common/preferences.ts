export const QUOTA_DISPLAYS = ['remaining', 'used'] as const;

/**
 * How a quota percentage is read: how much of an allowance is left, or how much
 * of it has been spent.
 */
export type QuotaDisplay = (typeof QUOTA_DISPLAYS)[number];

export const SUPPORTED_LANGUAGES = ['en', 'zh-Hans'] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const DEFAULT_LANGUAGE: SupportedLanguage = 'en';

/**
 * Folds the Usage models a pattern matches into one series named `name`. The
 * pattern is a case-insensitive glob in which `*` matches any run of
 * characters; the first group whose pattern matches a model claims it.
 */
export interface UsageModelGroup {
  pattern: string;
  name: string;
}

export const USAGE_MODEL_GROUP_LIMITS = { groups: 100, pattern: 200, name: 100 } as const;

/** Percent of the window below which a Usage model series folds into Other; 0 keeps every series. */
export const USAGE_OTHER_SHARES = [0, 0.5, 1, 2, 5] as const;

export type UsageOtherShare = (typeof USAGE_OTHER_SHARES)[number];

export interface UserPreferences {
  quotaDisplay: QuotaDisplay;
  /**
   * The dashboard language. `null` follows the browser, which is what an
   * account that has never chosen a language reads.
   */
  language: SupportedLanguage | null;
  uiTextEditor: boolean;
  usageModelGroups: UsageModelGroup[];
  usageOtherShare: UsageOtherShare;
}

export const defaultUserPreferences: UserPreferences = {
  quotaDisplay: 'remaining',
  language: null,
  uiTextEditor: false,
  usageModelGroups: [],
  usageOtherShare: 0,
};

const isQuotaDisplay = (value: unknown): value is QuotaDisplay =>
  QUOTA_DISPLAYS.includes(value as QuotaDisplay);

const isSupportedLanguage = (value: unknown): value is SupportedLanguage =>
  SUPPORTED_LANGUAGES.includes(value as SupportedLanguage);

const isUsageOtherShare = (value: unknown): value is UsageOtherShare =>
  USAGE_OTHER_SHARES.includes(value as UsageOtherShare);

const boundedText = (value: unknown, field: string, limit: number): string => {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
  if (value.trim() === '') throw new TypeError(`${field} must not be blank`);
  if (value.length > limit) throw new TypeError(`${field} must be at most ${limit} characters`);
  return value;
};

export const parseUsageModelGroups = (value: unknown): UsageModelGroup[] => {
  if (!Array.isArray(value)) throw new TypeError('preferences.usageModelGroups must be an array');
  if (value.length > USAGE_MODEL_GROUP_LIMITS.groups) {
    throw new TypeError(`preferences.usageModelGroups holds at most ${USAGE_MODEL_GROUP_LIMITS.groups} groups`);
  }
  return value.map((group: unknown, index) => {
    if (typeof group !== 'object' || group === null || Array.isArray(group)) {
      throw new TypeError(`preferences.usageModelGroups[${index}] must be an object`);
    }
    const record = group as Record<string, unknown>;
    const extra = Object.keys(record).find(key => key !== 'pattern' && key !== 'name');
    if (extra !== undefined) throw new TypeError(`preferences.usageModelGroups[${index}] has unknown field ${extra}`);
    return {
      pattern: boundedText(record.pattern, `preferences.usageModelGroups[${index}].pattern`, USAGE_MODEL_GROUP_LIMITS.pattern),
      name: boundedText(record.name, `preferences.usageModelGroups[${index}].name`, USAGE_MODEL_GROUP_LIMITS.name),
    };
  });
};

export const parseUsageOtherShare = (value: unknown): UsageOtherShare => {
  if (!isUsageOtherShare(value)) throw new TypeError(`preferences.usageOtherShare is not one of ${USAGE_OTHER_SHARES.join(', ')}`);
  return value;
};

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

  const uiTextEditor = record.uiTextEditor === undefined ? defaultUserPreferences.uiTextEditor : record.uiTextEditor;
  if (typeof uiTextEditor !== 'boolean') {
    throw new TypeError('preferences.uiTextEditor must be a boolean');
  }

  const usageModelGroups = record.usageModelGroups === undefined
    ? [...defaultUserPreferences.usageModelGroups]
    : parseUsageModelGroups(record.usageModelGroups);
  const usageOtherShare = record.usageOtherShare === undefined
    ? defaultUserPreferences.usageOtherShare
    : parseUsageOtherShare(record.usageOtherShare);

  return { quotaDisplay, language, uiTextEditor, usageModelGroups, usageOtherShare };
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
