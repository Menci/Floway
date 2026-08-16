// The runner. Three jobs beyond calling stages in order: it holds each stage to its own
// declaration, it records what happened, and it sweeps what nobody released.
//
// **Declarations are checked, never applied.** After a stage hands on — in either
// direction, and on the answering path too — every key it declared `provides` is there
// and every key it declared `consumes`, and did not also declare providing, is gone.
// Nothing is removed on the stage's behalf: a declaration that acts cannot also be
// checked, and checking is the whole of what a declaration is for. A key in both
// `consumes` and `provides` is a modify: going down, a translation taking the source and
// putting the target at another key; coming up, a fork taking ownership of every branch's
// disposable and handing one of them onward.

import type { Event } from './dump.ts';
import type { Facts } from './facts.ts';
import { assertHandedOver } from './facts.ts';
import type { Descend, ErasedSide, Logger, Pipeline, Recorder, Stage } from './stage.ts';

/** A value that owns a resource. `consumes` on the response side is what claims it.
 *  Draining to end-of-stream is inherently async, so `Symbol.dispose` cannot express it
 *  and `await using` is the only form consistent with release-is-not-cancel. */
export interface Disposable {
  [Symbol.asyncDispose](): Promise<void>;
}

export const isDisposable = (value: unknown): value is Disposable =>
  typeof value === 'object' && value !== null
  && Symbol.asyncDispose in value
  && typeof (value as Disposable)[Symbol.asyncDispose] === 'function';

/**
 * Frozen in place, never copied. A stage that hands on what it received hands on the
 * same object, so the record has an identity of its own and "this side changed nothing"
 * is the same test as everywhere else in the design — which is what the dump's folding
 * reads. Freezing is what makes the copy unnecessary: nobody can write to it afterwards.
 */
const handOn = (record: Facts, decl: ErasedSide, stage: string, way: 'down' | 'up'): Facts => {
  for (const [key, value] of Object.entries(record)) assertHandedOver(`${stage} handing ${way} ${key}`, value);
  for (const key of decl.provides) {
    if (!(key in record)) throw new Error(`${stage}: declared providing ${key} but did not`);
  }
  for (const key of decl.consumes) {
    if (decl.provides.includes(key)) continue;
    if (key in record) throw new Error(`${stage}: declared consuming ${key} but handed it ${way}`);
  }
  return Object.freeze(record);
};

const NO_CONSUMES: readonly string[] = [];

export const walk = async (
  pipeline: string,
  stages: readonly Stage[],
  index: number,
  facts: Facts,
  services: object,
  into: Recorder | undefined,
): Promise<Facts> => {
  const stage = stages[index];
  if (stage === undefined) throw new Error(`${pipeline}: ran off the end without answering`);
  const stageId = into === undefined ? 0 : into.nextStageId++;
  const parentStageId = into?.parentStageId ?? null;
  const pass = stage.through ?? stage.into;
  const branches: Facts[] = [];

  // Once, on the way in: what this stage initially saw. A fork is not this event
  // repeating — it is several *children* naming this stage as their parent, each entered
  // by its own descent, so the shape of a run is in the ids.
  into?.emit({ type: 'stage.entered', stageId, name: stage.name, parentStageId, facts });

  const descend: Descend = async (produced, target) => {
    const handed = handOn(produced, pass!.request, stage.name, 'down');
    const outerParent = into?.parentStageId ?? null;
    if (into !== undefined) into.parentStageId = stageId;
    try {
      if (target !== undefined) requireEntry(target, handed);
      const out = target === undefined
        ? await walk(pipeline, stages, index + 1, handed, services, into)
        : (await target.enter(handed as object, services, into)) as Facts;
      branches.push(out);
      return out;
    } finally {
      if (into !== undefined) into.parentStageId = outerParent;
    }
  };

  // A stage that declared no way down is handed no continuation at all, which is the
  // whole of what shape 1 means, so it is called with one fewer argument.
  const use = { ...services, log: loggerFor(services, stage.name, stageId, into) };
  const call = stage.execute as unknown as (...args: readonly unknown[]) => Promise<Facts>;
  const produced = pass === undefined
    ? await call(facts, use)
    : await call(facts, descend, use);

  // Trait one fired: it never went down, so there is no response side to check — only the
  // closed set it declared it would answer with. Answering is the same rule as handing
  // down: the stage returns the whole record, and nothing is merged on its behalf.
  if (branches.length === 0) {
    if (stage.return === undefined) throw new Error(`${stage.name}: answered without declaring 'return'`);
    const answer = handOn(produced, { needs: NO_CONSUMES, consumes: NO_CONSUMES, provides: stage.return.provides }, stage.name, 'up');
    into?.emit({ type: 'stage.leaved', stageId, facts: answer });
    return answer;
  }

  // It forked: every disposable it received must have been declared, and the branches it
  // did not adopt are its own to release. This is checked at runtime because that is the
  // level the property lives at — whether a stage branches is invisible in its signature.
  if (branches.length > 1) {
    const received = new Set<string>();
    for (const branch of branches) {
      for (const [key, value] of Object.entries(branch)) if (isDisposable(value)) received.add(key);
    }
    const undeclared = [...received].filter(key => !pass!.response.consumes.includes(key));
    if (undeclared.length > 0) {
      throw new Error(
        `${stage.name}: called next ${branches.length} times and received disposables `
        + `it did not declare consuming: ${undeclared.join(', ')}`,
      );
    }
    for (const branch of branches) {
      if (branch === produced) continue;
      for (const [key, value] of Object.entries(branch)) {
        // Releasing is resource management, not content: the record already holds what
        // this branch did, and whether its body was drained is not a fact about the run.
        if (isDisposable(value) && produced[key] !== value) await value[Symbol.asyncDispose]();
      }
    }
  }

  const handedUp = handOn(produced, pass!.response, stage.name, 'up');
  into?.emit({ type: 'stage.leaved', stageId, facts: handedUp });
  return handedUp;
};

const requireEntry = (target: Pipeline<object, object>, handed: Facts): void => {
  for (const key of target.entryNeeds) {
    if (!(String(key) in handed)) {
      throw new Error(`${target.name}: entry needs ${String(key)}, which the caller did not bring`);
    }
  }
};

/** Each stage gets its own logger — the one capability the framework specializes by
 *  position. With a dump open its lines land in that stage's record as well as going to
 *  the global sink, which is why `stage.log` is one of the dump's events. */
const loggerFor = (services: object, name: string, stageId: number, into: Recorder | undefined): Logger => {
  const sink = (services as { readonly log?: Logger }).log;
  const line = (level: 'debug' | 'info' | 'warn' | 'error') =>
    (message: string, fields?: Readonly<Record<string, unknown>>): void => {
      sink?.[level](message, { stage: name, ...fields });
      into?.emit({ type: 'stage.log', stageId, level, message, fields });
    };
  return { debug: line('debug'), info: line('info'), warn: line('warn'), error: line('error') };
};

/**
 * The entry to the pipeline system. An HTTP handler, a WebSocket handler and a stage
 * launching a sub-request all call this one function, and being outside the system is the
 * ordinary position of a caller — which is what "requires no capability" means. The
 * services are the prologue's own wiring, built per run and fixed for it.
 */
export const run = async <Entry extends object, Exit extends object, S extends object>(
  pipeline: Pipeline<Entry, Exit>,
  initial: Entry,
  services: S,
): Promise<{ readonly facts: Exit; readonly events: readonly Event[] }> => {
  for (const [key, value] of Object.entries(initial)) assertHandedOver(`prologue ${key}`, value);
  for (const key of pipeline.entryNeeds) {
    if (!(String(key) in initial)) {
      throw new Error(`run(${pipeline.name}): entry needs ${String(key)}, which the caller did not bring`);
    }
  }

  const events: Event[] = [];
  const recorder: Recorder = { emit: event => { events.push(event); }, parentStageId: null, nextStageId: 1 };
  let facts: Facts = {};
  try {
    facts = (await pipeline.enter(initial, services, recorder)) as unknown as Facts;
    return { facts: facts as unknown as Exit, events };
  } finally {
    // Whatever is still outstanding belongs to the run, including a disposable that was
    // declared by nobody and rode all the way up. No stage-level rule carries this
    // guarantee, and it holds whether the run answered or threw — a stage that throws
    // must not abandon an open upstream body. Release is not cancel: a real body is
    // drained to end-of-stream, because an aborted connection cannot be reused and leaves
    // its billing unsettled.
    for (const value of Object.values(facts)) if (isDisposable(value)) await value[Symbol.asyncDispose]();
  }
};
