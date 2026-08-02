import type { FormatterModule, FormatFunction } from 'i18next';

import { localeForLanguage } from './languages';
import { formatBytes, formatCount, formatNumber } from '../lib/format-number';

// i18next interpolates with String(value), so a number written as a bare
// {{value}} renders ungrouped beside a chip that went through
// lib/format-number. This module replaces i18next's own Intl formats — theirs
// would resolve a locale from the language tag instead of through
// localeForLanguage — and, together with `alwaysFormat`, is reached for every
// interpolation rather than only the ones that name a format. A number with no
// format is therefore a throw at render, not a message that quietly disagrees
// with the component next to it.
const numberFormats: Record<string, (value: number, locale: string) => string> = {
  number: formatNumber,
  count: formatCount,
  bytes: formatBytes,
};

const format: FormatFunction = (value, name, language, options) => {
  const key = String((options as { interpolationkey?: string } | undefined)?.interpolationkey ?? '?');
  if (value === undefined || value === null) return value as unknown as string;

  if (name === undefined) {
    if (typeof value === 'number') {
      throw new TypeError(`Interpolation {{${key}}} carries a number but names no format; write {{${key}, number}}.`);
    }
    return value as string;
  }

  const formatter = numberFormats[name];
  if (formatter === undefined) throw new TypeError(`Interpolation {{${key}, ${name}}} names an unknown format.`);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Interpolation {{${key}, ${name}}} needs a finite number, received ${String(value)}.`);
  }

  return formatter(value, localeForLanguage(language));
};

const unsupported = (): never => {
  throw new Error('Interpolation formats are declared in i18n/number-format.ts, not registered at runtime.');
};

export const numberFormatter: FormatterModule = {
  type: 'formatter',
  init: () => {},
  add: unsupported,
  addCached: unsupported,
  format,
};
