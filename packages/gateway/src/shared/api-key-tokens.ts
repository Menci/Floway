export type ApiKeyFormat = 'openai' | 'custom';

export const API_KEY_FORMATS = ['openai', 'custom'] as const;

export const CUSTOM_API_KEY_MAX_LENGTH = 4096;

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

const randomBase62 = (length: number): string => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => BASE62[b % BASE62.length]).join('');
};

export const generateOpenAIApiKeyToken = (): string =>
  `sk-${randomBase62(20)}T3BlbkFJ${randomBase62(20)}`;

export const generateApiKeyToken = (): string => generateOpenAIApiKeyToken();

export const isApiKeyFormat = (value: unknown): value is ApiKeyFormat =>
  typeof value === 'string' && (API_KEY_FORMATS as readonly string[]).includes(value);
