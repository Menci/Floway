// What a run emits, and how it is written down. The specification is
// `plans/26-dump-format.md`; this is that format.
//
// A run emits a sequence of events. What a live observer is given and what is stored are
// the same sequence, so there is one encoding and one thing to implement.
//
//   { type: 'stage.entered', stageId, name, parentStageId, facts }
//   { type: 'stage.leaved',  stageId, facts }
//   { type: 'stage.log',     stageId, level, message, fields }
//   { type: 'object',        fromObjectId, nodes: [ … ] }
//   { type: 'stream.frame',  streamId, frames: [ … ] }
//   { type: 'stream.end',    streamId }
//
// Events carry states and never differences. What a stage did is the difference between
// the state it entered on and the state its child entered on, and between what its child
// handed up and what it handed up — all adjacent in the stream, so a reader derives every
// change and the run stores none. Object identity makes that cheap: equal ids mean equal
// subtrees, so a reader recurses only where they differ.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

import type { Facts } from './facts.ts';

/** What the runner produces, with facts still as live objects. */
export type Event =
  | { readonly type: 'stage.entered'; readonly stageId: number; readonly name: string; readonly parentStageId: number | null; readonly facts: Facts }
  | { readonly type: 'stage.leaved'; readonly stageId: number; readonly facts: Facts }
  /** What that stage's own logger wrote. A log line is content about a stage, like the
   *  rest, and it has to be somewhere: every stage gets a logger and with a dump open its
   *  lines are stored into that stage's record as well as going to the global sink. */
  | { readonly type: 'stage.log'; readonly stageId: number; readonly level: LogLevel; readonly message: string; readonly fields?: Readonly<Record<string, unknown>> }
  | { readonly type: 'stream.frame'; readonly streamId: number; readonly frames: readonly unknown[] }
  | { readonly type: 'stream.end'; readonly streamId: number };

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// --- Value kinds the space cannot hold as plain data -------------------------------

const SECRET = Symbol('floway.secret');
const STREAM = Symbol('floway.stream');

/**
 * A value-level marker that redaction reads. *Secret* and *credential* are two different
 * concepts and only the first exists this far down: a stage knows some values are secret,
 * sends them exactly as given, and does nothing extra either way. What a thing is, who
 * issued it and when it expires is a domain concept the ending stage never hears of.
 */
export interface Secret<T> {
  readonly [SECRET]: true;
  /** Reading it is deliberate and greppable. The dump never calls this. */
  readonly reveal: () => T;
}

export const secret = <T>(value: T, render: (value: T) => string = String): Secret<T> => ({
  [SECRET]: true,
  reveal: () => value,
  // Held for the stored form, so revealing is never what a dump does.
  ...{ [RENDERED]: render(value) },
} as Secret<T>);

const RENDERED = Symbol('floway.secret.rendered');

export const isSecret = (value: unknown): value is Secret<unknown> =>
  typeof value === 'object' && value !== null && SECRET in value;

/** A stream is identified in the space and its frames arrive as their own events, because
 *  frames are produced over time and an object is not. */
export interface StreamFact {
  readonly [STREAM]: number;
}

export const streamFact = (streamId: number): StreamFact => ({ [STREAM]: streamId });

export const isStreamFact = (value: unknown): value is StreamFact =>
  typeof value === 'object' && value !== null && STREAM in value;

/**
 * `{length, redacted, hash}`. `hash` is what lets a reader see that the same secret sat at
 * the same key across two events, so a diff reports no change where none happened;
 * `length` and `redacted` are what it renders.
 *
 * How much of a secret the redacted form shows at each length is deliberately one
 * function, because the policy is not settled.
 */
export const storedSecret = (value: Secret<unknown>): StoredSecret => {
  const rendered = (value as unknown as Record<symbol, string>)[RENDERED];
  return {
    length: rendered.length,
    redacted: redact(rendered),
    hash: `0x${bytesToHex(sha256(utf8ToBytes(rendered))).slice(0, 16)}`,
  };
};

const REDACT_KEEP = 8;
const REDACT_MINIMUM = REDACT_KEEP * 3;

const redact = (rendered: string): string =>
  rendered.length < REDACT_MINIMUM
    ? '*'.repeat(rendered.length)
    : `${rendered.slice(0, REDACT_KEEP)}****${rendered.slice(-REDACT_KEEP)}`;

export interface StoredSecret {
  readonly length: number;
  readonly redacted: string;
  readonly hash: string;
}

// --- The encoding ------------------------------------------------------------------

export type Ref = { readonly $: number };
export type Stored =
  | null | boolean | number | string
  | Ref
  | { readonly $stream: number }
  | { readonly $secret: StoredSecret }
  | Stored[]
  | { readonly [key: string]: Stored };

export type DumpEvent =
  | { readonly type: 'stage.entered'; readonly stageId: number; readonly name: string; readonly parentStageId: number | null; readonly facts?: Record<string, Stored> }
  | { readonly type: 'stage.leaved'; readonly stageId: number; readonly facts: Record<string, Stored> }
  | { readonly type: 'stage.log'; readonly stageId: number; readonly level: LogLevel; readonly message: string; readonly fields?: Record<string, Stored> }
  | { readonly type: 'object'; readonly fromObjectId: number; readonly nodes: readonly Stored[] }
  | { readonly type: 'stream.frame'; readonly streamId: number; readonly frames: readonly Stored[] }
  | { readonly type: 'stream.end'; readonly streamId: number };

/**
 * A key that begins with `$` is written with one more, and a reader strips one back off.
 * Not hypothetical: a tool's parameters are JSON Schema, so `$schema`, `$defs` and `$ref`
 * arrive in real payloads. Only keys are escaped — a `$` inside a value is data.
 */
export const encodeKey = (key: string): string => (key.startsWith('$') ? `$${key}` : key);
export const decodeKey = (key: string): string => (key.startsWith('$$') ? key.slice(1) : key);

const isNode = (value: unknown): value is object => typeof value === 'object' && value !== null;

/**
 * Ids come from one counter and are taken at first sight, so the ids minted while encoding
 * one event are a contiguous range and only the first needs stating. An id is taken
 * **before** recursing into the object, which is what makes a cycle terminate on its
 * second visit.
 *
 * The invariant every `object` event owes: each reference in it points at an id from an
 * earlier event or at one inside this event, never forward into an event that has not
 * arrived. That is what makes the stream emittable as it happens.
 *
 * Large strings are shared by value as well, which is the only handle left when a stage
 * deep-clones a payload: every object below the clone is new, and an embedded image is
 * still the same string.
 */
export const createEncoder = (options: { readonly shareStringsFrom?: number } = {}) => {
  const shareStringsFrom = options.shareStringsFrom ?? 1024;
  const objectIds = new Map<object, number>();
  const stringIds = new Map<string, number>();
  let nextObjectId = 1;

  const encodeFacts = (facts: Facts, emit: (event: DumpEvent) => void): Record<string, Stored> => {
    const fromObjectId = nextObjectId;
    const nodes: Stored[] = [];

    const write = (value: unknown): Stored => {
      if (typeof value === 'string' && value.length >= shareStringsFrom) {
        const known = stringIds.get(value);
        if (known !== undefined) return { $: known };
        const id = nextObjectId++;
        stringIds.set(value, id);
        nodes[id - fromObjectId] = value;
        return { $: id };
      }
      if (!isNode(value)) return value as Stored;
      if (isStreamFact(value)) return { $stream: value[STREAM] };
      const known = objectIds.get(value);
      if (known !== undefined) return { $: known };
      const id = nextObjectId++;
      objectIds.set(value, id);
      nodes[id - fromObjectId] = body(value);
      return { $: id };
    };

    const body = (value: object): Stored =>
      isSecret(value) ? { $secret: storedSecret(value) }
        : Array.isArray(value) ? value.map(write)
          : Object.fromEntries(Object.entries(value).map(([key, child]) => [encodeKey(key), write(child)]));

    const encoded = Object.fromEntries(Object.entries(facts).map(([key, value]) => [encodeKey(key), write(value)]));
    if (nodes.length > 0) emit({ type: 'object', fromObjectId, nodes });
    return encoded;
  };

  return { encodeFacts, write: (value: unknown, emit: (event: DumpEvent) => void) => encodeFacts({ value }, emit)['value']! };
};

/**
 * A run's events, encoded. Folding is by identity, which is the convention structural
 * sharing already rests on: a `stage.entered` always appears — it is what puts the stage in
 * the tree, so dropping it would strand its children's `parentStageId` — but it carries
 * `facts` only when they differ from its parent's, and a `stage.leaved` that hands up
 * exactly what its last child handed up carries nothing at all and goes.
 */
export const encodeRun = (events: readonly Event[], options?: { readonly shareStringsFrom?: number }): DumpEvent[] => {
  const encoder = createEncoder(options);
  const out: DumpEvent[] = [];
  const emit = (event: DumpEvent): void => { out.push(event); };
  const entered = new Map<number, { readonly parent: number | null; readonly facts: Facts }>();
  const lastChildLeft = new Map<number, Facts>();

  for (const event of events) {
    if (event.type === 'stage.entered') {
      const parent = event.parentStageId === null ? undefined : entered.get(event.parentStageId);
      const unchanged = parent !== undefined && parent.facts === event.facts;
      const facts = unchanged ? undefined : encoder.encodeFacts(event.facts, emit);
      emit({ type: 'stage.entered', stageId: event.stageId, name: event.name, parentStageId: event.parentStageId, ...(facts === undefined ? {} : { facts }) });
      entered.set(event.stageId, { parent: event.parentStageId, facts: event.facts });
      continue;
    }
    if (event.type === 'stage.leaved') {
      const seen = entered.get(event.stageId);
      if (lastChildLeft.get(event.stageId) !== event.facts) {
        emit({ type: 'stage.leaved', stageId: event.stageId, facts: encoder.encodeFacts(event.facts, emit) });
      }
      if (seen?.parent != null) lastChildLeft.set(seen.parent, event.facts);
      continue;
    }
    if (event.type === 'stage.log') {
      const fields = event.fields === undefined ? undefined : encoder.encodeFacts(event.fields, emit);
      emit({ type: 'stage.log', stageId: event.stageId, level: event.level, message: event.message, ...(fields === undefined ? {} : { fields }) });
      continue;
    }
    if (event.type === 'stream.frame') {
      emit({ type: 'stream.frame', streamId: event.streamId, frames: event.frames.map(frame => encoder.write(frame, emit)) });
      continue;
    }
    emit(event);
  }
  return out;
};

/** NDJSON, one event per line, appended in order. A line maps to one SSE `data:` payload,
 *  so the stored file and the live protocol are the same bytes. */
export const toNdjson = (events: readonly DumpEvent[]): string =>
  events.map(event => `${JSON.stringify(event)}\n`).join('');
