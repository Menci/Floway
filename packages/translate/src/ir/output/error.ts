// The error fields the protocols agree on; each writer picks the ones its own
// protocol defines.
//
// An upstream reports a failure through this same payload whether it came back
// as a non-2xx body or as an event on the stream, so a translation has one
// error vocabulary to carry in either case.
export interface IRErrorPayload {
  // A target protocol's error object states fields no other protocol has, and
  // they travel with the payload rather than being dropped on the way through.
  readonly [field: string]: unknown;
  readonly message: string;
  readonly type?: string;
  readonly code?: string | null;
  readonly param?: string | null;
  // Everything the upstream stated beyond the fields above: both its own
  // `provider_specific_fields` and any other key its error object carried. A
  // target protocol may state fields no other protocol has, and the source
  // writer has no vocabulary of its own for them; this is the one container
  // they travel in, so a restated failure states what the upstream did.
  readonly provider_specific_fields?: Readonly<Record<string, unknown>>;
}
