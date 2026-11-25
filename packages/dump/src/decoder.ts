import { base64 } from '@scure/base';

import {
  DeferredReference,
  isDumpFacts,
  RawNumber,
  SecretDescription,
  StreamReference,
  type DumpArchive,
  type DumpDeferred,
  type DumpFacts,
  type DumpFrame,
  type DumpStage,
  type DumpStream,
  type DumpValue,
} from './archive.ts';
import { jsonNumber, numbers, type DumpLog } from './wire.ts';

type RecordValue = Record<string, unknown>;
type PendingStage = Omit<DumpStage, 'logs' | 'outcome'> & { logs: DumpLog<DumpValue>[]; outcome?: DumpStage['outcome'] };
type PendingStream = { frames: DumpFrame[]; outcome?: DumpStream['outcome'] };

const isRecord = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const id = (value: unknown): number => {
  if (typeof value !== 'number' || value < 1 || !Number.isSafeInteger(value)) throw new TypeError('Invalid dump ID');
  return value;
};

const found = <T>(entries: ReadonlyMap<number, T>, key: number, kind: string): T => {
  const entry = entries.get(key);
  if (entry === undefined) throw new TypeError(`Unknown dump ${kind} ${key}`);
  return entry;
};

const getOrInsert = <T>(entries: Map<number, T>, key: number, make: () => T): T => {
  const entry = entries.get(key);
  if (entry !== undefined) return entry;
  const next = make();
  entries.set(key, next);
  return next;
};

const secretDescription = (value: unknown): SecretDescription => {
  if (!isRecord(value) || typeof value.length !== 'number' || !Number.isSafeInteger(value.length) || value.length < 0
    || typeof value.redacted !== 'string' || typeof value.hash !== 'string') throw new TypeError('Invalid dump secret');
  return Object.freeze(new SecretDescription(value.length, value.redacted, value.hash));
};

const parseEvent = (line: string) => {
  const sources = new WeakMap<object, Map<string, string>>();
  const event: unknown = JSON.parse(line, function (this: unknown, key: string, value: unknown, context?: { source?: string }) {
    if (typeof value === 'number' && Array.isArray(this) && context?.source !== undefined) {
      let tokens = sources.get(this);
      if (tokens === undefined) {
        tokens = new Map();
        sources.set(this, tokens);
      }
      tokens.set(key, context.source);
    }
    return value;
  });
  if (!isRecord(event)) throw new TypeError('Expected a dump event');
  return { event, sources };
};

const createDecoder = () => {
  const objects = new Map<number, Exclude<DumpValue, undefined>>();
  const stages = new Map<number, PendingStage>();
  const streams = new Map<number, PendingStream>();
  const deferreds = new Map<number, DumpDeferred>();
  const streamReferences = new Map<number, StreamReference>();
  const deferredReferences = new Map<number, DeferredReference>();
  let rootStageId: number | undefined;

  const stream = (streamId: number): PendingStream => getOrInsert(streams, streamId, () => ({ frames: [] }));

  const decode = (value: unknown): DumpValue => {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return value;
    if (!isRecord(value)) throw new TypeError('Invalid dump value');
    const keys = Object.keys(value);
    if (keys.length !== 1) throw new TypeError('Invalid dump value marker');
    const key = keys[0];
    const marker = value[key];
    switch (key) {
    case '$':
      return found(objects, id(marker), 'object');
    case '$stream': {
      const streamId = id(marker);
      return getOrInsert(streamReferences, streamId, () => Object.freeze(new StreamReference(streamId)));
    }
    case '$deferred': {
      const deferredId = id(marker);
      return getOrInsert(deferredReferences, deferredId, () => Object.freeze(new DeferredReference(deferredId)));
    }
    case '$undefined':
      if (marker === true) return undefined;
      break;
    case '$number':
      if (typeof marker === 'string' && Object.hasOwn(numbers, marker)) return numbers[marker as keyof typeof numbers];
      break;
    }
    throw new TypeError(`Invalid dump value marker ${key}`);
  };

  const facts = (value: unknown): DumpFacts => {
    const decoded = decode(value);
    if (!isDumpFacts(decoded)) throw new TypeError('Invalid dump facts');
    return decoded;
  };

  const define = (event: RecordValue, sources: WeakMap<object, Map<string, string>>): void => {
    const fromObjectId = id(event.fromObjectId);
    const nodes: unknown = event.nodes;
    if (fromObjectId !== objects.size + 1 || !Array.isArray(nodes) || nodes.length === 0) {
      throw new TypeError('Noncontiguous dump object IDs');
    }
    const fill: Array<() => void> = [];
    const tokens = sources.get(nodes);
    // Reserve the entire batch before resolving its edges, including cycles and forward references.
    for (const [index, node] of (nodes as unknown[]).entries()) {
      const objectId = fromObjectId + index;
      if (Array.isArray(node)) {
        const array: DumpValue[] = [];
        objects.set(objectId, array);
        fill.push(() => {
          for (const item of node as unknown[]) array.push(decode(item));
          Object.freeze(array);
        });
      } else if (isRecord(node)) {
        const keys = Object.keys(node);
        if (keys.length === 1 && keys[0] === '$bytes' && typeof node.$bytes === 'string') {
          objects.set(objectId, base64.decode(node.$bytes));
        } else if (keys.length === 1 && keys[0] === '$secret') {
          objects.set(objectId, secretDescription(node.$secret));
        } else {
          const record: DumpFacts = {};
          objects.set(objectId, record);
          fill.push(() => {
            for (const [key, value] of Object.entries(node)) {
              if (key.startsWith('$') && !key.startsWith('$$')) throw new TypeError(`Unescaped dump object key ${key}`);
              Object.defineProperty(record, key.startsWith('$$') ? key.slice(1) : key, { value: decode(value), enumerable: true });
            }
            Object.freeze(record);
          });
        }
      } else if (typeof node === 'number') {
        const token = tokens?.get(String(index));
        if (token === undefined || !jsonNumber.test(token)) throw new TypeError('Invalid dump raw number');
        objects.set(objectId, Object.freeze(new RawNumber(token)));
      } else {
        throw new TypeError('Invalid dump object node');
      }
    }
    for (const resolve of fill) resolve();
  };

  const events = (line: string): void => {
    const { event, sources } = parseEvent(line);
    switch (event.type) {
    case 'object':
      define(event, sources);
      break;
    case 'stage.entered': {
      const stageId = id(event.stageId);
      const { name } = event;
      if (typeof name !== 'string' || stages.has(stageId)) throw new TypeError(`Invalid dump stage entry ${stageId}`);
      const parentStageId = Object.hasOwn(event, 'parentStageId') ? id(event.parentStageId) : undefined;
      if (parentStageId === undefined) {
        if (rootStageId !== undefined) throw new TypeError('Multiple root stages in one dump');
        rootStageId = stageId;
      } else {
        const parent = found(stages, parentStageId, 'stage');
        if (parent.outcome) throw new TypeError(`Dump stage entered after parent stage ${parentStageId} left`);
      }
      stages.set(stageId, {
        entry: { stageId, name, ...(parentStageId === undefined ? {} : { parentStageId }), facts: facts(event.facts) },
        logs: [],
      });
      break;
    }
    case 'stage.leaved': {
      const stageId = id(event.stageId);
      const stage = found(stages, stageId, 'stage');
      if (stage.outcome || Object.hasOwn(event, 'facts') === Object.hasOwn(event, 'error')) {
        throw new TypeError(`Invalid dump stage outcome ${stageId}`);
      }
      stage.outcome = Object.hasOwn(event, 'error') ? { error: decode(event.error) } : { facts: facts(event.facts) };
      break;
    }
    case 'stream.frame': {
      const streamId = id(event.streamId);
      const entry = stream(streamId);
      const item = decode(event.item);
      if (entry.outcome || !isDumpFacts(item)) throw new TypeError(`Invalid dump stream frame ${streamId}`);
      if (item.ok === true && Object.hasOwn(item, 'value') && !Object.hasOwn(item, 'error')) {
        entry.frames.push(item as Extract<DumpFrame, { ok: true }>);
      } else if (item.ok === false && Object.hasOwn(item, 'error') && !Object.hasOwn(item, 'value')) {
        entry.frames.push(item as Extract<DumpFrame, { ok: false }>);
      } else {
        throw new TypeError(`Invalid dump stream frame ${streamId}`);
      }
      break;
    }
    case 'stream.end': {
      const streamId = id(event.streamId);
      const entry = stream(streamId);
      if (entry.outcome) throw new TypeError(`Duplicate dump stream outcome ${streamId}`);
      entry.outcome = Object.hasOwn(event, 'error') ? { error: decode(event.error) } : {};
      break;
    }
    case 'deferred.settled': {
      const deferredId = id(event.deferredId);
      if (deferreds.has(deferredId) || Object.hasOwn(event, 'value') === Object.hasOwn(event, 'error')) {
        throw new TypeError(`Invalid dump deferred outcome ${deferredId}`);
      }
      deferreds.set(deferredId, { outcome: Object.hasOwn(event, 'error') ? { error: decode(event.error) } : { value: decode(event.value) } });
      break;
    }
    case 'log': {
      const stage = found(stages, id(event.stageId), 'stage');
      if (typeof event['@timestamp'] !== 'number' || typeof event['@localetime'] !== 'string' || typeof event.level !== 'string'
        || typeof event.context !== 'string' || typeof event.message !== 'string'
        || (Object.hasOwn(event, 'errored') && typeof event.errored !== 'boolean')) throw new TypeError('Invalid dump log');
      const { fields, error, ...log } = event as DumpLog<unknown>;
      stage.logs.push({ ...log, fields: decode(fields), ...(Object.hasOwn(event, 'error') && { error: decode(error) }) });
      break;
    }
    default:
      throw new TypeError(`Unknown dump event ${String(event.type)}`);
    }
  };

  const finish = (): DumpArchive => {
    if (rootStageId === undefined) throw new TypeError('Dump is missing its root stage');
    const completeStages = new Map<number, DumpStage>();
    for (const [stageId, stage] of stages) {
      if (stage.outcome === undefined) throw new TypeError(`Missing dump stage outcome ${stageId}`);
      completeStages.set(stageId, { ...stage, outcome: stage.outcome });
    }
    for (const streamId of streamReferences.keys()) found(streams, streamId, 'stream');
    const completeStreams = new Map<number, DumpStream>();
    for (const [streamId, entry] of streams) {
      if (entry.outcome === undefined) throw new TypeError(`Missing dump stream outcome ${streamId}`);
      completeStreams.set(streamId, { ...entry, outcome: entry.outcome });
    }
    for (const deferredId of deferredReferences.keys()) found(deferreds, deferredId, 'deferred');
    return { rootStageId, stages: completeStages, streams: completeStreams, deferreds };
  };

  return { events, finish };
};

export const decodeDump = async (body: ReadableStream<Uint8Array>): Promise<DumpArchive> => {
  const reader = body.getReader();
  const text = new TextDecoder('utf-8', { fatal: true });
  const decoder = createDecoder();
  let pending = '';
  let lineNumber = 0;
  const apply = (line: string): void => {
    lineNumber += 1;
    try {
      decoder.events(line);
    } catch (cause) {
      throw new TypeError(`Invalid dump event at line ${lineNumber}`, { cause });
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      let newline = pending.length;
      pending += text.decode(value, { stream: true });
      let start = 0;
      while ((newline = pending.indexOf('\n', newline)) !== -1) {
        apply(pending.slice(start, newline));
        start = ++newline;
      }
      pending = pending.slice(start);
    }
    pending += text.decode();
    if (pending.length > 0) apply(pending);
    return decoder.finish();
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch (cleanup) {
      if (cleanup !== error) throw new AggregateError([error, cleanup], 'Failed to decode and cancel dump body');
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
};
