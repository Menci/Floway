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

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const stringField = (value: unknown, field: string): string => {
  if (typeof value !== 'string') throw new Error(`Malformed copilot upstream config: ${field} must be a string`);
  return value;
};

const nullableStringField = (value: unknown, field: string): string | null => {
  if (value !== null && typeof value !== 'string') throw new Error(`Malformed copilot upstream config: ${field} must be a string or null`);
  return value;
};

const numberField = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`Malformed copilot upstream config: ${field} must be an integer`);
  return value;
};

const copilotUserField = (value: unknown): CopilotUpstreamUser => {
  if (!isRecord(value)) throw new Error('Malformed copilot upstream config: user must be an object');
  return {
    login: stringField(value.login, 'user.login'),
    avatar_url: stringField(value.avatar_url, 'user.avatar_url'),
    name: nullableStringField(value.name, 'user.name'),
    id: numberField(value.id, 'user.id'),
  };
};

export const assertCopilotUpstreamRecord = (record: UpstreamRecord): CopilotUpstreamRecord => {
  if (record.kind !== 'copilot') throw new Error(`Expected copilot upstream record, got ${record.kind}`);
  if (!isRecord(record.config)) throw new Error('Malformed copilot upstream config: config must be an object');
  return {
    ...record,
    kind: 'copilot',
    config: {
      githubToken: stringField(record.config.githubToken, 'githubToken'),
      user: copilotUserField(record.config.user),
    },
  };
};
