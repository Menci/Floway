import { base64 } from '@scure/base';

import type { DumpEvent, DumpLog, DumpResult, EncodedValue, NumberMarker, SecretDescription } from './wire.ts';

export type DumpFacts = Readonly<Record<string, unknown>>;
export interface DumpStreamRef { readonly $stream: number }
export interface DumpDeferredRef { readonly $deferred: number }
export interface DumpSecret { readonly $secret: SecretDescription }
export interface DumpRawJson { readonly rawJSON: string }

export interface DumpStage {
  readonly stageId: number;
  readonly name: string;
  readonly parentStageId?: number;
  readonly requestFacts: DumpFacts;
  readonly responseFacts?: DumpFacts;
  readonly panic?: { readonly facts?: DumpFacts; readonly error: unknown };
  readonly childStageIds: readonly number[];
  readonly logs: readonly DumpLog<unknown>[];
}

export interface DumpStream {
  readonly streamId: number;
  readonly frames: readonly DumpResult<unknown>[];
  readonly ended: boolean;
}

export interface DumpDeferred {
  readonly deferredId: number;
  readonly settlement?: DumpResult<unknown>;
}

export interface DecodedDump {
  readonly rootStageIds: readonly number[];
  readonly stages: ReadonlyMap<number, DumpStage>;
  readonly streams: ReadonlyMap<number, DumpStream>;
  readonly deferreds: ReadonlyMap<number, DumpDeferred>;
}

type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer Element)[] ? Element[] : T[K];
};

const streamRefs = new WeakSet<object>();
const deferredRefs = new WeakSet<object>();
const secrets = new WeakSet<object>();
const rawJson = new WeakSet<object>();

const tagged = <T extends object>(set: WeakSet<object>, value: T): Readonly<T> => {
  set.add(value);
  return Object.freeze(value);
};

const isTagged = (set: WeakSet<object>, value: unknown): boolean =>
  typeof value === 'object' && value !== null && set.has(value);

export const isDumpStreamRef = (value: unknown): value is DumpStreamRef => isTagged(streamRefs, value);
export const isDumpDeferredRef = (value: unknown): value is DumpDeferredRef => isTagged(deferredRefs, value);
export const isDumpSecret = (value: unknown): value is DumpSecret => isTagged(secrets, value);
export const isDumpRawJson = (value: unknown): value is DumpRawJson => isTagged(rawJson, value);

const numbers: Record<NumberMarker, number> = { NaN, Infinity, '-Infinity': -Infinity, '-0': -0 };

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const marker = (value: Record<string, unknown>): string | undefined => {
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0]!.startsWith('$') && !keys[0]!.startsWith('$$') ? keys[0] : undefined;
};

const validId = (id: unknown): id is number => typeof id === 'number' && id > 0 && Number.isSafeInteger(id);

const requireEntry = <T>(entries: ReadonlyMap<number, T>, id: number, kind: string): T => {
  const entry = entries.get(id);
  if (entry === undefined) throw new TypeError(`Missing dump ${kind} ${id}`);
  return entry;
};

const readSecret = (value: unknown): DumpSecret => {
  if (!record(value) || typeof value.length !== 'number' || typeof value.redacted !== 'string' || typeof value.hash !== 'string') {
    throw new TypeError('Invalid dump secret');
  }
  return tagged(secrets, { $secret: Object.freeze({ length: value.length, redacted: value.redacted, hash: value.hash }) });
};

export const createDumpDecoder = () => {
  const objects = new Map<number, unknown>();
  const stages = new Map<number, Mutable<DumpStage>>();
  const streams = new Map<number, Mutable<DumpStream>>();
  const deferreds = new Map<number, Mutable<DumpDeferred>>();
  const streamReferences = new Map<number, DumpStreamRef>();
  const deferredReferences = new Map<number, DumpDeferredRef>();
  const rootStageIds: number[] = [];
  const textDecoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let lineNumber = 0;
  let finished = false;

  const stream = (streamId: number): Mutable<DumpStream> => {
    if (!validId(streamId)) throw new TypeError('Invalid dump stream ID');
    const existing = streams.get(streamId);
    if (existing) return existing;
    const entry = { streamId, frames: [], ended: false };
    streams.set(streamId, entry);
    return entry;
  };

  const deferred = (deferredId: number): Mutable<DumpDeferred> => {
    if (!validId(deferredId)) throw new TypeError('Invalid dump deferred ID');
    const existing = deferreds.get(deferredId);
    if (existing) return existing;
    const entry = { deferredId };
    deferreds.set(deferredId, entry);
    return entry;
  };

  const resolve = (value: unknown): unknown => {
    if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value;
    if (!record(value)) throw new TypeError('Invalid dump value');
    const key = marker(value);
    const payload = key === undefined ? undefined : value[key];
    switch (key) {
    case '$':
      if (validId(payload)) return requireEntry(objects, payload, 'object');
      break;
    case '$stream':
      if (validId(payload)) {
        stream(payload);
        const reference = streamReferences.get(payload) ?? tagged(streamRefs, { $stream: payload });
        streamReferences.set(payload, reference);
        return reference;
      }
      break;
    case '$deferred':
      if (validId(payload)) {
        deferred(payload);
        const reference = deferredReferences.get(payload) ?? tagged(deferredRefs, { $deferred: payload });
        deferredReferences.set(payload, reference);
        return reference;
      }
      break;
    case '$undefined':
      if (payload === true) return undefined;
      break;
    case '$number':
      if (typeof payload === 'string' && Object.hasOwn(numbers, payload)) return numbers[payload as NumberMarker];
      break;
    }
    throw new TypeError('Invalid dump value marker');
  };

  const define = (from: number, nodes: readonly unknown[], sources: ReadonlyMap<string, string> | undefined): void => {
    if (from !== objects.size + 1 || !nodes.length) throw new TypeError('Noncontiguous dump object IDs');
    const fields: (() => void)[] = [];
    for (const [index, node] of nodes.entries()) {
      const id = from + index;
      if (Array.isArray(node)) {
        const array: unknown[] = [];
        objects.set(id, array);
        fields.push(() => { for (const value of node) array.push(resolve(value)); });
      } else if (record(node)) {
        const tag = marker(node);
        if (tag === '$bytes' && typeof node.$bytes === 'string') objects.set(id, base64.decode(node.$bytes));
        else if (tag === '$secret') objects.set(id, readSecret(node.$secret));
        else {
          const value: Record<string, unknown> = Object.create(null);
          objects.set(id, value);
          fields.push(() => {
            for (const [key, child] of Object.entries(node)) {
              if (key.startsWith('$') && !key.startsWith('$$')) throw new TypeError(`Invalid dump object key ${key}`);
              value[key.startsWith('$$') ? key.slice(1) : key] = resolve(child);
            }
          });
        }
      } else {
        const source = sources?.get(String(index));
        if (source === undefined) throw new TypeError('Dump raw JSON requires primitive source text');
        objects.set(id, tagged(rawJson, { rawJSON: source }));
      }
    }
    for (const assign of fields) assign();
  };

  const facts = (value: EncodedValue): DumpFacts => {
    const decoded = resolve(value);
    if (!record(decoded)) throw new TypeError('Dump facts require a dictionary');
    return decoded;
  };

  const result = (item: DumpResult<EncodedValue>): DumpResult<unknown> => {
    if (item.ok === true) return { ok: true, value: resolve(item.value) };
    if (item.ok === false) return { ok: false, error: resolve(item.error) };
    throw new TypeError('Invalid dump result');
  };

  const apply = (event: DumpEvent, sources: WeakMap<object, Map<string, string>>): void => {
    switch (event.type) {
    case 'object':
      define(event.fromObjectId, event.nodes, sources.get(event.nodes));
      return;
    case 'stage.entered': {
      const { stageId, parentStageId, name } = event;
      if (!validId(stageId) || stages.has(stageId) || typeof name !== 'string') throw new TypeError('Invalid dump stage entry');
      if (parentStageId === undefined) rootStageIds.push(stageId);
      else requireEntry(stages, parentStageId, 'parent stage').childStageIds.push(stageId);
      stages.set(stageId, { stageId, name, ...(parentStageId !== undefined && { parentStageId }), requestFacts: facts(event.facts), childStageIds: [], logs: [] });
      return;
    }
    case 'stage.leaved': {
      const stage = requireEntry(stages, event.stageId, 'stage');
      if (stage.responseFacts || stage.panic) throw new TypeError(`Duplicate dump stage return ${event.stageId}`);
      stage.responseFacts = facts(event.facts);
      return;
    }
    case 'stage.panicked': {
      const stage = requireEntry(stages, event.stageId, 'stage');
      if (stage.panic) throw new TypeError(`Duplicate dump stage panic ${event.stageId}`);
      stage.panic = { error: resolve(event.error), ...(event.facts !== undefined && { facts: facts(event.facts) }) };
      return;
    }
    case 'stream.frame': {
      const entry = stream(event.streamId);
      if (entry.ended) throw new TypeError(`Dump stream ${event.streamId} emitted after its end`);
      entry.frames.push(result(event.item));
      return;
    }
    case 'stream.end': {
      const entry = stream(event.streamId);
      if (entry.ended) throw new TypeError(`Duplicate dump stream end ${event.streamId}`);
      entry.ended = true;
      return;
    }
    case 'deferred.settled': {
      const entry = deferred(event.deferredId);
      if (entry.settlement) throw new TypeError(`Duplicate dump deferred settlement ${event.deferredId}`);
      entry.settlement = result(event);
      return;
    }
    case 'log': {
      const { fields, error, ...log } = event;
      requireEntry(stages, event.stageId, 'log stage').logs.push({ ...log, fields: resolve(fields), ...(Object.hasOwn(event, 'error') && { error: resolve(error) }) });
      return;
    }
    default:
      throw new TypeError('Unknown dump event');
    }
  };

  const append = (text: string): void => {
    buffer += text;
    let start = 0;
    for (let newline = buffer.indexOf('\n', start); newline !== -1; newline = buffer.indexOf('\n', start)) {
      const line = buffer.slice(start, newline);
      lineNumber++;
      start = newline + 1;
      try {
        const sources = new WeakMap<object, Map<string, string>>();
        const event = JSON.parse(line, function (this: unknown, key: string, value: unknown, context?: { source?: string }) {
          if (Array.isArray(this) && context?.source !== undefined) {
            const parent = sources.get(this) ?? new Map<string, string>();
            parent.set(key, context.source);
            sources.set(this, parent);
          }
          return value;
        }) as DumpEvent;
        apply(event, sources);
      } catch (error) {
        throw new Error(`Invalid pipeline dump on line ${lineNumber}`, { cause: error });
      }
    }
    buffer = buffer.slice(start);
  };

  return {
    push(chunk: string | Uint8Array): void {
      if (finished) throw new Error('Cannot append to a completed dump');
      append(typeof chunk === 'string' ? textDecoder.decode() + chunk : textDecoder.decode(chunk, { stream: true }));
    },
    finish(): DecodedDump {
      append(textDecoder.decode());
      if (buffer.length) throw new TypeError('Dump has an incomplete NDJSON line');
      if (!rootStageIds.length || [...stages.values()].some(stage => !stage.responseFacts && !stage.panic)) {
        throw new TypeError('Dump has incomplete stage outcomes');
      }
      finished = true;
      return { rootStageIds, stages, streams, deferreds };
    },
  };
};

export const decodeDump = (contents: string | Uint8Array): DecodedDump => {
  const decoder = createDumpDecoder();
  decoder.push(contents);
  return decoder.finish();
};
