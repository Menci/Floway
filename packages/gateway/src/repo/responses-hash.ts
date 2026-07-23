import { sha256Hex } from '@floway-dev/platform';

export const hashResponsesJson = async (value: unknown): Promise<string> =>
  await sha256Hex(new TextEncoder().encode(JSON.stringify(sortJson(value))));

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
