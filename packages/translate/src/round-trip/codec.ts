export interface SidecarCodec {
  /** Encode and decode must preserve sidecar tagged values, byte arrays, and raw JSON values. */
  encode: (payload: NonNullable<unknown> | null) => Promise<string>;
  decode: (encoded: string) => Promise<unknown>;
}

/**
 * A CBOR tag whose meaning belongs to the sidecar payload owner. The transport
 * codec preserves the tag number and value without interpreting either.
 */
export class SidecarTaggedValue {
  constructor(
    readonly tag: number,
    readonly value: unknown,
  ) {}
}
