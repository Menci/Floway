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
