import type { UpstreamRecord } from '@floway-dev/provider';

export interface CopilotUpstreamUser {
  login: string;
  avatar_url: string;
  name: string | null;
  id: number;
}

export interface CopilotUpstreamConfig {
  githubToken: string;
  user: CopilotUpstreamUser;
}

export type CopilotUpstreamRecord = UpstreamRecord & {
  kind: 'copilot';
  config: CopilotUpstreamConfig;
};

type FieldErrorBuilder = (field: string, expected: string) => Error;

const malformedConfig: FieldErrorBuilder = (field, expected) => new Error(`Malformed copilot upstream config: ${field} must be ${expected}`);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const stringField = (value: unknown, field: string, err: FieldErrorBuilder): string => {
  if (typeof value !== 'string') throw err(field, 'a string');
  return value;
};

const nonEmptyStringField = (value: unknown, field: string, err: FieldErrorBuilder): string => {
  const str = stringField(value, field, err).trim();
  if (str === '') throw err(field, 'a non-empty string');
  return str;
};

const nullableStringField = (value: unknown, field: string, err: FieldErrorBuilder): string | null => {
  if (value !== null && typeof value !== 'string') throw err(field, 'a string or null');
  return value;
};

const integerField = (value: unknown, field: string, err: FieldErrorBuilder): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw err(field, 'an integer');
  return value;
};

const copilotUserField = (value: unknown, err: FieldErrorBuilder): CopilotUpstreamUser => {
  if (!isRecord(value)) throw err('user', 'an object');
  return {
    login: stringField(value.login, 'user.login', err),
    avatar_url: stringField(value.avatar_url, 'user.avatar_url', err),
    name: nullableStringField(value.name, 'user.name', err),
    id: integerField(value.id, 'user.id', err),
  };
};

// Grammar for an incoming config payload. The caller supplies the error
// builder because the surfaces that accept such a payload word their
// rejections differently.
export const parseCopilotUpstreamConfig = (value: unknown, err: FieldErrorBuilder): CopilotUpstreamConfig => {
  if (!isRecord(value)) throw err('config', 'an object');
  return {
    githubToken: nonEmptyStringField(value.githubToken, 'githubToken', err),
    user: copilotUserField(value.user, err),
  };
};

export const assertCopilotUpstreamRecord = (record: UpstreamRecord): CopilotUpstreamRecord => {
  if (record.kind !== 'copilot') throw new Error(`Expected copilot upstream record, got ${record.kind}`);
  if (!isRecord(record.config)) throw malformedConfig('config', 'an object');
  return {
    ...record,
    kind: 'copilot',
    config: {
      githubToken: stringField(record.config.githubToken, 'githubToken', malformedConfig),
      user: copilotUserField(record.config.user, malformedConfig),
    },
  };
};
