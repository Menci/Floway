// Raw JSON primitives preserve numeric tokens outside the finite or safe-integer range.
// https://tc39.es/proposal-json-parse-with-source/#sec-json.rawjson
export const rawJSON = JSON as typeof JSON & {
  isRawJSON: (value: unknown) => value is { readonly rawJSON: string };
  rawJSON: (text: string) => { readonly rawJSON: string };
};
