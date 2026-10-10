export type JsonObject = Record<string, unknown>;

// Preserve JSON number tokens that JavaScript cannot represent as finite or safe integers.
// https://tc39.es/proposal-json-parse-with-source/#sec-json.rawjson
const jsonWithRawNumbers = JSON as typeof JSON & {
  rawJSON: (text: string) => { readonly rawJSON: string };
};

export const parseJSONWithRawNumbers = (text: string): unknown => JSON.parse(text, (_key: string, value: unknown, context?: { source: string }) => {
  if (typeof value === 'number' && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) return jsonWithRawNumbers.rawJSON(context!.source);
  return value;
});

export const jsonInteger = (value: bigint): number | { readonly rawJSON: string } => {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : jsonWithRawNumbers.rawJSON(value.toString());
};

// Strict object guard: rejects arrays. Used by the Anthropic Messages reassembler in
// this package when keying into a value as a JSON dictionary.
export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
