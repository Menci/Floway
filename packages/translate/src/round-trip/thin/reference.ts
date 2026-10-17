export type ReferencePart = number | [hashIndex: number, start: number, endExclusive: number];

export class ThinReference<Kind extends 'text' | 'json' = 'text' | 'json'> {
  constructor(
    readonly restoration: Kind,
    public parts: ReferencePart[],
  ) {}
}

export type TextReference = ThinReference<'text'>;
export type JSONReference = ThinReference<'json'>;
