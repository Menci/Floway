import { createLogg } from '@guiiai/logg';

export const claudeCodeLog = createLogg('claude-code').useGlobalConfig();
export type ClaudeCodeLog = typeof claudeCodeLog;

const CREDENTIAL_FIELD = /^(?:authorization|(?:x-)?api[-_]?key|(?:access|refresh|setup)[-_]?token|client[-_]?secret|token)$/i;
const CREDENTIAL_PAIR = /((?:authorization|(?:x-)?api[-_]?key|(?:access|refresh|setup)[-_]?token|client[-_]?secret|token)["']?\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;}\]]+)/gi;
// https://github.com/anthropics/claude-code/issues/11544
const CREDENTIAL_VALUE = /\b(?:Bearer\s+[^"'\\\s,;]+|sk-ant-[\w-]+)/gi;

export const diagnosticText = (value: string, limit: number): string => {
  const safe = value.replace(CREDENTIAL_VALUE, '[redacted]').replace(CREDENTIAL_PAIR, '$1"[redacted]"');
  return safe.length <= limit ? safe : `${safe.slice(0, limit - 3)}...`;
};

export const diagnosticPayload = (value: object): string => diagnosticText(
  JSON.stringify(value, (name, field: unknown) => CREDENTIAL_FIELD.test(name) ? '[redacted]' : field),
  256,
);

export const diagnosticError = (error: unknown): string => diagnosticText(
  (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim(),
  512,
);
