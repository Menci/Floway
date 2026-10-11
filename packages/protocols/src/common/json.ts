export type JsonObject = Record<string, unknown>;

// Raw JSON preserves integers that IEEE-754 numbers cannot represent exactly.
// https://tc39.es/proposal-json-parse-with-source/#sec-json.rawjson
export const jsonInteger = (value: bigint): number | { readonly rawJSON: string } => {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : (JSON as typeof JSON & { rawJSON: (text: string) => { readonly rawJSON: string } }).rawJSON(value.toString());
};

// Strict object guard: rejects arrays. Used by the Anthropic Messages reassembler in
// this package when keying into a value as a JSON dictionary.
export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
