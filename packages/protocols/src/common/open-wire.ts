// Protocol enum values stay open-string so a value introduced upstream after
// the pinned snapshot is forwarded verbatim instead of being narrowed away.
// Discriminators keep their official literals so unions still narrow on them.
type OpenWireDiscriminator = 'type' | 'role';

type OpenWireLiteral<T> = string extends T ? T : T | (string & {});

export type OpenWire<T> =
  T extends string ? OpenWireLiteral<T>
    : T extends readonly (infer Element)[] ? OpenWire<Element>[]
      : T extends object ? { [Key in keyof T]: Key extends OpenWireDiscriminator ? T[Key] : OpenWire<T[Key]> }
        : T;
