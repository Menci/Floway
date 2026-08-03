// i18next appends a CLDR plural category to the key, and the categories a
// language has are a fact about that language: English distinguishes one from
// other, Chinese has only other. So the leaf that backs `t('x.count')` is
// `x.count_one` / `x.count_other` rather than `x.count`, and comparing raw keys
// across locales would demand every locale carry English's categories.
export const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

export const pluralBase = (key: string): string => key.replace(PLURAL_SUFFIX, '');

export const isPlural = (key: string): boolean => PLURAL_SUFFIX.test(key);

// The resource tree flattened to the dotted paths i18next resolves, each
// mapped to the string it answers with.
export const leafEntries = (value: object, prefix = ''): Map<string, string> =>
  new Map(
    Object.entries(value).flatMap(([key, child]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return typeof child === 'object' && child !== null
        ? [...leafEntries(child, path)]
        : [[path, String(child)] as const];
    }),
  );

export const leafKeys = (value: object): string[] => [...leafEntries(value).keys()];
