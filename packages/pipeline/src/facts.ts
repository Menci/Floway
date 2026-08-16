// One immutable record travels a pipeline. Entering it is a **move**: afterwards the
// value belongs to the record, the caller must not keep writing to it, and it is deep
// frozen so that a later write throws rather than silently rewriting a state the dump
// has already recorded.
//
// Two mechanisms, because one cannot do both jobs. Measured on Node 24:
//
//   freeze(Uint8Array with elements)     THROW  Cannot freeze array buffer views with elements
//   freeze(empty Uint8Array)             OK
//   freeze(Map) then map.set             OK     mutated, size=1
//   freeze(Date) then setTime            OK     mutated
//   shallow freeze passes isFrozen       OK     child still mutable
//   freeze(ReadableStream)               OK
//
// An HTTP body is a `Uint8Array`, so the freeze walk has to skip typed arrays — and a
// value it skipped can never satisfy `Object.isFrozen`. The last row is the other half:
// a shallow builtin freeze satisfies `Object.isFrozen` while its children stay mutable.
// So membership in a `WeakSet` of handed-over roots is the gate, and `Object.freeze` is
// what makes a later in-place write throw.
//
// Two limits of `Object.freeze` are accepted rather than worked around: `Map`, `Set` and
// `Date` stay mutable through their own methods, and a typed array gets the gate but no
// post-hoc protection.

const handedOver = new WeakSet<object>();

/**
 * Hand a value to the record. Deep freezes it and registers every object inside, so the
 * gate can be read off the root alone: deep freezing implies frozen children, and a
 * value already handed over is not walked again.
 */
export const move = <T>(value: T): T => {
  const walk = (v: unknown): void => {
    if (v === null || typeof v !== 'object' || handedOver.has(v)) return;
    handedOver.add(v);
    if (ArrayBuffer.isView(v)) return;
    Object.freeze(v);
    for (const child of Object.values(v)) walk(child);
  };
  walk(value);
  return value;
};

/**
 * The gate, at the two places a value can enter the record: the runner's acceptance of
 * what a stage hands on, and the prologue's creation of the initial facts. Together they
 * are the whole surface.
 */
export const assertHandedOver = (where: string, value: unknown): void => {
  if (value === null || typeof value !== 'object') return;
  if (!handedOver.has(value)) {
    throw new Error(`${where}: value was not handed over — call move() at the assignment site`);
  }
};

/** A stage sees exactly the keys it declared. `needs` is an assertion, so the projection
 *  is total over them. Facts are not marked `readonly` here: freezing and the gate are
 *  runtime properties, and restating them in the types costs friction and buys nothing. */
export type Slice<F, K extends keyof F> = { [P in K]: F[P] };

/** What a stage hands on: the whole record the next segment runs on, never a delta. The
 *  type names the keys this stage promised and admits the rest, because a stage hands on
 *  keys it has never heard of and they must survive the trip. Which keys it may name is
 *  the assembly's question, not the type layer's. */
export type Handed<Down extends object> = Down & Record<string, unknown>;

/** The erased record, as assembly and the runner hold it. */
export type Facts = { readonly [key: string]: unknown };
