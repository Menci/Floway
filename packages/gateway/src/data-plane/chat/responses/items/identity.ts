export const responsesItemId = (item: object): string | null => {
  const id = 'id' in item ? item.id : undefined;
  return typeof id === 'string' && id.length > 0 ? id : null;
};

export const hashResponsesIdentity = async (identity: unknown): Promise<string> =>
  await sha256Hex(JSON.stringify(sortJson(identity)));

export const createResponsesStorageKey = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `stored_${[...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
};

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
};

const sortJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
};
