export type CustomIngressHeaderNameIssue = 'invalid' | 'messages-owned' | 'transport-owned';

// https://www.rfc-editor.org/rfc/rfc9110.html#section-5.6.2
const HTTP_FIELD_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// https://github.com/anthropics/anthropic-sdk-typescript/blob/3b45cd3b69c956ac63384fdb09ce1d8109f3fa80/src/resources/beta/beta.ts#L622-L635
const MESSAGES_OWNED_HEADER_NAMES = new Set(['anthropic-beta']);

// These names belong to the gateway/provider transport boundary, not the
// upstream application protocol. Sending body metadata after Floway has
// reserialized JSON/FormData misframes the new body; sending gateway auth,
// cookies, proxy/IP signals, or hop-by-hop fields leaks credentials/topology or
// is rejected by runtime fetch.
// https://www.rfc-editor.org/rfc/rfc9110.html#section-7.6.1
// https://www.rfc-editor.org/rfc/rfc9110.html#section-11.7
// https://www.rfc-editor.org/rfc/rfc7239.html
// https://www.rfc-editor.org/rfc/rfc8586.html
// https://www.rfc-editor.org/rfc/rfc6455.html#section-11.3
// https://developers.cloudflare.com/fundamentals/reference/http-request-headers/
// https://cloud.google.com/apis/docs/system-parameters
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/model-provider-info/src/lib.rs#L396-L408
const TRANSPORT_OWNED_HEADER_NAMES = new Set([
  'accept-encoding',
  'authorization',
  'cdn-loop',
  'connection',
  'content-encoding',
  'content-length',
  'content-type',
  'cookie',
  'expect',
  'forwarded',
  'host',
  'keep-alive',
  'proxy-authorization',
  'proxy-authenticate',
  'proxy-authentication-info',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'true-client-ip',
  'upgrade',
  'x-api-key',
  'x-client-ip',
  'x-floway-session',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-goog-api-key',
  'x-openai-actor-authorization',
  'x-real-ip',
]);

const TRANSPORT_OWNED_HEADER_PREFIXES = [
  'cf-',
  'sec-websocket-',
  'x-forwarded-',
] as const;

export const customIngressHeaderNameIssue = (value: string): CustomIngressHeaderNameIssue | null => {
  const name = value.trim().toLowerCase();
  if (!HTTP_FIELD_NAME_PATTERN.test(name)) return 'invalid';
  if (MESSAGES_OWNED_HEADER_NAMES.has(name)) return 'messages-owned';
  if (TRANSPORT_OWNED_HEADER_NAMES.has(name) || TRANSPORT_OWNED_HEADER_PREFIXES.some(prefix => name.startsWith(prefix))) {
    return 'transport-owned';
  }
  return null;
};

// Field values admit HTAB, visible ASCII, and obs-text bytes. Fetch rejects
// every other control byte and values that cannot undergo ByteString
// conversion, so persisted replacements are validated before request time.
// https://www.rfc-editor.org/rfc/rfc9110.html#section-5.5
export const isCustomIngressHeaderValue = (value: string): boolean => [...value].every(char => {
  const code = char.charCodeAt(0);
  return code === 0x09 || (code >= 0x20 && code <= 0x7e) || (code >= 0x80 && code <= 0xff);
});
