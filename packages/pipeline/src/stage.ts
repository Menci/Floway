// A stage declares where control may go, and it may declare more than one place. There
// is no name for a *kind* of stage; the fields are the declaration.
//
//   return:  { provides }            answer here, never go down
//   through: { request, response }   go down the rest of this pipeline
//   into:    { request, response }   hand off to another pipeline, so it is last
//
// `through` and `into` are mutually exclusive, and that follows from what they mean: an
// `into` stage is last, and a last stage has nothing left to go through. So the legal
// shapes are five — `return`, `through`, `through` + `return`, `into`, `into` + `return`
// — and `defineStage`'s overloads admit exactly those.

import type { Facts, Handed } from './facts.ts';

/** Trait one: answer here. Only `provides`, because nothing came back to need or
 *  consume — the facts below never existed. */
export type ReturnDecl<Rs extends object> = {
  readonly provides: readonly (keyof Rs)[];
};

/** Trait two: go down. Four slices, two per direction, named the same way on both sides:
 *  what arrives, and what this stage hands on. Down — `Rq` arrives, `Down` is handed on.
 *  Up — `Up` arrives, `Rs` is handed on. A translation consumes on the way back as well
 *  as on the way down, so one type per direction would not be enough. */
export type PassDecl<Rq extends object, Down extends object, Up extends object, Rs extends object> = {
  readonly request: {
    readonly needs: readonly (keyof Rq)[];
    readonly consumes: readonly (keyof Rq)[];
    readonly provides: readonly (keyof Down)[];
  };
  readonly response: {
    readonly needs: readonly (keyof Up)[];
    /** Also ownership: everything this stage receives at these keys, from every `next`
     *  call, is its to release. A key it also `provides` is one it hands onward, and
     *  ownership of that one goes with it. */
    readonly consumes: readonly (keyof Up)[];
    readonly provides: readonly (keyof Rs)[];
  };
};

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Structured, to fit a logger like `@guiiai/logg`. The pipeline defines the shape it
 *  needs and never the implementation, so a foundation package stays runtime-independent. */
export interface Logger {
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

/** Services ride beside `next`, never in the facts: a live handle dumps as nothing, so it
 *  is not a fact. One container holds every package's services and a stage can only name
 *  the keys its own slice admits, exactly as with facts. The set is fixed for the run at
 *  the prologue, and `log` is the one the framework specializes by position — each stage
 *  gets its own, and with a dump open its lines land in that stage's record. */
export type Use<S extends object> = S & { readonly log: Logger };

/** What the prologue may put in the container that the runner itself reads. Everything
 *  else in `S` is the composition's own and the runner never looks at it. */
export interface RunServices {
  /** The global sink. A stage's lines always reach it. */
  readonly log?: Logger;
  /** Resolved by the prologue when this request is being dumped, and absent otherwise —
   *  which is how recording stays conditional without a mode flag. */
  readonly dump?: (event: import('./dump.ts').Event) => void;
  /** Whatever else the composition wires. The runner reads only the two above. */
  readonly [key: string]: unknown;
}

export type ThroughNext<Down extends object, Up extends object> =
  (handed: Handed<Down>) => Promise<Up>;

/** One extra parameter, and that is the entire difference between the two ways down. A
 *  stage that declared `through` cannot name a target: a second argument is a compile
 *  error at the definition site. */
export type IntoNext<Entry extends object, Up extends object> =
  (handed: Handed<Entry>, target: Pipeline<Entry, Up>) => Promise<Up>;

/** What one run holds, threaded rather than ambient. A module-level context saved and
 *  restored around an `await` interleaves two concurrent runs — one dump lost, the other
 *  holding both, one `stageId` issued twice — and a gateway serves concurrent requests by
 *  definition. */
export interface RunScope {
  /** A no-op when the prologue resolved no dump sink, which is what makes recording
   *  conditional rather than a mode flag. */
  readonly emit: (event: import('./dump.ts').Event) => void;
  /** Every releasable the run has accepted and nobody has released. Tracked where it is
   *  created rather than where it lands, so a body opened below a throw is already known
   *  before the stack unwinds past it. */
  readonly outstanding: Set<AsyncDisposable>;
  parentStageId: number | null;
  nextStageId: number;
}

export interface Pipeline<Entry extends object, Exit extends object> {
  readonly name: string;
  /** Derived by `compose` from the stages: what nobody below provides, the caller brings. */
  readonly entryNeeds: readonly (keyof Entry)[];
  readonly enter: (facts: Entry, services: object, scope: RunScope) => Promise<Exit>;
}

/** What assembly and the runner hold: the same declarations with the key names as
 *  strings, plus something callable. Slice types are the author's concern and the
 *  caller's concern and nobody's in between, so erasing them here is the one widening
 *  point in the design — and it is what lets a stage written against the gateway's space
 *  compose beside one written against a provider's, with no variance question to lose. */
export type ErasedPass = {
  readonly request: ErasedSide;
  readonly response: ErasedSide;
};

export type ErasedSide = {
  readonly needs: readonly string[];
  readonly consumes: readonly string[];
  readonly provides: readonly string[];
};

/** `ThroughNext` and `IntoNext` collapsed: an untyped record, and an optional target
 *  that only an `into` stage ever passes. */
export type Descend = (handed: Facts, target?: Pipeline<object, object>) => Promise<Facts>;

/** The arity is variadic because it really is two arities: a stage that declared no way
 *  down is handed no continuation at all — that is what shape 1 means — so it is called
 *  `(facts, use)`, and every other shape is called `(facts, next, use)`. Which one applies
 *  is read off the same declared fields that select the overload. */
export type Stage = {
  readonly name: string;
  readonly return?: { readonly provides: readonly string[] };
  readonly through?: ErasedPass;
  readonly into?: ErasedPass;
  readonly execute: (facts: Facts, ...rest: readonly never[]) => Promise<Facts>;
};

// One definer. Which fields are present selects an overload, and the overload fixes what
// `next` accepts — no marker boolean and no conditional type. The runtime is identity;
// the whole job is threading inference across the fields of one object literal.

// 1. return — answers, never goes down. `execute` is handed no continuation.
export function defineStage<Rq extends object, Rs extends object, S extends object = object>(s: {
  name: string;
  return: ReturnDecl<Rs>;
  execute: (facts: Rq, use: Use<S>) => Promise<Handed<Rs>>;
}): Stage;

// 2. through + return — may answer, may go down. A cache has this shape.
//
// `Answer` is its own parameter, because what a stage provides when it short-circuits and
// what it provides when it descends are two statements, not one — which is what the
// declaration already says by having two blocks, and what `compose` already checks
// separately. A stage that answers with a key its descend path never carries is ordinary:
// a resolver refusing a request it found no upstream for has exactly that shape.
export function defineStage<Rq extends object, Down extends object, Up extends object, Rs extends object, Answer extends object = Rs, S extends object = object>(s: {
  name: string;
  through: PassDecl<Rq, Down, Up, Rs>;
  return: ReturnDecl<Answer>;
  execute: (facts: Rq, next: ThroughNext<Down, Up>, use: Use<S>) => Promise<Handed<Rs> | Handed<Answer>>;
}): Stage;

// 3. through — must go down; it cannot answer on its own.
export function defineStage<Rq extends object, Down extends object, Up extends object, Rs extends object, S extends object = object>(s: {
  name: string;
  through: PassDecl<Rq, Down, Up, Rs>;
  execute: (facts: Rq, next: ThroughNext<Down, Up>, use: Use<S>) => Promise<Handed<Rs>>;
}): Stage;

// 4. into + return — may answer, or hand off to a named pipeline. `Answer` is separate for
// the same reason as shape 2.
export function defineStage<Rq extends object, Entry extends object, Up extends object, Rs extends object, Answer extends object = Rs, S extends object = object>(s: {
  name: string;
  into: PassDecl<Rq, Entry, Up, Rs>;
  return: ReturnDecl<Answer>;
  execute: (facts: Rq, next: IntoNext<Entry, Up>, use: Use<S>) => Promise<Handed<Rs> | Handed<Answer>>;
}): Stage;

// 5. into — must hand off.
export function defineStage<Rq extends object, Entry extends object, Up extends object, Rs extends object, S extends object = object>(s: {
  name: string;
  into: PassDecl<Rq, Entry, Up, Rs>;
  execute: (facts: Rq, next: IntoNext<Entry, Up>, use: Use<S>) => Promise<Handed<Rs>>;
}): Stage;

export function defineStage(s: object): Stage {
  return s as unknown as Stage;
}

// `transform` fills the `execute` slot. Two layers: `open` holds the per-invocation state
// that spans both directions, and each direction is one function returning the record it
// hands on. Either side may be omitted, and an omitted one passes through unchanged —
// which is the point, because today's interceptors call the continuation 107 times across
// 68 files and 50 of those calls are a bare `return run();`.
//
// A stream, a value and a failure sit at one key, so telling them apart is reading a
// value, and the stage does that where it needs to. There is no outcome-shape dispatch.

export type Open<Rq extends object, Down extends object, Up extends object, Rs extends object, S extends object = object> =
  (use: Use<S>) => {
    /** `open` does no I/O; its only job is the closure, so state that spans both
     *  directions has somewhere to live that is neither a fact nor the stage — which is
     *  shared across concurrent runs. Async belongs in the two directions. */
    readonly request?: (facts: Rq) => Handed<Down> | Promise<Handed<Down>>;
    readonly response?: (facts: Up) => Handed<Rs> | Promise<Handed<Rs>>;
  };

export const transform = <Rq extends object, Down extends object, Up extends object, Rs extends object, S extends object = object>(
  open: Open<Rq, Down, Up, Rs, S>,
) => async (facts: Rq, next: ThroughNext<Down, Up>, use: Use<S>): Promise<Handed<Rs>> => {
  const { request, response } = open(use);
  const back = await next(request === undefined ? (facts as unknown as Handed<Down>) : await request(facts));
  if (response === undefined) return back as unknown as Handed<Rs>;
  // The record it hands up goes to the runner, which is where the handover gate lives —
  // there are two call sites and this is not a third.
  return await response(back);
};
