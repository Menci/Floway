import { base64 } from '@scure/base';

import { decodeKey } from './dump-encoder.ts';
import type {
  EncodedDumpEvent,
  StoredSecret,
  StoredValue,
  StreamEndHow,
  TapPoint,
} from './types.ts';

type DecodedObject = Record<string, unknown>;
const RAW_JSON_BRAND = Symbol('floway.pipeline.raw-json');
type BrandedRawJson = { readonly rawJSON: string; readonly [RAW_JSON_BRAND]: true };

export interface DecodedSecret {
  readonly $secret: StoredSecret;
}

export interface DecodedStreamRef {
  readonly $stream: number;
}

export interface DecodedErrorValue {
  readonly $error: Readonly<Record<string, unknown>>;
}

export interface DecodedRunSummary {
  readonly runId: string;
  readonly pipelineName: string;
  readonly startedAt: number;
  readonly meta: unknown;
  readonly done?: {
    readonly tMs: number;
    readonly ok: boolean;
    readonly summary: unknown;
    readonly error?: unknown;
  };
  readonly truncated?: {
    readonly tMs: number;
    readonly reason: string;
    readonly droppedEvents: number;
  };
}

export interface DecodedStageLog {
  readonly seq: number;
  readonly tMs: number;
  readonly level: string;
  readonly message: string;
  readonly fields?: unknown;
}

export interface DecodedStageNode {
  readonly stageId: number;
  readonly parentStageId: number | null;
  readonly edgeKind: string;
  readonly name: string;
  readonly tap?: TapPoint;
  readonly enteredAtMs: number;
  readonly leftAtMs?: number;
  readonly durationMs?: number;
  readonly status: 'running' | 'succeeded' | 'failed';
  readonly encodedFacts: StoredValue;
  readonly facts: Record<string, unknown>;
  readonly encodedOutcome?: StoredValue;
  readonly outcome?: unknown;
  readonly error?: unknown;
  readonly logs: readonly DecodedStageLog[];
  readonly childStageIds: readonly number[];
  readonly createdStreamIds: readonly number[];
}

export interface DecodedStreamFrame {
  readonly index: number;
  readonly seq: number;
  readonly tMs: number;
  readonly deltaMs: number;
  readonly encodedValue: StoredValue;
  readonly value: unknown;
}

export interface DecodedStreamEnd {
  readonly seq: number;
  readonly tMs: number;
  readonly how: StreamEndHow;
  readonly error?: unknown;
}

export interface DecodedStreamNode {
  readonly streamId: number;
  readonly createdByStageId: number;
  readonly wraps?: number;
  readonly derivedStreamIds: readonly number[];
  readonly label?: string;
  readonly createdAtMs: number;
  readonly frames: readonly DecodedStreamFrame[];
  readonly end?: DecodedStreamEnd;
}

export interface DumpViewModel {
  readonly run: DecodedRunSummary | null;
  readonly stages: ReadonlyMap<number, DecodedStageNode>;
  readonly rootStageIds: readonly number[];
  readonly streams: ReadonlyMap<number, DecodedStreamNode>;
}

export type DiffPathSegment = string | number;

export interface StructuralDiffEntry {
  readonly path: readonly DiffPathSegment[];
  readonly kind: 'added' | 'removed' | 'changed';
  readonly before?: unknown;
  readonly after?: unknown;
}

export interface DumpDecoder {
  readonly pushEvents: (events: Iterable<EncodedDumpEvent>) => DumpViewModel;
  readonly pushNdjsonChunk: (chunk: string | Uint8Array, options?: { readonly final?: boolean }) => DumpViewModel;
  readonly resolve: (value: StoredValue) => unknown;
  readonly getStoredNode: (id: number) => StoredValue | undefined;
  readonly view: () => DumpViewModel;
}

export interface StageDiff {
  readonly childStageId: number;
  readonly childName: string;
  readonly entries: readonly StructuralDiffEntry[];
}

export interface StageDiffs {
  readonly downward: readonly StageDiff[];
  readonly upward: readonly StageDiff[];
}

interface MutableStage {
  readonly stageId: number;
  parentStageId: number | null;
  edgeKind: string;
  name: string;
  tap?: TapPoint;
  enteredAtMs: number;
  leftAtMs?: number;
  status: 'running' | 'succeeded' | 'failed';
  encodedFacts: StoredValue;
  facts: Record<string, unknown>;
  encodedOutcome?: StoredValue;
  outcome?: unknown;
  error?: unknown;
  logs: DecodedStageLog[];
  childStageIds: number[];
  createdStreamIds: number[];
}

interface MutableStream {
  readonly streamId: number;
  createdByStageId: number;
  wraps?: number;
  label?: string;
  createdAtMs: number;
  frames: DecodedStreamFrame[];
  end?: DecodedStreamEnd;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const defineValue = (target: DecodedObject, key: string, value: unknown): void => {
  Object.defineProperty(target, key, { configurable: true, enumerable: true, value, writable: true });
};

export const isDecodedSecret = (value: unknown): value is DecodedSecret =>
  isRecord(value) && Object.hasOwn(value, '$secret') && isRecord(value.$secret);

export const isDecodedStreamRef = (value: unknown): value is DecodedStreamRef =>
  isRecord(value) && Object.hasOwn(value, '$stream') && typeof value.$stream === 'number';

const numberTagValue = (tag: unknown): unknown => {
  switch (tag) {
  case '-0': return -0;
  case 'NaN': return Number.NaN;
  case 'Infinity': return Number.POSITIVE_INFINITY;
  case '-Infinity': return Number.NEGATIVE_INFINITY;
  default: throw new TypeError(`Unknown number tag ${JSON.stringify(tag)}`);
  }
};

const jsonWithRawJson = JSON as typeof JSON & {
  readonly isRawJSON?: (value: unknown) => boolean;
  readonly rawJSON?: (text: string) => unknown;
};

export const isDecodedRawJson = (value: unknown): value is { readonly rawJSON: string } =>
  jsonWithRawJson.isRawJSON?.(value) === true
  || (typeof value === 'object' && value !== null && (value as Partial<BrandedRawJson>)[RAW_JSON_BRAND] === true);

const rawJsonValue = (value: string): unknown => {
  if (jsonWithRawJson.rawJSON !== undefined) return jsonWithRawJson.rawJSON(value);
  return Object.freeze({
    rawJSON: value,
    [RAW_JSON_BRAND]: true,
  } satisfies BrandedRawJson);
};

const cloneSecret = (info: StoredSecret): DecodedSecret =>
  Object.freeze({ $secret: Object.freeze({ length: info.length, hash: info.hash, redacted: info.redacted }) });

const finalizeStage = (stage: MutableStage): DecodedStageNode => Object.freeze({
  stageId: stage.stageId,
  parentStageId: stage.parentStageId,
  edgeKind: stage.edgeKind,
  name: stage.name,
  ...(stage.tap === undefined ? {} : { tap: stage.tap }),
  enteredAtMs: stage.enteredAtMs,
  ...(stage.leftAtMs === undefined ? {} : {
    leftAtMs: stage.leftAtMs,
    durationMs: stage.leftAtMs - stage.enteredAtMs,
  }),
  status: stage.status,
  encodedFacts: stage.encodedFacts,
  facts: stage.facts,
  ...(stage.encodedOutcome === undefined ? {} : { encodedOutcome: stage.encodedOutcome }),
  ...(stage.outcome === undefined ? {} : { outcome: stage.outcome }),
  ...(stage.error === undefined ? {} : { error: stage.error }),
  logs: Object.freeze([...stage.logs]),
  childStageIds: Object.freeze([...stage.childStageIds]),
  createdStreamIds: Object.freeze([...stage.createdStreamIds]),
});

const finalizeStream = (stream: MutableStream, streams: ReadonlyMap<number, MutableStream>): DecodedStreamNode => {
  const derivedStreamIds: number[] = [];
  for (const candidate of streams.values())
    if (candidate.wraps === stream.streamId) derivedStreamIds.push(candidate.streamId);
  return Object.freeze({
    streamId: stream.streamId,
    createdByStageId: stream.createdByStageId,
    ...(stream.wraps === undefined ? {} : { wraps: stream.wraps }),
    derivedStreamIds: Object.freeze(derivedStreamIds),
    ...(stream.label === undefined ? {} : { label: stream.label }),
    createdAtMs: stream.createdAtMs,
    frames: Object.freeze([...stream.frames]),
    ...(stream.end === undefined ? {} : { end: stream.end }),
  });
};

export const getStreamLineage = (model: DumpViewModel, streamId: number): readonly number[] => {
  if (!model.streams.has(streamId)) return [];
  const ancestorIds: number[] = [];
  const seen = new Set<number>();
  let current: number | undefined = streamId;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    ancestorIds.push(current);
    current = model.streams.get(current)?.wraps;
  }
  const descendants: number[] = [];
  const pending = [...(model.streams.get(streamId)?.derivedStreamIds ?? [])];
  while (pending.length > 0) {
    const descendant = pending.shift()!;
    if (seen.has(descendant)) continue;
    seen.add(descendant);
    descendants.push(descendant);
    pending.push(...(model.streams.get(descendant)?.derivedStreamIds ?? []));
  }
  return Object.freeze([...ancestorIds.reverse(), ...descendants]);
};

const isStoredRef = (value: StoredValue): value is { readonly $: number } =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
  && '$' in value && typeof value.$ === 'number';

const isStoredSecret = (value: StoredValue): value is { readonly $secret: StoredSecret } =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
  && '$secret' in value && isRecord(value.$secret);

const isStoredStreamRef = (value: unknown): value is { readonly $stream: number } =>
  isRecord(value) && '$stream' in value && typeof value.$stream === 'number';

const taggedString = (value: unknown, key: string): string => {
  if (!isRecord(value) || typeof value[key] !== 'string') throw new TypeError(`Invalid ${key} dump tag`);
  return value[key];
};

const hasTag = (value: Record<string, unknown>): boolean =>
  '$' in value || '$secret' in value || '$stream' in value || '$bytes' in value
  || '$undefined' in value || '$number' in value || '$bigint' in value
  || '$rawJson' in value || '$error' in value;

const diffValues = (
  before: StoredValue | undefined,
  after: StoredValue | undefined,
  decoder: DumpDecoder,
): readonly StructuralDiffEntry[] => {
  if (before === undefined && after === undefined) return [];
  if (before === undefined) return [{ path: [], kind: 'added', after: after === undefined ? undefined : decoder.resolve(after) }];
  if (after === undefined) return [{ path: [], kind: 'removed', before: decoder.resolve(before) }];
  if (isStoredRef(before) && isStoredRef(after) && before.$ === after.$) return [];
  if (isStoredSecret(before) && isStoredSecret(after) && before.$secret.hash === after.$secret.hash) return [];

  const entries: StructuralDiffEntry[] = [];
  const seenPairs = new Set<string>();
  const walk = (left: StoredValue, right: StoredValue, path: readonly DiffPathSegment[]): void => {
    if (isStoredRef(left) && isStoredRef(right)) {
      if (left.$ === right.$) return;
      const pair = `${left.$}:${right.$}`;
      if (seenPairs.has(pair)) return;
      seenPairs.add(pair);
      const leftNode = decoder.getStoredNode(left.$);
      const rightNode = decoder.getStoredNode(right.$);
      if (leftNode === undefined || rightNode === undefined) throw new Error(`Missing dump object definition for ${pair}`);
      walk(leftNode, rightNode, path);
      return;
    }
    if (isStoredSecret(left) && isStoredSecret(right) && left.$secret.hash === right.$secret.hash) return;
    const leftValue = decoder.resolve(left);
    const rightValue = decoder.resolve(right);
    if (Object.is(leftValue, rightValue)) return;
    if (Array.isArray(left) && Array.isArray(right)) {
      const length = Math.max(left.length, right.length);
      for (let index = 0; index < length; index++) {
        if (index >= left.length) entries.push({ path: [...path, index], kind: 'added', after: decoder.resolve(right[index]!) });
        else if (index >= right.length) entries.push({ path: [...path, index], kind: 'removed', before: decoder.resolve(left[index]!) });
        else walk(left[index]!, right[index]!, [...path, index]);
      }
      return;
    }
    if (isRecord(left) && isRecord(right)
      && !hasTag(left) && !hasTag(right)
    ) {
      const leftRecord = left as Record<string, StoredValue>;
      const rightRecord = right as Record<string, StoredValue>;
      const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
      for (const key of keys) {
        if (!Object.hasOwn(right, key)) entries.push({ path: [...path, key], kind: 'removed', before: decoder.resolve(leftRecord[key]!) });
        else if (!Object.hasOwn(left, key)) entries.push({ path: [...path, key], kind: 'added', after: decoder.resolve(rightRecord[key]!) });
        else walk(leftRecord[key]!, rightRecord[key]!, [...path, key]);
      }
      return;
    }
    entries.push({ path, kind: 'changed', before: leftValue, after: rightValue });
  };
  walk(before, after, []);
  return Object.freeze(entries);
};

export const createDumpDecoder = (): DumpDecoder => {
  const nodes = new Map<number, StoredValue>();
  const resolved = new Map<number, unknown>();
  const stages = new Map<number, MutableStage>();
  const streams = new Map<number, MutableStream>();
  let run: DecodedRunSummary | null = null;
  let lineBuffer = '';
  const textDecoder = new TextDecoder();

  const resolveNode = (id: number): unknown => {
    if (resolved.has(id)) return resolved.get(id);
    const node = nodes.get(id);
    if (node === undefined) throw new Error(`Dump reference ${id} has no object definition`);
    // A node definition may itself be an array; only an inline `{ $: n }`
    // value is a reference. `resolveNode` knows it is looking at the former.
    if (Array.isArray(node)) {
      const array: unknown[] = [];
      resolved.set(id, array);
      for (const child of node) array.push(resolve(child));
      return array;
    }
    if (isRecord(node) && '$error' in node) {
      const decodedError: DecodedObject = {};
      resolved.set(id, decodedError);
      const fields = resolve(node.$error as StoredValue);
      if (!isRecord(fields)) throw new TypeError('Invalid stored error fields');
      defineValue(decodedError, '$error', Object.freeze(fields));
      return Object.freeze(decodedError);
    }
    let container: DecodedObject | unknown[] | undefined;
    if (Array.isArray(node)) container = [];
    else if (!isStoredRef(node) && !isStoredSecret(node) && !isStoredStreamRef(node)
      && typeof node === 'object' && node !== null
      && !('$undefined' in node || '$number' in node || '$bigint' in node || '$rawJson' in node
        || '$bytes' in node || '$error' in node)) container = {};
    if (container === undefined) {
      const value = resolve(node);
      resolved.set(id, value);
      return value;
    }
    resolved.set(id, container);
    if (Array.isArray(container) && Array.isArray(node)) {
      for (const child of node) container.push(resolve(child));
    } else if (Array.isArray(container) === false && typeof node === 'object' && node !== null && !Array.isArray(node)) {
      for (const [key, child] of Object.entries(node)) {
        if (key === '$' || key === '$secret' || key === '$stream' || key === '$error') continue;
        defineValue(container, decodeKey(key), resolve(child));
      }
    }
    return container;
  };

  const resolve = (stored: StoredValue): unknown => {
    if (stored === null || typeof stored === 'string' || typeof stored === 'boolean' || typeof stored === 'number') return stored;
    if (Array.isArray(stored)) return stored.map(resolve);
    if (isStoredRef(stored)) return resolveNode(stored.$);
    if (!isRecord(stored)) throw new TypeError('Invalid stored dump value');
    if ('$undefined' in stored) return undefined;
    if ('$number' in stored) return numberTagValue(stored.$number);
    if ('$bigint' in stored) return BigInt(taggedString(stored, '$bigint'));
    if ('$rawJson' in stored) return rawJsonValue(taggedString(stored, '$rawJson'));
    if ('$bytes' in stored) return base64.decode(taggedString(stored, '$bytes'));
    if (isStoredSecret(stored)) return cloneSecret(stored.$secret);
    if (isStoredStreamRef(stored)) return Object.freeze({ $stream: stored.$stream });
    if ('$error' in stored) {
      const fields = resolve(stored.$error as StoredValue);
      if (!isRecord(fields)) throw new TypeError('Invalid stored error fields');
      return Object.freeze({ $error: fields });
    }
    const result: DecodedObject = {};
    for (const [key, child] of Object.entries(stored)) {
      if (key.startsWith('$') && !key.startsWith('$$'))
        throw new TypeError(`Unknown dump tag ${key}`);
      defineValue(result, decodeKey(key), resolve(child));
    }
    return result;
  };

  const ensureStage = (stageId: number): MutableStage => {
    const existing = stages.get(stageId);
    if (existing !== undefined) return existing;
    const stage: MutableStage = {
      stageId,
      parentStageId: null,
      edgeKind: 'root',
      name: '',
      enteredAtMs: 0,
      status: 'running',
      encodedFacts: {},
      facts: {},
      logs: [],
      childStageIds: [],
      createdStreamIds: [],
    };
    stages.set(stageId, stage);
    return stage;
  };

  const ensureStream = (streamId: number): MutableStream => {
    const existing = streams.get(streamId);
    if (existing !== undefined) return existing;
    const stream: MutableStream = {
      streamId,
      createdByStageId: 0,
      createdAtMs: 0,
      frames: [],
    };
    streams.set(streamId, stream);
    return stream;
  };

  const buildView = (): DumpViewModel => {
    const decodedStages = new Map<number, DecodedStageNode>();
    const rootStageIds: number[] = [];
    for (const stage of stages.values()) {
      if (stage.parentStageId === null) rootStageIds.push(stage.stageId);
      decodedStages.set(stage.stageId, finalizeStage(stage));
    }
    const decodedStreams = new Map<number, DecodedStreamNode>();
    for (const stream of streams.values()) decodedStreams.set(stream.streamId, finalizeStream(stream, streams));
    return Object.freeze({
      run,
      stages: decodedStages,
      rootStageIds: Object.freeze(rootStageIds),
      streams: decodedStreams,
    });
  };

  const applyEvent = (event: EncodedDumpEvent): void => {
    switch (event.k) {
    case 'run':
      run = Object.freeze({
        runId: event.runId,
        pipelineName: event.pipelineName,
        startedAt: event.startedAt,
        meta: event.meta === undefined ? undefined : resolve(event.meta),
      });
      return;
    case 'obj':
      for (let index = 0; index < event.nodes.length; index++) nodes.set(event.from + index, event.nodes[index]!);
      return;
    case 'enter': {
      const stage = ensureStage(event.stageId);
      stage.parentStageId = event.parentStageId;
      stage.edgeKind = event.edgeKind;
      stage.name = event.name;
      stage.tap = event.tap;
      stage.enteredAtMs = event.tMs;
      stage.encodedFacts = event.facts;
      const facts = resolve(event.facts);
      stage.facts = isRecord(facts) ? facts : {};
      if (event.parentStageId !== null) {
        const parent = ensureStage(event.parentStageId);
        if (!parent.childStageIds.includes(event.stageId)) parent.childStageIds.push(event.stageId);
      }
      return;
    }
    case 'leave': {
      const stage = ensureStage(event.stageId);
      stage.leftAtMs = event.tMs;
      stage.encodedOutcome = event.outcome;
      stage.outcome = resolve(event.outcome);
      stage.status = 'succeeded';
      return;
    }
    case 'fail': {
      const stage = ensureStage(event.stageId);
      stage.leftAtMs = event.tMs;
      stage.error = resolve(event.error);
      stage.status = 'failed';
      return;
    }
    case 'log': {
      const stage = ensureStage(event.stageId);
      stage.logs.push(Object.freeze({
        seq: event.seq,
        tMs: event.tMs,
        level: event.level,
        message: event.message,
        ...(event.fields === undefined ? {} : { fields: resolve(event.fields) }),
      }));
      return;
    }
    case 'stream': {
      const stream = ensureStream(event.streamId);
      stream.createdByStageId = event.createdByStageId;
      stream.wraps = event.wraps;
      stream.label = event.label;
      stream.createdAtMs = event.tMs;
      const stage = ensureStage(event.createdByStageId);
      if (!stage.createdStreamIds.includes(event.streamId)) stage.createdStreamIds.push(event.streamId);
      return;
    }
    case 'frames': {
      const stream = ensureStream(event.streamId);
      for (const frame of event.frames) {
        const previous = stream.frames.at(-1);
        stream.frames.push(Object.freeze({
          index: stream.frames.length,
          seq: frame.seq,
          tMs: frame.tMs,
          deltaMs: previous === undefined ? 0 : frame.tMs - previous.tMs,
          encodedValue: frame.v,
          value: resolve(frame.v),
        }));
      }
      return;
    }
    case 'end': {
      const stream = ensureStream(event.streamId);
      stream.end = Object.freeze({
        seq: event.seq,
        tMs: event.tMs,
        how: event.how,
        ...(event.error === undefined ? {} : { error: resolve(event.error) }),
      });
      return;
    }
    case 'truncated':
      if (run !== null) run = Object.freeze({
        ...run,
        truncated: Object.freeze({ tMs: event.tMs, reason: event.reason, droppedEvents: event.droppedEvents }),
      });
      return;
    case 'done':
      if (run === null) throw new Error('Dump done event arrived before its run event');
      run = Object.freeze({
        ...run,
        done: Object.freeze({
          tMs: event.tMs,
          ok: event.ok,
          summary: event.summary === undefined ? undefined : resolve(event.summary),
          ...(event.error === undefined ? {} : { error: resolve(event.error) }),
        }),
      });
      return;
    }
  };

  const parseLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    applyEvent(JSON.parse(trimmed) as EncodedDumpEvent);
  };

  const pushEvents = (events: Iterable<EncodedDumpEvent>): DumpViewModel => {
    for (const event of events) applyEvent(event);
    return buildView();
  };

  const pushNdjsonChunk = (
    chunk: string | Uint8Array,
    options: { readonly final?: boolean } = {},
  ): DumpViewModel => {
    lineBuffer += typeof chunk === 'string' ? chunk : textDecoder.decode(chunk, { stream: options.final !== true });
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() ?? '';
    for (const line of lines) parseLine(line);
    if (options.final === true) {
      const trailing = `${lineBuffer}${textDecoder.decode()}`;
      lineBuffer = '';
      if (trailing.length > 0) parseLine(trailing);
    }
    return buildView();
  };

  return {
    pushEvents,
    pushNdjsonChunk,
    resolve,
    getStoredNode: id => nodes.get(id),
    view: buildView,
  };
};

export const diffStoredValues = (
  before: StoredValue | undefined,
  after: StoredValue | undefined,
  decoder: DumpDecoder,
): readonly StructuralDiffEntry[] => diffValues(before, after, decoder);

export const computeStageDiffs = (
  model: DumpViewModel,
  decoder: DumpDecoder,
  stageId: number,
): StageDiffs => {
  const stage = model.stages.get(stageId);
  if (stage === undefined) throw new Error(`Unknown stage ${stageId}`);
  const downward: StageDiff[] = [];
  const upward: StageDiff[] = [];
  for (const childStageId of stage.childStageIds) {
    const child = model.stages.get(childStageId);
    if (child === undefined) continue;
    downward.push({
      childStageId,
      childName: child.name,
      entries: diffStoredValues(stage.encodedFacts, child.encodedFacts, decoder),
    });
    if (child.encodedOutcome !== undefined) upward.push({
      childStageId,
      childName: child.name,
      entries: diffStoredValues(child.encodedOutcome, stage.encodedOutcome, decoder),
    });
  }
  return { downward: Object.freeze(downward), upward: Object.freeze(upward) };
};

export const decodeDumpView = (events: Iterable<EncodedDumpEvent>): {
  readonly decoder: DumpDecoder;
  readonly model: DumpViewModel;
} => {
  const decoder = createDumpDecoder();
  return { decoder, model: decoder.pushEvents(events) };
};
