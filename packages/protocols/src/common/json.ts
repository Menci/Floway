export type JsonObject = Record<string, unknown>;

// Strict object guard: rejects arrays. Used by the Anthropic Messages reassembler in
// this package when keying into a value as a JSON dictionary.
export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
