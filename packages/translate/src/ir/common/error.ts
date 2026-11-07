// The error fields the protocols agree on; each writer picks the ones its own
// protocol defines.
//
// An upstream reports a failure through this same payload whether it came back
// as a non-2xx body or as an event on the stream, so a translation has one
// error vocabulary to carry in either case.
export interface IRErrorPayload {
  readonly message: string;
  readonly type?: string;
  readonly code?: string | null;
  readonly param?: string | null;
  readonly provider_specific_fields?: Readonly<Record<string, unknown>>;
}
