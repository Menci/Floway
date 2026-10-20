const SENSITIVE_HEADERS = new Set([
  'api-key',
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-api-key',
  'x-goog-api-key',
]);

export const REDACTED_HEADER_VALUE = '[redacted]';

export const isSensitiveHeader = (name: string) => SENSITIVE_HEADERS.has(name.toLowerCase());

export const redactHeaderValue = (value: string): string => {
  if (value.length <= 16) return '•'.repeat(value.length);
  return `${value.slice(0, 8)}${'•'.repeat(value.length - 16)}${value.slice(-8)}`;
};

export const redactHeaderPairs = (headers: ReadonlyArray<readonly [string, string]>): Array<[string, string]> =>
  headers.map(([name, value]) => [name, isSensitiveHeader(name)
    ? value === REDACTED_HEADER_VALUE ? value : redactHeaderValue(value)
    : value]);
