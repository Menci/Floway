import { rawJSON } from './raw-json.ts';
import { isJsonObject } from '@floway-dev/protocols/common';

const parseJSON = (text: string): unknown => JSON.parse(text, (_key: string, value: unknown, context?: { source: string }) => {
  if (typeof value === 'number' && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) return rawJSON.rawJSON(context!.source);
  return value;
});

const isPlainJSONObject = (value: unknown): value is Record<string, any> => isJsonObject(value) && !rawJSON.isRawJSON(value);

export const parseJSONObject = (text: string, parser: (text: string) => unknown = parseJSON): Record<string, any> => {
  const value = parser(text);
  if (!isPlainJSONObject(value)) throw new TypeError('Tool arguments require a JSON object');
  return value;
};

export const isCompleteJSONObject = (text: string): boolean => {
  try {
    return isPlainJSONObject(parseJSON(text));
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
};

export const parseJSONObjectAtCompletion = (
  text: string,
  completion: 'complete' | 'truncated',
  parser?: (text: string) => unknown,
): { readonly completion: 'truncated' } | { readonly completion: 'complete'; readonly value: ReturnType<typeof parseJSONObject> } =>
  completion === 'truncated' ? { completion } : { completion, value: parseJSONObject(text, parser) };
