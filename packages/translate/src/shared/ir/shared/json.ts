import type { IRJSONObject } from '../ir.ts';
import { parseJSONWithRawNumbers } from '@floway-dev/protocols/common';

// Raw JSON primitives preserve numeric tokens outside the finite or safe-integer range.
// https://tc39.es/proposal-json-parse-with-source/#sec-json.rawjson
export const irJSON = JSON as typeof JSON & {
  isRawJSON: (value: unknown) => boolean;
  rawJSON: (text: string) => { readonly rawJSON: string };
};

export const cloneIRJSON = <T>(value: T): T => {
  if (typeof value !== 'object' || value === null || irJSON.isRawJSON(value)) return value;
  if (Array.isArray(value)) return value.map(cloneIRJSON) as T;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneIRJSON(child)])) as T;
};

export const parseIRJSONObject = (text: string, parser: (text: string) => unknown = parseJSONWithRawNumbers): IRJSONObject => {
  const value = parser(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value) || irJSON.isRawJSON(value)) throw new TypeError('Tool arguments require a JSON object');
  return value as IRJSONObject;
};

export const isCompleteIRJSONObject = (text: string): boolean => {
  try {
    const value = parseJSONWithRawNumbers(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) && !irJSON.isRawJSON(value);
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
};

export const createIRJSONObjectDraft = () => {
  let text = '';
  let depth = 0;
  let started = false;
  let quoted = false;
  let escaped = false;
  let invalid = false;
  const append = (delta: string): boolean => {
    text += delta;
    for (const char of delta) {
      if (!started) {
        if (/\s/u.test(char)) continue;
        started = true;
        if (char !== '{') invalid = true;
      }
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{' || char === '[') depth++;
      else if (char === '}' || char === ']') depth--;
      else if (depth === 0 && !/\s/u.test(char)) invalid = true;
    }
    return started && !invalid && depth === 0 && !quoted && isCompleteIRJSONObject(text);
  };
  return { append };
};
