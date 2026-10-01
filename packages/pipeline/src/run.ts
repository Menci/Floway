// The runner. Four jobs beyond calling stages in order: it holds each stage to its own
// declaration, it records what happened, it tracks what the run owns, and it drains that
// when the caller says so.
//
// **Declarations are checked, never applied.** After a stage hands on — in either
// direction, and on the answering path too — every key it declared `provides` is there
// and every key it declared `consumes`, and did not also declare providing, is gone.
// Nothing is removed on the stage's behalf: a declaration that acts cannot also be
// checked, and checking is the whole of what a declaration is for. A key in both
// `consumes` and `provides` is a modify: going down, a translation taking the source and
// putting the target at another key; coming up, a fork taking ownership of every branch's
// releasable and handing one of them onward.

import type { Facts } from './facts.ts';
import { assertHandedOver, move } from './facts.ts';
import type { Descend, ErasedSide, LogLevel, Pipeline, RunScope, RunServices, Stage } from './stage.ts';

/** Ownership is claimed, never sniffed.
 *
 *  `Symbol.asyncDispose` is a release *mechanism* the language hands out on its own terms,
 *  and those terms are not stable across the hosts this runs on. Measured:
 *
 *                                                     Node 24   Node 22
 *    Symbol.asyncDispose in (async function*(){})()   true      false
 *    Symbol.asyncDispose in new ReadableStream()      false     false
 *
 *  Neither column is what a run needs. On Node 24 a structural predicate adopts every
 *  generator-shaped fact as a run resource — a transducer's own iterator gets `.return()`ed
 *  the moment its stage hands up, and a fork throws on receiving one at a key nobody declared
 *  consuming, which is every failed-over streaming request. On Node 22, which
 *  `apps/platform-node` supports, it adopts nothing at all. Either way it misses the upstream
 *  body it exists for, and a predicate whose answer depends on the host cannot be what decides
 *  which resources a gateway closes.
 *
 *  `own()` is what says "the run is answerable for this". Which is also what the
 *  architecture already says: `consumes` on the response side *declares* the keys whose
 *  values a stage takes ownership of. Declaration was always the mechanism; this makes the
 *  runner read it instead of guessing. */
const OWNED = Symbol('floway.owned');

export type Owned = AsyncDisposable & { readonly [OWNED]: true };

interface Ownership {
  release: () => Promise<void>;
  disposal: Promise<void> | undefined;
}

const ownership = new WeakMap<object, Ownership>();

/** Marks a value the run must release, and gives it the release the runner will call.
 *  A value that owns nothing is never marked, so it rides through untouched. */
export const own = <T extends object>(value: T, release: () => Promise<void>): T & Owned => {
  if (ownership.has(value)) throw new Error('Resource is already owned; use setRelease to change its release action');
  const state: Ownership = { release, disposal: undefined };
  const releaseOnce = (): Promise<void> => {
    state.disposal ??= (async () => { await state.release(); })();
    return state.disposal;
  };
  const resource = Object.assign(value, { [OWNED]: true as const, [Symbol.asyncDispose]: releaseOnce });
  ownership.set(resource, state);
  return resource;
};

export const setRelease = (value: Owned, release: () => Promise<void>): (() => Promise<void>) => {
  const state = ownership.get(value)!;
  if (state.disposal !== undefined) throw new Error('Cannot change a resource release action after disposal has started');
  const previous = state.release;
  state.release = release;
  return previous;
};

export const isOwned = (value: unknown): value is Owned =>
  typeof value === 'object' && value !== null && OWNED in value;

const DEFERRED = Symbol('floway.deferred');

/** A value the run has started and has not finished. It is a property of the value, not a
 *  capability a stage was handed: what a run must wait for is legible from its own record. */
export type Deferred<T> = Promise<T> & { readonly [DEFERRED]: true };

/**
 * Marks a promise as this run's to finish.
 *
 * Declared rather than sniffed. Testing for a `then` method would make a fact that happens to
 * hold a promise indistinguishable from one the run owes work to, and it would be quietly
 * awaited instead of reported — so the claim is explicit, exactly as ownership is.
 *
 * Helpers call this and hand out the promise; a stage never creates one. That is what
 * "stages have no fire-and-forget" means in practice: work a stage starts becomes a fact
 * with a name, and the runner waits for it where it can see it.
 */
export const defer = <T>(promise: Promise<T>): Deferred<T> =>
  Object.assign(promise, { [DEFERRED]: true as const });

export const isDeferred = (value: unknown): value is Deferred<unknown> =>
  typeof value === 'object' && value !== null && DEFERRED in value;

/**
 * Frozen in place, never copied. A stage that hands on what it received hands on the
 * same object, so the record has an identity of its own and "this side changed nothing"
 * is the same test as everywhere else in the design — which is what the dump's folding
 * reads. Freezing is what makes the copy unnecessary: nobody can write to it afterwards.
 *
 * Ownership is per key, which is what `consumes` declares, so this is also where the run
 * learns about a resource: every releasable at a top-level key of a record the runner
 * accepts is one the run is answerable for until somebody releases it.
 */
const handOn = (record: Facts, decl: ErasedSide, stage: string, way: 'down' | 'up', scope: RunScope): Facts => {
  for (const [key, value] of Object.entries(record)) {
    assertHandedOver(`${stage} handing ${way} ${key}`, value);
    registerFact(value, record, scope);
  }
  for (const key of decl.provides) {
    if (!(key in record)) throw new Error(`${stage}: declared providing ${key} but did not`);
  }
  for (const key of decl.consumes) {
    if (decl.provides.includes(key)) continue;
    if (key in record) throw new Error(`${stage}: declared consuming ${key} but handed it ${way}`);
  }
  return Object.freeze(record);
};

const registerFact = (value: unknown, facts: Facts, scope: RunScope): void => {
  if (isOwned(value)) scope.outstanding.add(value);
  if (isDeferred(value) && !scope.deferred.has(value)) {
    const settled = value.then(async result => {
      try {
        await scope.emit({ type: 'deferred.settled', deferred: value, outcome: move({ status: 'fulfilled', value: result }) });
      } catch (error) { throw captureFailure(error, facts, scope); }
    }, async error => {
      const failure = captureFailure(error, facts, scope);
      try {
        await scope.emit({ type: 'deferred.settled', deferred: value, outcome: move({ status: 'rejected', reason: error }) });
      } catch (recordingError) {
        if (recordingError !== error) {
          const combined = new AggregateError([error, recordingError], 'Deferred fact failed and recording also failed', { cause: error });
          throw captureFailure(combined, facts, scope);
        }
      }
      throw failure;
    });
    scope.deferred.set(value, settled);
    // Teardown observes the original rejection; marking it handled now prevents
    // a streamed answer from making that rejection unhandled before drain runs.
    void settled.catch(() => {});
  }
};

const NONE: readonly string[] = [];

interface FailureContext { readonly owner: object; readonly facts: Facts; readonly source: unknown }
const failureFacts = new WeakMap<object, FailureContext>();
const scopeOwners = new WeakMap<RunScope, object>();

export const getFailureFacts = (error: unknown): Facts | undefined =>
  typeof error === 'object' && error !== null ? failureFacts.get(error)?.facts : undefined;

const captureFailure = (error: unknown, facts: Facts, scope: RunScope): unknown => {
  const isReference = typeof error === 'object' && error !== null;
  if (isReference) {
    const known = scope.failures.get(error);
    if (known !== undefined) return known;
  }
  const owner = scopeOwners.get(scope)!;
  const previous = isReference ? failureFacts.get(error) : undefined;
  // Shared Error objects and primitive stream rejection values need a per-run
  // cause wrapper, so the diagnostic context never overwrites another run's.
  const caught = !isReference
    ? new Error(String(error), { cause: error })
    : previous !== undefined && previous.owner !== owner
      ? new Error(error instanceof Error ? error.message : 'Pipeline execution failed', { cause: error })
      : error;
  if (caught !== error && caught instanceof Error && error instanceof Error) caught.name = error.name;
  if (isReference) scope.failures.set(error, caught);
  scope.failures.set(caught, caught);
  failureFacts.set(caught, { owner, facts, source: previous === undefined ? error : previous.source });
  return caught;
};

const failureSource = (error: unknown): unknown => {
  const context = typeof error === 'object' && error !== null ? failureFacts.get(error) : undefined;
  return context === undefined ? error : context.source;
};

export const walk = async (
  pipeline: string,
  stages: readonly Stage[],
  index: number,
  facts: Facts,
  services: object,
  scope: RunScope,
): Promise<Facts> => {
  const stage = stages[index];
  if (stage === undefined) throw new Error(`${pipeline}: ran off the end without answering`);
  const stageId = scope.nextStageId++;
  const parentStageId = scope.parentStageId;
  const pass = stage.through ?? stage.into;
  const branches: Facts[] = [];
  let current = facts;

  try {
  // Once, on the way in: what this stage initially saw. A fork is not this event
  // repeating — it is several *children* naming this stage as their parent, each entered
  // by its own descent, so the shape of a run is in the ids.
    await scope.emit({ type: 'stage.entered', stageId, name: stage.name, parentStageId, facts });
    if (pass !== undefined) requireFacts(facts, pass.request.needs, `${stage.name} entering:`);

    const descend: Descend = async (produced, target) => {
      const handed = handOn(produced, pass!.request, stage.name, 'down', scope);
      current = handed;
      const outerParent = scope.parentStageId;
      scope.parentStageId = stageId;
      try {
        if (target !== undefined) requireEntry(target, handed, `${stage.name} handing off`);
        const out = target === undefined
          ? await walk(pipeline, stages, index + 1, handed, services, scope)
          : (await target.enter(handed as object, services, scope)) as Facts;
        current = out;
        requireFacts(out, pass!.response.needs, `${stage.name} receiving response:`);
        branches.push(out);
        return out;
      } finally {
        scope.parentStageId = outerParent;
      }
    };

    // A stage that declared no way down is handed no continuation at all, which is the
    // whole of what shape 1 means, so it is called with one fewer argument.
    const use = { ...services, log: loggerFor(services, stage.name, stageId, scope) };
    const call = stage.execute as unknown as (...args: readonly unknown[]) => Promise<Facts>;
    const produced = pass === undefined
      ? await call(facts, use)
      : await call(facts, descend, use);

    // Trait one fired: it never went down, so there is no response side to check — only the
    // closed set it declared it would answer with. Answering is the same rule as handing
    // down: the stage returns the whole record, and nothing is merged on its behalf.
    if (branches.length === 0) {
      if (stage.return === undefined) {
        throw new Error(pass === undefined
          ? `${stage.name}: answered without declaring 'return'`
          : `${stage.name}: returned without calling next, and declares no 'return'`);
      }
      const answer = handOn(produced, { needs: NONE, consumes: NONE, provides: stage.return.provides }, stage.name, 'up', scope);
      current = answer;
      await scope.emit({ type: 'stage.leaved', stageId, facts: answer });
      return answer;
    }

    // It forked: every releasable it received must have been declared, because the branches
    // it did not adopt are its own. This is checked at runtime because that is the level the
    // property lives at — whether a stage branches is invisible in its signature.
    if (branches.length > 1) {
      const received = new Set<string>();
      for (const branch of branches) {
        for (const [key, value] of Object.entries(branch)) if (isOwned(value)) received.add(key);
      }
      const undeclared = [...received].filter(key => !pass!.response.consumes.includes(key));
      if (undeclared.length > 0) {
        throw new Error(
          `${stage.name}: called next ${branches.length} times and received releasables `
        + `it did not declare consuming: ${undeclared.join(', ')}`,
        );
      }
    }

    const handedUp = handOn(produced, pass!.response, stage.name, 'up', scope);
    current = handedUp;

    // Consuming a response key takes ownership of every value received there.
    // Release values absent from the returned record across all branches;
    // ownership follows identity even when a resource changes keys.
    const kept = new Set(Object.values(handedUp).filter(isOwned));
    for (const branch of branches) {
      for (const key of pass!.response.consumes) {
        const value = branch[key];
        if (isOwned(value) && !kept.has(value)) await release(value, scope);
      }
    }

    await scope.emit({ type: 'stage.leaved', stageId, facts: handedUp });
    return handedUp;
  } catch (error) {
    const failure = captureFailure(error, current, scope);
    try {
      await scope.emit({ type: 'stage.failed', stageId, error: failureSource(failure) });
    } catch (recordingError) {
      if (recordingError !== error && recordingError !== failure) {
        const combined = new AggregateError([failure, recordingError], 'Pipeline stage failed and recording also failed', { cause: failure });
        throw captureFailure(combined, getFailureFacts(failure) ?? current, scope);
      }
    }
    throw failure;
  }
};

/** Released once, by whoever gets there first. A stage may release in its own body with
 *  `await using`, and the runner is the backstop — so it must not drain the same body a
 *  second time. */
const release = async (value: Owned, scope: RunScope): Promise<void> => {
  if (!scope.outstanding.delete(value)) return;
  await value[Symbol.asyncDispose]();
};

/**
 * Waits for what this run started, and says so loudly when something does not finish.
 *
 * Per run and not per root: a discarded branch's facts are private to that branch and
 * unreachable from the root's record, so a root-level sweep could never see them. Each run
 * tears down its own, and a branch nobody adopted still finishes what it began.
 */
const settleDeferred = async (scope: RunScope): Promise<void> => {
  const pending = [...scope.deferred.values()];
  if (pending.length === 0) return;
  scope.deferred.clear();

  const outcome = await Promise.allSettled(pending);
  const errors = outcome.filter(result => result.status === 'rejected').map(result => result.reason as unknown);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Pipeline deferred facts failed');
};

const requireFacts = (facts: Facts, keys: readonly string[], who: string): void => {
  for (const key of keys) {
    if (!(key in facts)) {
      throw new Error(`${who} needs ${key}, which it was not given`);
    }
  }
};

const requireEntry = (target: Pipeline<object, object>, handed: Facts, who: string): void =>
  requireFacts(handed, target.entryNeeds.map(String), `${who}: ${target.name}`);

/** Each stage receives a logger tied to its execution position. With a dump open its lines land in that stage's record as well as going to
 *  the global sink, which is why `stage.log` is one of the dump's events.
 *
 *  The top-level field record is copied and frozen; descendants remain shared
 *  immutable values supplied by the producer, as with facts. Awaiting the global
 *  logger before the run sink preserves each line's output order.
 */
const loggerFor = (services: object, name: string, stageId: number, scope: RunScope): import('./stage.ts').Use<object>['log'] => {
  const sink = (services as RunServices).log;
  const line = (level: LogLevel) =>
    async (message: string, fields?: Readonly<Record<string, unknown>>): Promise<void> => {
      // The global sink is handed the stage as an ordinary field, because a `Logger` has
      // nowhere else to put it; the record gets it as `context`, which is where a logg
      // entry carries the same thing.
      const entry = {
        type: 'stage.log',
        stageId,
        level,
        context: name,
        message,
        ...(fields === undefined ? {} : { fields: Object.freeze({ ...fields }) }),
      } as const;
      await sink?.[level](message, { stage: name, ...fields });
      await scope.emit(entry);
    };
  return { debug: line('debug'), info: line('info'), warn: line('warn'), error: line('error') };
};

export interface RunResult<Exit> {
  readonly facts: Exit;
  /**
   * What the run still owns. Release is not cancel — this drains to end-of-stream, because
   * an aborted connection cannot be reused and leaves its billing unsettled — so the
   * caller decides *when*, after the response is on its way. Awaiting it before handing
   * the answer back would eat a streaming family's frames.
   */
  readonly drain: () => Promise<void>;
}

/**
 * The entry to the pipeline system. An HTTP handler, a WebSocket handler and a stage
 * launching a sub-request all call this one function, and being outside the system is the
 * ordinary position of a caller — which is what "requires no capability" means. The
 * services are the prologue's own wiring, built per run and fixed for it.
 */
export const run = async <Entry extends object, Exit extends object, S extends RunServices>(
  pipeline: Pipeline<Entry, Exit>,
  initial: Entry,
  services: S,
): Promise<RunResult<Exit>> => {
  // With no dump sink resolved in the prologue, none of the recording happens.
  const sink = services.dump;
  const scope: RunScope = {
    emit: async event => { await sink?.(event); },
    outstanding: new Set<Owned>(),
    deferred: new Map<Promise<unknown>, Promise<void>>(),
    failures: new WeakMap<object, object>(),
    parentStageId: null,
    nextStageId: 1,
  };
  scopeOwners.set(scope, {});
  let current = initial as Facts;
  let draining: Promise<void> | undefined;
  const drain = (): Promise<void> => {
    if (draining !== undefined) return draining;
    draining = (async () => {
      const errors: unknown[] = [];
      for (const value of scope.outstanding) {
        try { await release(value, scope); } catch (error) { errors.push(captureFailure(error, current, scope)); }
      }
      try { await settleDeferred(scope); } catch (error) { errors.push(captureFailure(error, current, scope)); }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'Pipeline resource cleanup failed');
    })();
    return draining;
  };

  try {
    Object.freeze(initial);
    for (const value of Object.values(initial)) registerFact(value, initial as Facts, scope);
    for (const [key, value] of Object.entries(initial)) assertHandedOver(`prologue ${key}`, value);
    requireEntry(pipeline as unknown as Pipeline<object, object>, initial as Facts, `run(${pipeline.name})`);
    const facts = (await pipeline.enter(initial, services, scope)) as unknown as Exit;
    current = facts as Facts;
    return { facts, drain };
  } catch (error) {
    const failure = captureFailure(error, initial as Facts, scope);
    current = getFailureFacts(failure) ?? initial as Facts;
    // A run that threw has nothing left to hand back, so there is nothing to defer for:
    // draining here is what stops a bug from abandoning every body opened below it. The
    // events are already with the sink, so the dump of the run that 500'd survives.
    try {
      await drain();
    } catch (cleanupError) {
      if (cleanupError === failure) throw failure;
      const combined = new AggregateError([failure, cleanupError], 'Pipeline failed and resource cleanup also failed', { cause: failure });
      throw captureFailure(combined, getFailureFacts(failure) ?? initial as Facts, scope);
    }
    throw failure;
  }
};
