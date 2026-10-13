import { rawJSON } from './raw-json.ts';
import type { IRJSONObject } from '../../ir/types.ts';
import { isJsonObject } from '@floway-dev/protocols/common';

const parseJSON = (text: string): unknown => JSON.parse(text, (_key: string, value: unknown, context?: { source: string }) => {
  if (typeof value === 'number' && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) return rawJSON.rawJSON(context!.source);
  return value;
});

const isPlainJSONObject = (value: unknown): value is IRJSONObject => isJsonObject(value) && !rawJSON.isRawJSON(value);

export const requireJSONObject = (value: unknown): IRJSONObject => {
  if (!isPlainJSONObject(value)) throw new TypeError('Expected a JSON object');
  return value;
};

export const parseJSONObject = (text: string, parser: (text: string) => unknown = parseJSON): IRJSONObject => {
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
