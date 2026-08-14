import type { Context } from 'hono';

import type { InboundHeaderMatcher, Provider } from '@floway-dev/provider';

export const inboundHeaders = (c: Context): Headers => new Headers(c.req.raw.headers);

const regexpMatches = (regexp: RegExp, value: string): boolean =>
  new RegExp(regexp.source, regexp.flags).test(value);

export const filterInboundHeaders = (
  headers: Headers,
  allowlist: readonly InboundHeaderMatcher[],
): Headers => {
  const exactNames = new Set(allowlist.flatMap(entry => typeof entry === 'string' ? [entry.toLowerCase()] : []));
  const regexps = allowlist.filter((entry): entry is RegExp => entry instanceof RegExp);
  const filtered = new Headers();
  for (const [name, value] of headers) {
    const normalizedName = name.toLowerCase();
    if (exactNames.has(normalizedName) || regexps.some(regexp => regexpMatches(regexp, normalizedName))) {
      filtered.append(name, value);
    }
  }
  return filtered;
};

export const filterInboundHeadersForProvider = (
  headers: Headers,
  provider: Provider,
): Headers => filterInboundHeaders(headers, provider.inboundHeaderAllowlist);
