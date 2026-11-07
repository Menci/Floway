// A range over a JavaScript string, counted in UTF-16 code units so it slices
// the stored value exactly, including isolated surrogates. Native protocols may
// count code points or UTF-8 bytes; their readers convert.
export interface IRTextRange {
  readonly start: number;
  readonly end_exclusive: number;
}
