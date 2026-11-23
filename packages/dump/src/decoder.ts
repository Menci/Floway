import { base64 } from '@scure/base';

import type { EncodedDumpEvent, NumberTag, StoredValue } from './types.ts';
import { Bytes } from '@floway-dev/pipeline/browser';
import type { StageEdge, StoredSecret, StreamEnd } from '@floway-dev/pipeline/browser';

export type DecodedRecord = Readonly<Record<string, unknown>>;
export interface DecodedSecret { readonly $secret: StoredSecret }
export interface DecodedStreamRef { readonly $stream: number }
export interface DecodedDeferredRef { readonly $deferred: number }
export interface DecodedRawJson { readonly rawJSON: string }

export interface DecodedRunSummary {
  readonly runId: string;
  readonly pipeline: string;
  readonly startedAt: number;
  readonly done?: { readonly tMs: number; readonly ok: boolean; readonly error?: unknown };
  readonly truncated?: { readonly tMs: number; readonly reason: 'size-limit' };
}

export interface DecodedStageLog {
  readonly seq: number;
  readonly tMs: number;
  readonly level: string;
  readonly message: string;
  readonly fields?: DecodedRecord;
}

export interface DecodedStageNode {
  readonly stageId: number;
  readonly parentStageId: number | null;
  readonly edge: StageEdge;
  readonly pipeline: string;
  readonly name: string;
  readonly enteredAtMs: number;
  readonly leftAtMs?: number;
  readonly closedAtMs?: number;
  readonly durationMs?: number;
  readonly status: 'running' | 'answered' | 'succeeded' | 'failed';
  readonly encodedFacts: StoredValue;
  readonly facts: DecodedRecord;
  readonly encodedResponseFacts?: StoredValue;
  readonly responseFacts?: DecodedRecord;
  readonly baseChildId?: number;
  readonly failureFacts?: DecodedRecord;
  readonly error?: unknown;
  readonly closeError?: unknown;
  readonly logs: readonly DecodedStageLog[];
  readonly childStageIds: readonly number[];
  readonly createdStreamIds: readonly number[];
  readonly deferredIds: readonly number[];
}

export interface DecodedStreamFrame {
  readonly index: number;
  readonly seq: number;
  readonly tMs: number;
  readonly deltaMs: number;
  readonly value: unknown;
}

export interface DecodedStreamEnd {
  readonly seq: number;
  readonly tMs: number;
  readonly how: StreamEnd['how'];
  readonly error?: unknown;
}

export interface DecodedStreamNode {
  readonly streamId: number;
  readonly stageId: number;
  readonly wraps?: readonly number[];
  readonly label: string;
  readonly createdAtMs: number;
  readonly frames: readonly DecodedStreamFrame[];
  readonly derivedStreamIds: readonly number[];
  readonly end?: DecodedStreamEnd;
}

export type DecodedSettlement =
  | { readonly tMs: number; readonly ok: true; readonly value: unknown }
  | { readonly tMs: number; readonly ok: false; readonly error: unknown };

export interface DecodedDeferredNode {
  readonly deferredId: number;
  readonly stageId: number;
  readonly name: string;
  readonly createdAtMs: number;
  readonly settlement?: DecodedSettlement;
}

export interface DumpViewModel {
  readonly run: DecodedRunSummary | null;
  readonly stages: ReadonlyMap<number, DecodedStageNode>;
  readonly rootStageIds: readonly number[];
  readonly streams: ReadonlyMap<number, DecodedStreamNode>;
  readonly deferreds: ReadonlyMap<number, DecodedDeferredNode>;
}

export interface DumpDecoder {
  readonly model: DumpViewModel;
  readonly push: (chunk: Uint8Array) => DumpViewModel;
  readonly pushNdjsonChunk: (chunk: string | Uint8Array) => DumpViewModel;
  readonly pushEvents: (events: Iterable<EncodedDumpEvent>) => DumpViewModel;
  readonly finish: () => DumpViewModel;
  readonly resolve: (value: StoredValue) => unknown;
  readonly getStoredNode: (id: number) => StoredValue | undefined;
}

type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer Element)[] ? Element[] : T[K];
};

const secrets = new WeakSet<object>();
const streams = new WeakSet<object>();
const deferreds = new WeakSet<object>();
const rawJson = new WeakSet<object>();

const tagged = <T extends object>(set: WeakSet<object>, value: T): Readonly<T> => {
  set.add(value);
  return Object.freeze(value);
};

export const isDecodedSecret = (value: unknown): value is DecodedSecret =>
  typeof value === 'object' && value !== null && secrets.has(value);
export const isDecodedStreamRef = (value: unknown): value is DecodedStreamRef =>
  typeof value === 'object' && value !== null && streams.has(value);
export const isDecodedDeferredRef = (value: unknown): value is DecodedDeferredRef =>
  typeof value === 'object' && value !== null && deferreds.has(value);
export const isDecodedRawJson = (value: unknown): value is DecodedRawJson =>
  typeof value === 'object' && value !== null && rawJson.has(value);

const numbers: Record<NumberTag, number> = { NaN, Infinity, '-Infinity': -Infinity, '-0': -0 };
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const storedTag = (value: Record<string, unknown>): string | undefined =>
  Object.keys(value).find(key => key.startsWith('$') && !key.startsWith('$$'));

const tagString = (value: unknown, tag: string): string => {
  if (typeof value !== 'string') throw new TypeError(`Invalid dump ${tag} value`);
  return value;
};

const tagId = (value: unknown, tag: string): number => {
  if (typeof value !== 'number' || value < 1 || !Number.isSafeInteger(value))
    throw new TypeError(`Invalid dump ${tag} id`);
  return value;
};

const requireEntry = <T>(map: ReadonlyMap<number, T>, id: number, kind: string): T => {
  const entry = map.get(id);
  if (entry === undefined) throw new Error(`Missing dump ${kind} ${id}`);
  return entry;
};

export const createDumpDecoder = (): DumpDecoder => {
  const nodes = new Map<number, StoredValue>();
  const resolved = new Map<number, unknown>();
  const stages = new Map<number, Mutable<DecodedStageNode>>();
  const pendingStreamsByStage = new Map<number, number[]>();
  const streamNodes = new Map<number, Mutable<DecodedStreamNode>>();
  const deferredNodes = new Map<number, Mutable<DecodedDeferredNode>>();
  const rootStageIds: number[] = [];
  const textDecoder = new TextDecoder('utf-8', { fatal: true });
  let run: Mutable<DecodedRunSummary> | null = null;
  let nextObjectId = 1;
  let lineBuffer = '';

  const model: DumpViewModel = {
    get run() { return run; },
    rootStageIds,
    stages,
    streams: streamNodes,
    deferreds: deferredNodes,
  };

  const populateRecord = (target: Record<string, unknown>, fields: Record<string, unknown>): DecodedRecord => {
    for (const [key, value] of Object.entries(fields))
      Object.defineProperty(target, key.startsWith('$$') ? key.slice(1) : key, {
        enumerable: true, value: resolve(value as StoredValue),
      });
    return Object.freeze(target);
  };

  const resolveNode = (id: number): unknown => {
    if (resolved.has(id)) return resolved.get(id);
    const node = requireEntry(nodes, id, 'object');
    // Install containers before resolving their edges since edges may close a cycle.
    if (Array.isArray(node)) {
      const target: unknown[] = [];
      resolved.set(id, target);
      for (const child of node) target.push(resolve(child));
      return Object.freeze(target);
    }
    if (isRecord(node) && storedTag(node) === undefined) {
      const target: Record<string, unknown> = {};
      resolved.set(id, target);
      return populateRecord(target, node);
    }
    const value = resolve(node);
    resolved.set(id, value);
    return value;
  };

  const resolve = (value: StoredValue): unknown => {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return Object.freeze(value.map(resolve));
    if (!isRecord(value)) throw new TypeError('Invalid stored dump value');
    const tag = storedTag(value);
    switch (tag) {
    case undefined: return populateRecord({}, value);
    case '$': return resolveNode(tagId(value.$, tag));
    case '$undefined': return undefined;
    case '$number': {
      const number = tagString(value.$number, tag);
      if (!Object.hasOwn(numbers, number)) throw new TypeError(`Unknown dump number tag ${number}`);
      return numbers[number as NumberTag];
    }
    case '$bigint': return BigInt(tagString(value.$bigint, tag));
    case '$rawJson': return tagged(rawJson, { rawJSON: tagString(value.$rawJson, tag) });
    case '$bytes': return Bytes.adopt(base64.decode(tagString(value.$bytes, tag)));
    case '$secret': {
      const secret = value.$secret;
      if (!isRecord(secret) || typeof secret.length !== 'number'
        || typeof secret.hash !== 'string' || typeof secret.redacted !== 'string') throw new TypeError('Invalid dump $secret');
      const { length, hash, redacted } = secret;
      return tagged(secrets, { $secret: Object.freeze({ length, hash, redacted }) });
    }
    case '$stream': return tagged(streams, { $stream: tagId(value.$stream, tag) });
    case '$deferred': return tagged(deferreds, { $deferred: tagId(value.$deferred, tag) });
    default: throw new TypeError(`Unknown dump tag ${tag}`);
    }
  };

  const resolveRecord = (value: StoredValue): DecodedRecord => {
    const record = resolve(value);
    if (!isRecord(record)) throw new TypeError('Expected a dump record');
    return record;
  };

  const applyEvent = (event: EncodedDumpEvent): void => {
    if (run?.done) throw new Error('Dump contains an event after done');
    if (event.k === 'run') {
      if (run !== null) throw new Error('Dump contains more than one run header');
      run = { runId: event.runId, pipeline: event.pipeline, startedAt: event.startedAt };
      return;
    }
    if (run === null) throw new Error('Dump event arrived before its run header');
    switch (event.k) {
    case 'obj':
      if (event.from !== nextObjectId) throw new Error(`Expected dump object ${nextObjectId}, got ${event.from}`);
      for (const node of event.nodes) nodes.set(nextObjectId++, node);
      return;
    case 'enter': {
      const { stageId, parentStageId, name, edge, pipeline, tMs, facts } = event;
      if (stages.has(stageId)) throw new Error(`Duplicate dump stage ${stageId}`);
      stages.set(stageId, {
        stageId, parentStageId, name, edge, pipeline,
        enteredAtMs: tMs, status: 'running', encodedFacts: facts, facts: resolveRecord(facts),
        logs: [], childStageIds: [], createdStreamIds: pendingStreamsByStage.get(stageId) ?? [], deferredIds: [],
      });
      pendingStreamsByStage.delete(stageId);
      if (parentStageId === null) rootStageIds.push(stageId);
      else requireEntry(stages, parentStageId, 'parent stage').childStageIds.push(stageId);
      return;
    }
    case 'leave': {
      const stage = requireEntry(stages, event.stageId, 'stage');
      stage.leftAtMs = event.tMs;
      stage.encodedResponseFacts = event.facts;
      stage.responseFacts = resolveRecord(event.facts);
      stage.baseChildId = event.baseChildId;
      stage.status = 'answered';
      return;
    }
    case 'fail': {
      const stage = requireEntry(stages, event.stageId, 'stage');
      stage.failureFacts = resolveRecord(event.facts);
      stage.error = resolve(event.error);
      stage.status = 'failed';
      return;
    }
    case 'closed': {
      const stage = requireEntry(stages, event.stageId, 'stage');
      stage.closedAtMs = event.tMs;
      stage.durationMs = event.tMs - stage.enteredAtMs;
      stage.status = event.ok && stage.status !== 'failed' ? 'succeeded' : 'failed';
      if (event.error !== undefined) {
        stage.closeError = resolve(event.error);
        if (stage.error === undefined) stage.error = stage.closeError;
      }
      return;
    }
    case 'log': {
      const stage = requireEntry(stages, event.stageId, 'stage');
      const { seq, tMs, level, message, fields } = event;
      stage.logs.push({ seq, tMs, level, message, ...(fields === undefined ? {} : { fields: resolveRecord(fields) }) });
      return;
    }
    case 'stream': {
      const { streamId, stageId, wraps, label, tMs } = event;
      if (streamNodes.has(streamId)) throw new Error(`Duplicate dump stream ${streamId}`);
      for (const innerId of wraps ?? []) requireEntry(streamNodes, innerId, 'wrapped stream').derivedStreamIds.push(streamId);
      streamNodes.set(streamId, { streamId, stageId, wraps, label, createdAtMs: tMs, frames: [], derivedStreamIds: [] });
      // The input factory can announce streams for the reserved root id before enter.
      const ownerStreams = stages.get(stageId)?.createdStreamIds ?? pendingStreamsByStage.get(stageId);
      if (ownerStreams === undefined) pendingStreamsByStage.set(stageId, [streamId]);
      else ownerStreams.push(streamId);
      return;
    }
    case 'frames': {
      const { frames } = requireEntry(streamNodes, event.streamId, 'stream');
      for (const { seq, tMs, v } of event.frames)
        frames.push({ index: frames.length, seq, tMs, deltaMs: tMs - (frames.at(-1)?.tMs ?? tMs), value: resolve(v) });
      return;
    }
    case 'end': {
      const stream = requireEntry(streamNodes, event.streamId, 'stream');
      const { seq, tMs, how, error } = event;
      stream.end = { seq, tMs, how, ...(error === undefined ? {} : { error: resolve(error) }) };
      return;
    }
    case 'deferred': {
      const { deferredId, stageId, name, tMs } = event;
      if (deferredNodes.has(deferredId)) throw new Error(`Duplicate dump deferred ${deferredId}`);
      deferredNodes.set(deferredId, { deferredId, stageId, name, createdAtMs: tMs });
      requireEntry(stages, stageId, 'deferred owner').deferredIds.push(deferredId);
      return;
    }
    case 'settled': {
      const deferred = requireEntry(deferredNodes, event.deferredId, 'deferred');
      deferred.settlement = event.ok
        ? { ok: true, tMs: event.tMs, value: resolve(event.value) }
        : { ok: false, tMs: event.tMs, error: resolve(event.error) };
      return;
    }
    case 'truncated':
      run.truncated = { tMs: event.tMs, reason: event.reason };
      return;
    case 'done':
      run.done = {
        tMs: event.tMs, ok: event.ok,
        ...(event.error === undefined ? {} : { error: resolve(event.error) }),
      };
      return;
    default:
      throw new TypeError('Unknown dump event');
    }
  };

  const parseLine = (line: string): void => {
    if (line.trim().length !== 0) applyEvent(JSON.parse(line) as EncodedDumpEvent);
  };

  const append = (text: string): void => {
    let start = 0;
    for (let newline = text.indexOf('\n'); newline !== -1; newline = text.indexOf('\n', start)) {
      parseLine(lineBuffer + text.slice(start, newline));
      lineBuffer = '';
      start = newline + 1;
    }
    lineBuffer += text.slice(start);
  };

  const pushNdjsonChunk = (chunk: string | Uint8Array): DumpViewModel => {
    append(typeof chunk === 'string' ? textDecoder.decode() + chunk : textDecoder.decode(chunk, { stream: true }));
    return model;
  };

  return {
    model,
    push: pushNdjsonChunk,
    pushNdjsonChunk,
    pushEvents(events) {
      for (const event of events) applyEvent(event);
      return model;
    },
    finish() {
      append(textDecoder.decode());
      parseLine(lineBuffer);
      lineBuffer = '';
      if (run?.done === undefined) throw new Error('Dump ended before done');
      return model;
    },
    resolve,
    getStoredNode: id => nodes.get(id),
  };
};

export const getStreamLineage = (model: DumpViewModel, streamId: number): readonly number[] => {
  const stream = model.streams.get(streamId);
  if (!stream) return [];
  const lineage: number[] = [];
  const seen = new Set<number>();
  const addInputs = (node: DecodedStreamNode): void => {
    if (seen.has(node.streamId)) return;
    seen.add(node.streamId);
    for (const innerId of node.wraps ?? []) addInputs(requireEntry(model.streams, innerId, 'wrapped stream'));
    lineage.push(node.streamId);
  };
  addInputs(stream);
  const descendants = [...stream.derivedStreamIds];
  for (const id of descendants) {
    if (seen.has(id)) continue;
    seen.add(id);
    lineage.push(id);
    descendants.push(...requireEntry(model.streams, id, 'derived stream').derivedStreamIds);
  }
  return lineage;
};
