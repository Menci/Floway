// One line per event: `event_name field1=value1 field2="quoted with spaces"`.
// Strings are bare when safe and JSON-quoted otherwise; `null` / `undefined`
// render as the literal `null` so an absent field stays visible to the
// operator instead of vanishing. Event names are snake_case and prefixed
// with `claude_code_` so a single grep isolates this provider's events.

export type LogFieldValue = string | number | boolean | null | undefined;
export type LogFields = Record<string, LogFieldValue>;

const NEEDS_QUOTING = /[\s"=]/;

const formatValue = (value: LogFieldValue): string => {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === '' || NEEDS_QUOTING.test(value)) return JSON.stringify(value);
  return value;
};

const formatLogLine = (event: string, fields: LogFields): string => {
  const parts = [event];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(`${key}=${formatValue(value)}`);
  }
  return parts.join(' ');
};

export const logInfo = (event: string, fields: LogFields = {}): void => {
  console.info(formatLogLine(event, fields));
};

export const logWarn = (event: string, fields: LogFields = {}): void => {
  console.warn(formatLogLine(event, fields));
};
