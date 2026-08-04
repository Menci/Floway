import type { Context } from 'hono';

import { inboundHeaderAllowlistForKind } from '../providers/registry.ts';
import { parseAnthropicBetaHeader } from '@floway-dev/protocols/messages';
import type { InboundHeaderMatcher, UpstreamProviderKind, UpstreamRequestHints } from '@floway-dev/provider';

// https://github.com/anthropics/anthropic-sdk-typescript/blob/3b45cd3b69c956ac63384fdb09ce1d8109f3fa80/src/resources/beta/beta.ts#L622-L635
const CONTEXT_1M_BETA = 'context-1m-2025-08-07';

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
  providerKind: UpstreamProviderKind,
): Headers => filterInboundHeaders(headers, inboundHeaderAllowlistForKind(providerKind));

export const requestHintsFromInboundHeaders = (headers: Headers): UpstreamRequestHints => ({
  oneMillionContext: parseAnthropicBetaHeader(headers.get('anthropic-beta')).includes(CONTEXT_1M_BETA),
});
