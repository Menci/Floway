// Raw JSON primitives preserve numeric source tokens that ordinary serialization would rewrite.
// https://tc39.es/proposal-json-parse-with-source/#sec-json.rawjson
export const rawJSON = JSON as typeof JSON & {
  isRawJSON: (value: unknown) => value is { readonly rawJSON: string };
  rawJSON: (text: string) => { readonly rawJSON: string };
};
