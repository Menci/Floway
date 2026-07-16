// The generation choice offered on POST /api/keys and POST /api/keys/:id/rotate.
// Not a persisted attribute — each create/rotate call carries the choice for
// that single write. 'generate' means the gateway mints a fresh
// sk-...T3BlbkFJ... token in this call; 'custom' means the request carries
// the raw key verbatim in `custom_key`.
export type KeySource = 'generate' | 'custom';

export const KEY_SOURCES = ['generate', 'custom'] as const;

export const CUSTOM_API_KEY_MAX_LENGTH = 4096;

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

const randomBase62 = (length: number): string => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => BASE62[b % BASE62.length]).join('');
};

export const generateApiKeyToken = (): string =>
  `sk-${randomBase62(20)}T3BlbkFJ${randomBase62(20)}`;
