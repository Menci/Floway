import type { Context } from 'hono';

import { isForwardableUpstreamHeader } from '../shared/upstream-response.ts';
import { isSecret } from '@floway-dev/pipeline';
import type { HeaderEntry, Secret } from '@floway-dev/pipeline';
import { wrapSensitiveHeaderEntries } from '@floway-dev/provider';
import type { InboundHeaderMatcher } from '@floway-dev/provider';

// Hop-by-hop headers (RFC 9110 §7.6.1), Fetch-owned representation framing,
// and upstream session cookies stripped when relaying decoded bodies.
// https://www.rfc-editor.org/rfc/rfc9110#section-7.6.1
const BLOCKED_RELAY_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
  'set-cookie',
  'set-cookie2',
]);

export { BLOCKED_RELAY_HEADERS as RELAY_BLOCKED_HEADERS };

export const inboundHeaderEntriesFromHono = (c: Context): readonly HeaderEntry[] =>
  wrapSensitiveHeaderEntries([...c.req.raw.headers.entries()]);

export const inboundHeaderEntriesFromHeaders = (headers: Headers): readonly HeaderEntry[] =>
  wrapSensitiveHeaderEntries([...headers.entries()]);

const regexpMatches = (regexp: RegExp, value: string): boolean =>
  new RegExp(regexp.source, regexp.flags).test(value);

export const filterInboundHeaderEntries = (
  headers: readonly HeaderEntry[],
  allowlist: readonly InboundHeaderMatcher[],
): readonly HeaderEntry[] => {
  const exactNames = new Set(allowlist.flatMap(entry => typeof entry === 'string' ? [entry.toLowerCase()] : []));
  const regexps = allowlist.filter((entry): entry is RegExp => entry instanceof RegExp);
  return Object.freeze(headers.filter(([name]) => {
    const normalizedName = name.toLowerCase();
    return exactNames.has(normalizedName) || regexps.some(regexp => regexpMatches(regexp, normalizedName));
  }));
};

export const headerEntryValue = (headers: readonly HeaderEntry[], name: string): string | undefined => {
  const normalizedName = name.toLowerCase();
  const values = headers
    .filter(([headerName]) => headerName.toLowerCase() === normalizedName)
    .map(([, value]) => isSecret(value) ? value.reveal() : value);
  return values.length === 0 ? undefined : values.join(', ');
};

const orderedHeaderEntries = (
  headers: readonly HeaderEntry[],
  defaultContentType: string | null,
): readonly HeaderEntry[] => {
  const contentType = headerEntryValue(headers, 'content-type') ?? defaultContentType;
  const entries: HeaderEntry[] = contentType === null
    ? []
    : [Object.freeze(['content-type', contentType] as const)];
  for (const entry of headers) {
    if (isForwardableUpstreamHeader(entry[0]) && entry[0].toLowerCase() !== 'content-type') entries.push(entry);
  }
  return wrapSensitiveHeaderEntries(entries);
};

export const forwardedResponseHeaderEntries = (
  upstreamHeaders: readonly HeaderEntry[],
  defaultContentType: string | null,
): readonly HeaderEntry[] => orderedHeaderEntries(upstreamHeaders, defaultContentType);

export const relayedResponseHeaderEntries = (
  upstreamHeaders: readonly HeaderEntry[],
): readonly HeaderEntry[] => wrapSensitiveHeaderEntries(upstreamHeaders.filter(([name]) =>
  !BLOCKED_RELAY_HEADERS.has(name.toLowerCase())));

export const revealHeader = (value: Secret<string> | string): string => isSecret(value) ? value.reveal() : value;
