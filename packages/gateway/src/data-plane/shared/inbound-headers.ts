import type { HeaderEntry } from '@floway-dev/http';
import type { InboundHeaderMatcher } from '@floway-dev/provider';

const regexpMatches = (regexp: RegExp, value: string): boolean =>
  new RegExp(regexp.source, regexp.flags).test(value);

export const filterInboundHeaderEntries = (
  headers: readonly HeaderEntry[], allowlist: readonly InboundHeaderMatcher[],
): readonly HeaderEntry[] => {
  const names = new Set(allowlist.flatMap(entry => typeof entry === 'string' ? [entry.toLowerCase()] : []));
  const patterns = allowlist.filter((entry): entry is RegExp => entry instanceof RegExp);
  return headers.filter(([name]) => {
    const normalized = name.toLowerCase();
    return names.has(normalized) || patterns.some(pattern => regexpMatches(pattern, normalized));
  });
};
