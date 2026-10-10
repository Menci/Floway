import type { IRJSONObject } from './ir.ts';

// Raw JSON primitives preserve integer tokens that JavaScript numbers cannot represent exactly.
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

export const parseIRJSON = (text: string): unknown => JSON.parse(text, (_key: string, value: unknown, context?: { source: string }) => {
  if (typeof value === 'number' && !Number.isSafeInteger(value) && /^-?\d+$/.test(context!.source)) return irJSON.rawJSON(context!.source);
  return value;
});

export const parseIRJSONObject = (text: string, parser: (text: string) => unknown = parseIRJSON): IRJSONObject => {
  const value = parser(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value) || irJSON.isRawJSON(value)) throw new TypeError('Tool arguments and JSON references require a JSON object');
  return value as IRJSONObject;
};
