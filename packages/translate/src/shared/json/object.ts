import { rawJSON } from './raw-json.ts';
import type { IRJSONObject } from '../../ir/types.ts';
import { isJsonObject, parseJSONWithRawNumbers } from '@floway-dev/protocols/common';

export const isPlainJSONObject = (value: unknown): value is IRJSONObject => isJsonObject(value) && !rawJSON.isRawJSON(value);

export const requireJSONObject = (value: unknown): IRJSONObject => {
  if (!isPlainJSONObject(value)) throw new TypeError('Expected a JSON object');
  return value;
};

export const parseJSONObject = (text: string, parser: (text: string) => unknown = parseJSONWithRawNumbers): IRJSONObject => {
  const value = parser(text);
  if (!isPlainJSONObject(value)) throw new TypeError('Tool arguments require a JSON object');
  return value;
};

export const isCompleteJSONObject = (text: string): boolean => {
  try {
    return isPlainJSONObject(parseJSONWithRawNumbers(text));
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
