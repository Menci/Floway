// The error fields the protocols agree on; each writer picks the ones its own
// protocol defines.
export interface IRErrorPayload {
  readonly message: string;
  readonly type?: string;
  readonly code?: string | null;
  readonly param?: string | null;
  readonly provider_specific_fields?: Readonly<Record<string, unknown>>;
}
