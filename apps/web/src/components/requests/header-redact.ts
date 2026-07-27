const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
  "x-goog-api-key",
]);

export const isSensitiveHeader = (name: string) => SENSITIVE_HEADERS.has(name.toLowerCase());

export function redactHeaderValue(value: string): string {
  if (value.length <= 16) return "•".repeat(value.length);
  return `${value.slice(0, 8)}${"•".repeat(value.length - 16)}${value.slice(-8)}`;
}
