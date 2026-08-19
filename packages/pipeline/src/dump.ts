// What a run emits, and how it is written down.
//
// A run emits a sequence of events. What a live observer is given and what is stored are
// the same sequence, so there is one encoding and one thing to implement.
//
//   { type: 'stage.entered', stageId, name, parentStageId, facts }
//   { type: 'stage.leaved',  stageId, facts }
//   { type: 'stage.log',     stageId, level, context, message, fields }
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
import { base64 } from '@scure/base';

import type { Facts } from './facts.ts';
import type { LogEntry, LogLevel } from './stage.ts';

/** What the runner produces, with facts still as live objects. */
export type Event =
  | { readonly type: 'stage.entered'; readonly stageId: number; readonly name: string; readonly parentStageId: number | null; readonly facts: Facts }
  | { readonly type: 'stage.leaved'; readonly stageId: number; readonly facts: Facts }
  /** What that stage's own logger wrote. A log line is content about a stage, like the
   *  rest, and it has to be somewhere: every stage gets a logger and with a dump open its
   *  lines are stored into that stage's record as well as going to the global sink. */
  | ({ readonly type: 'stage.log'; readonly stageId: number } & LogEntry)
  | { readonly type: 'stream.frame'; readonly streamId: number; readonly frames: readonly unknown[] }
  | { readonly type: 'stream.end'; readonly streamId: number };

// --- Value kinds the space cannot hold as plain data -------------------------------

const SECRET = Symbol('floway.secret');
const RENDERED = Symbol('floway.secret.rendered');
const STREAM = Symbol('floway.stream');

/**
 * A value-level marker that redaction reads. *Secret* and *credential* are two different
 * concepts and only the first exists this far down: a stage knows some values are secret,
 * sends them exactly as given, and does nothing extra either way. What a thing is, who
 * issued it and when it expires is a domain concept the ending stage never hears of.
 */
export interface Secret<T> {
  readonly [SECRET]: true;
  readonly [RENDERED]: string;
  /** Reading it is deliberate and greppable. The dump never calls this. */
  readonly reveal: () => T;
}

/** A renderer is required exactly when the value is not already a string, because
 *  `{length, redacted, hash}` is a statement about a rendering and `String(bytes)` is not
 *  one anybody would recognise. */
export function secret(value: string): Secret<string>;
export function secret<T>(value: T, render: (value: T) => string): Secret<T>;
export function secret<T>(value: T, render?: (value: T) => string): Secret<T> {
  return {
    [SECRET]: true,
    [RENDERED]: render === undefined ? (value as unknown as string) : render(value),
    reveal: () => value,
  };
}

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
 * `length` and `redacted` are what it renders. All three are produced here, because a
 * reader has nothing to compute them from — that is the point.
 *
 * How much of a secret the redacted form shows at each length is deliberately one
 * function, because the policy is not settled.
 */
export const storedSecret = (value: Secret<unknown>): StoredSecret => {
  const rendered = value[RENDERED];
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
  | { readonly $bytes: string }
  | { readonly $undefined: true }
  | { readonly $number: 'NaN' | 'Infinity' | '-Infinity' }
  | { readonly $bigint: string }
  | Stored[]
  | { readonly [key: string]: Stored };

export type DumpEvent =
  | { readonly type: 'stage.entered'; readonly stageId: number; readonly name: string; readonly parentStageId: number | null; readonly facts?: Record<string, Stored> }
  | { readonly type: 'stage.leaved'; readonly stageId: number; readonly facts: Record<string, Stored> }
  | { readonly type: 'stage.log'; readonly stageId: number; readonly level: LogLevel; readonly context: string; readonly message: string; readonly fields?: Record<string, Stored> }
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
 * Every value JSON cannot carry gets its own tag, because a record and a dump that
 * disagree in the direction that looks correct is the worst way for them to disagree —
 * which is the same reason `undefined` is not a removal. `JSON.stringify` drops
 * `undefined`, turns `NaN` and the infinities into `null`, and throws on a `bigint`.
 */
const tagged = (value: unknown): Stored | undefined => {
  if (value === undefined) return { $undefined: true };
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (typeof value !== 'number' || Number.isFinite(value)) return undefined;
  return { $number: Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity' };
};

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
 * Bytes and large strings are shared by value, which is the only handle left when a stage
 * deep-clones a payload: every object below the clone is new, and an embedded image is
 * still the same bytes.
 */
export const createEncoder = (options: { readonly shareStringsFrom?: number } = {}) => {
  const shareStringsFrom = options.shareStringsFrom ?? 1024;
  const objectIds = new Map<object, number>();
  const stringIds = new Map<string, number>();
  let nextObjectId = 1;

  const encodeFacts = (facts: Readonly<Record<string, unknown>>, emit: (event: DumpEvent) => void): Record<string, Stored> => {
    const fromObjectId = nextObjectId;
    const nodes: Stored[] = [];

    const write = (value: unknown): Stored => {
      const tag = tagged(value);
      if (tag !== undefined) return tag;
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

    // A buffer is atomic and records its full content, the way a string does — walking it
    // by index would turn one image into a JSON object with a key per byte.
    const body = (value: object): Stored =>
      isSecret(value) ? { $secret: storedSecret(value) }
        : ArrayBuffer.isView(value) ? { $bytes: base64.encode(bytesOf(value)) }
          : Array.isArray(value) ? value.map(write)
            : Object.fromEntries(Object.entries(value).map(([key, child]) => [encodeKey(key), write(child)]));

    const encoded = Object.fromEntries(Object.entries(facts).map(([key, value]) => [encodeKey(key), write(value)]));
    if (nodes.length > 0) emit({ type: 'object', fromObjectId, nodes });
    return encoded;
  };

  return { encodeFacts };
};

const bytesOf = (view: ArrayBufferView): Uint8Array =>
  new Uint8Array(view.buffer, view.byteOffset, view.byteLength);

/**
 * One event in, its encoding out — so a run can be written down as it happens rather than
 * only once it is over, which is what a live observer and an appended file both need.
 *
 * Folding is by identity, the convention structural sharing already rests on: a
 * `stage.entered` always appears — it is what puts the stage in the tree, so dropping it
 * would strand its children's `parentStageId` — but it carries `facts` only when they
 * differ from its parent's, and a `stage.leaved` that hands up exactly what its last child
 * handed up carries nothing at all and goes.
 */
export const createRunEncoder = (options?: { readonly shareStringsFrom?: number }) => {
  const encoder = createEncoder(options);
  const entered = new Map<number, { readonly parent: number | null; readonly facts: Facts }>();
  const lastChildLeft = new Map<number, Facts>();

  return (event: Event): DumpEvent[] => {
    const out: DumpEvent[] = [];
    const emit = (encoded: DumpEvent): void => { out.push(encoded); };

    if (event.type === 'stage.entered') {
      const parent = event.parentStageId === null ? undefined : entered.get(event.parentStageId);
      const unchanged = parent !== undefined && parent.facts === event.facts;
      const facts = unchanged ? undefined : encoder.encodeFacts(event.facts, emit);
      emit({
        type: 'stage.entered',
        stageId: event.stageId,
        name: event.name,
        parentStageId: event.parentStageId,
        ...(facts === undefined ? {} : { facts }),
      });
      entered.set(event.stageId, { parent: event.parentStageId, facts: event.facts });
      return out;
    }

    if (event.type === 'stage.leaved') {
      const seen = entered.get(event.stageId);
      if (lastChildLeft.get(event.stageId) !== event.facts) {
        emit({ type: 'stage.leaved', stageId: event.stageId, facts: encoder.encodeFacts(event.facts, emit) });
      }
      if (seen?.parent != null) lastChildLeft.set(seen.parent, event.facts);
      return out;
    }

    if (event.type === 'stage.log') {
      const fields = event.fields === undefined ? undefined : encoder.encodeFacts(event.fields, emit);
      emit({
        type: 'stage.log',
        stageId: event.stageId,
        level: event.level,
        context: event.context,
        message: event.message,
        ...(fields === undefined ? {} : { fields }),
      });
      return out;
    }

    if (event.type === 'stream.frame') {
      const frames = event.frames.map(frame => encoder.encodeFacts({ frame }, emit)['frame']!);
      emit({ type: 'stream.frame', streamId: event.streamId, frames });
      return out;
    }

    emit(event);
    return out;
  };
};

/** A whole run at once, for a caller that already has every event. */
export const encodeRun = (events: readonly Event[], options?: { readonly shareStringsFrom?: number }): DumpEvent[] => {
  const encode = createRunEncoder(options);
  return events.flatMap(encode);
};

/** NDJSON, one event per line, appended in order. A line maps to one SSE `data:` payload,
 *  so the stored file and the live protocol are the same bytes. */
export const toNdjson = (events: readonly DumpEvent[]): string =>
  events.map(event => `${JSON.stringify(event)}\n`).join('');

// --- The reading -------------------------------------------------------------------

/**
 * Resolves a run's own object space as its events arrive.
 *
 * The encoder interns: a value that appears twice is written once as a node under an `object`
 * event and pointed at by `{"$": n}` everywhere after. A reader folds the same way — it keeps
 * every node it has been given and resolves a reference against them — and it can do so line by
 * line, because the format's own invariant is that a reference never points forward.
 *
 * What comes back is the value as the run held it, with the two things JSON cannot carry
 * restored: `undefined` and the numeric edges. A secret stays redacted, because redaction is
 * what was stored; bytes stay base64, because reading them back out is a decision about what
 * they are and this knows only that they are bytes.
 */
export const createRunReader = () => {
  const nodes = new Map<number, Stored>();
  const resolved = new Map<number, unknown>();

  const read = (stored: Stored): unknown => {
    if (stored === null || typeof stored !== 'object') return stored;
    if (Array.isArray(stored)) return stored.map(read);
    if ('$' in stored) {
      const id = stored.$ as number;
      if (resolved.has(id)) return resolved.get(id);
      const node = nodes.get(id);
      if (node === undefined) throw new Error(`dump reference $${id} points at a node no event carried`);
      const value = read(node);
      resolved.set(id, value);
      return value;
    }
    if ('$stream' in stored) return { stream: stored.$stream };
    if ('$secret' in stored) return stored.$secret;
    if ('$bytes' in stored) return { bytes: stored.$bytes };
    if ('$undefined' in stored) return undefined;
    if ('$number' in stored) return stored.$number === 'NaN' ? NaN : stored.$number === 'Infinity' ? Infinity : -Infinity;
    if ('$bigint' in stored) return BigInt(stored.$bigint as string);
    return Object.fromEntries(Object.entries(stored).map(([key, child]) => [decodeKey(key), read(child)]));
  };

  /** What one event says. An `object` event says nothing on its own — it is the space the
   *  events around it are written against — so it reads as `null`. */
  return (event: DumpEvent): { readonly facts?: Record<string, unknown>; readonly frames?: readonly unknown[] } | null => {
    if (event.type === 'object') {
      event.nodes.forEach((node, index) => { nodes.set(event.fromObjectId + index, node); });
      return null;
    }
    if (event.type === 'stream.frame') return { frames: event.frames.map(read) };
    if (event.type === 'stage.entered' || event.type === 'stage.leaved') {
      return event.facts === undefined
        ? {}
        : { facts: Object.fromEntries(Object.entries(event.facts).map(([key, value]) => [decodeKey(key), read(value)])) };
    }
    return {};
  };
};
