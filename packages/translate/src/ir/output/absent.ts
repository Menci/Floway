// A field whose absence is itself a fact: an optional value is now known never
// to arrive, as opposed to not having arrived yet. Only the output stream needs
// this, because a request arrives complete.
export const IRAbsent: unique symbol = Symbol('IRAbsent');

export type IRAbsent = typeof IRAbsent;
