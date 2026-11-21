import { base64 } from '@scure/base';

import { SecretLeakError } from './errors.ts';
import { SECRET_BRAND, SECRET_RENDERED, STREAM_BRAND } from './types.ts';
import type {
  EncodedDumpEvent,
  ManagedStream,
  RawRunEvent,
  Secret,
  StoredValue,
} from './types.ts';

const MAX_SHARED_VALUE_LENGTH = 524_288;

type StoredRecord = Record<string, StoredValue>;

const rawJSON = JSON as typeof JSON & {
  readonly isRawJSON?: (value: unknown) => boolean;
  readonly rawJSON?: (value: string) => unknown;
};

const isTestEnvironment = (): boolean =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.NODE_ENV === 'test';

const propertyPath = (path: string, key: string): string =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;

const defineRecordValue = (record: StoredRecord, key: string, value: StoredValue): void => {
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
};

export const encodeKey = (key: string): string => (key.startsWith('$') ? `$${key}` : key);

export const decodeKey = (key: string): string => (key.startsWith('$$') ? key.slice(1) : key);

export interface DumpEncoderOptions {
  readonly shareStringsFrom?: number;
  readonly maxSharedValues?: number;
  readonly detectRawSecretLeaks?: boolean;
}

export interface DumpEncoder {
  readonly registerSecretPlaintext: (plaintext: string) => void;
  readonly encodeBatch: (rawEvents: readonly RawRunEvent[]) => EncodedDumpEvent[];
}

/**
 * Encodes live run events into the object-space format consumed by the dump
 * decoder. Definitions for newly encountered values are emitted before the
 * event that first references them.
 */
export const createDumpEncoder = (options: DumpEncoderOptions = {}): DumpEncoder => {
  const shareStringsFrom = options.shareStringsFrom ?? 1_024;
  const maxSharedValues = options.maxSharedValues ?? 256;
  const detectRawSecretLeaks = options.detectRawSecretLeaks ?? isTestEnvironment();

  if (!Number.isInteger(shareStringsFrom) || shareStringsFrom < 0)
    throw new RangeError('shareStringsFrom must be a non-negative integer');
  if (!Number.isInteger(maxSharedValues) || maxSharedValues < 0)
    throw new RangeError('maxSharedValues must be a non-negative integer');

  const objectIds = new WeakMap<object, number>();
  const sharedValues = new Map<string, number>();
  const knownSecretPlaintexts = new Set<string>();
  let nextObjectId = 0;
  let pendingFrom = 0;
  let pendingNodes: StoredValue[] = [];

  const rememberShared = (key: string, id: number): void => {
    if (maxSharedValues === 0) return;
    sharedValues.delete(key);
    sharedValues.set(key, id);
    while (sharedValues.size > maxSharedValues) {
      const oldest = sharedValues.keys().next().value;
      if (oldest === undefined) break;
      sharedValues.delete(oldest);
    }
  };

  const findShared = (key: string): number | undefined => {
    const id = sharedValues.get(key);
    if (id === undefined) return undefined;
    sharedValues.delete(key);
    sharedValues.set(key, id);
    return id;
  };

  const assertNoLeak = (value: string, path: string): void => {
    if (!detectRawSecretLeaks) return;
    for (const plaintext of knownSecretPlaintexts) {
      if (value.includes(plaintext)) throw new SecretLeakError(path);
    }
  };

  const registerSecretPlaintext = (plaintext: string): void => {
    if (detectRawSecretLeaks && plaintext.length >= 6) knownSecretPlaintexts.add(plaintext);
  };

  const flushNodes = (events: EncodedDumpEvent[]): void => {
    if (pendingNodes.length === 0) return;
    events.push({ k: 'obj', from: pendingFrom, nodes: pendingNodes });
    pendingNodes = [];
    pendingFrom = nextObjectId;
  };

  const encodeValue = (value: unknown, path: string): StoredValue => {
    if (value === undefined) return { $undefined: true };
    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      if (typeof value === 'number' && Object.is(value, -0)) return { $number: '-0' };
      if (typeof value === 'number' && !Number.isFinite(value))
        return { $number: Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity' };
      return value;
    }
    if (typeof value === 'bigint') return { $bigint: value.toString() };
    if (typeof value === 'string') {
      assertNoLeak(value, path);
      if (value.length < shareStringsFrom || value.length > MAX_SHARED_VALUE_LENGTH) return value;
      const sharedKey = `s:${value}`;
      const sharedId = findShared(sharedKey);
      if (sharedId !== undefined) return { $: sharedId };
      const id = nextObjectId++;
      pendingNodes.push(value);
      rememberShared(sharedKey, id);
      return { $: id };
    }
    if (typeof value !== 'object') throw new TypeError(`Unsupported dump value at ${path}: ${typeof value}`);

    const existingId = objectIds.get(value);
    if (existingId !== undefined) return { $: existingId };

    if (SECRET_BRAND in value) {
      const secret = value as Secret<unknown>;
      if (detectRawSecretLeaks) registerSecretPlaintext(secret[SECRET_RENDERED]);
      const id = nextObjectId++;
      objectIds.set(value, id);
      pendingNodes.push({
        $secret: {
          length: secret.length,
          hash: secret.hash,
          redacted: '*'.repeat(Math.min(secret.length, 64)),
        },
      });
      return { $: id };
    }

    if (STREAM_BRAND in value) {
      const streamId = (value as ManagedStream<unknown>).streamId;
      return { $stream: streamId };
    }

    if (rawJSON.isRawJSON?.(value) === true) {
      const raw = (value as { readonly rawJSON: string }).rawJSON;
      assertNoLeak(raw, path);
      return { $rawJson: raw };
    }

    if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      const encoded = base64.encode(bytes);
      const sharedKey = `b:${encoded}`;
      if (encoded.length <= MAX_SHARED_VALUE_LENGTH) {
        const sharedId = findShared(sharedKey);
        if (sharedId !== undefined) {
          objectIds.set(value, sharedId);
          return { $: sharedId };
        }
      }
      const id = nextObjectId++;
      objectIds.set(value, id);
      pendingNodes.push({ $bytes: encoded });
      if (encoded.length <= MAX_SHARED_VALUE_LENGTH) rememberShared(sharedKey, id);
      return { $: id };
    }

    if (value instanceof Error) {
      const id = nextObjectId++;
      objectIds.set(value, id);
      pendingNodes.push({ $undefined: true });
      const fields: StoredRecord = {};
      defineRecordValue(fields, 'name', encodeValue(value.name, `${path}.name`));
      defineRecordValue(fields, 'message', encodeValue(value.message, `${path}.message`));
      defineRecordValue(fields, 'stack', encodeValue(value.stack, `${path}.stack`));
      if ('cause' in value) defineRecordValue(fields, 'cause', encodeValue(value.cause, `${path}.cause`));
      if (value instanceof AggregateError)
        defineRecordValue(fields, 'errors', encodeValue(value.errors, `${path}.errors`));
      for (const key of Object.keys(value)) {
        assertNoLeak(key, propertyPath(path, key));
        defineRecordValue(fields, encodeKey(key), encodeValue((value as unknown as Record<string, unknown>)[key], propertyPath(path, key)));
      }
      pendingNodes[id - pendingFrom] = { $error: fields };
      return { $: id };
    }

    const id = nextObjectId++;
    objectIds.set(value, id);
    pendingNodes.push({ $undefined: true });
    if (Array.isArray(value)) {
      const items: StoredValue[] = [];
      for (let index = 0; index < value.length; index++)
        items.push(encodeValue(value[index], `${path}[${index}]`));
      pendingNodes[id - pendingFrom] = items;
    } else {
      const record: StoredRecord = {};
      for (const key of Object.keys(value)) {
        assertNoLeak(key, propertyPath(path, key));
        defineRecordValue(
          record,
          encodeKey(key),
          encodeValue((value as Record<string, unknown>)[key], propertyPath(path, key)),
        );
      }
      pendingNodes[id - pendingFrom] = record;
    }
    return { $: id };
  };

  const encodeRawEvent = (event: RawRunEvent, events: EncodedDumpEvent[]): void => {
    switch (event.k) {
    case 'run': {
      const meta = event.meta === undefined ? undefined : encodeValue(event.meta, '$.meta');
      flushNodes(events);
      events.push({
        k: 'run',
        seq: event.seq,
        tMs: event.tMs,
        runId: event.runId,
        pipelineName: event.pipelineName,
        startedAt: event.startedAt,
        ...(meta === undefined ? {} : { meta }),
      });
      return;
    }
    case 'enter': {
      const facts = encodeValue(event.facts, '$.facts');
      flushNodes(events);
      events.push({
        k: 'enter',
        seq: event.seq,
        tMs: event.tMs,
        stageId: event.stageId,
        parentStageId: event.parentStageId,
        edgeKind: event.edgeKind,
        name: event.name,
        ...(event.tap === undefined ? {} : { tap: event.tap }),
        facts,
      });
      return;
    }
    case 'leave': {
      const outcome = encodeValue(event.outcome, '$.outcome');
      flushNodes(events);
      events.push({ k: 'leave', seq: event.seq, tMs: event.tMs, stageId: event.stageId, outcome });
      return;
    }
    case 'fail': {
      const error = encodeValue(event.error, '$.error');
      flushNodes(events);
      events.push({ k: 'fail', seq: event.seq, tMs: event.tMs, stageId: event.stageId, error });
      return;
    }
    case 'log': {
      const fields = event.fields === undefined ? undefined : encodeValue(event.fields, '$.fields');
      flushNodes(events);
      events.push({
        k: 'log',
        seq: event.seq,
        tMs: event.tMs,
        stageId: event.stageId,
        level: event.level,
        message: event.message,
        ...(fields === undefined ? {} : { fields }),
      });
      return;
    }
    case 'stream':
      events.push({
        k: 'stream',
        seq: event.seq,
        tMs: event.tMs,
        streamId: event.streamId,
        createdByStageId: event.createdByStageId,
        ...(event.wraps === undefined ? {} : { wraps: event.wraps }),
        ...(event.label === undefined ? {} : { label: event.label }),
      });
      return;
    case 'end': {
      const error = event.error === undefined ? undefined : encodeValue(event.error, '$.error');
      flushNodes(events);
      events.push({
        k: 'end',
        seq: event.seq,
        tMs: event.tMs,
        streamId: event.streamId,
        how: event.how,
        ...(error === undefined ? {} : { error }),
      });
      return;
    }
    case 'done': {
      const summary = event.summary === undefined ? undefined : encodeValue(event.summary, '$.summary');
      const error = event.error === undefined ? undefined : encodeValue(event.error, '$.error');
      flushNodes(events);
      events.push({
        k: 'done',
        seq: event.seq,
        tMs: event.tMs,
        ok: event.ok,
        ...(summary === undefined ? {} : { summary }),
        ...(error === undefined ? {} : { error }),
      });
      return;
    }
    }
  };

  const encodeBatch = (rawEvents: readonly RawRunEvent[]): EncodedDumpEvent[] => {
    const events: EncodedDumpEvent[] = [];
    for (let index = 0; index < rawEvents.length; index++) {
      const event = rawEvents[index]!;
      if (event.k !== 'frame') {
        encodeRawEvent(event, events);
        continue;
      }

      const frames: Array<{ readonly seq: number; readonly tMs: number; readonly v: StoredValue }> = [];
      const streamId = event.streamId;
      while (index < rawEvents.length) {
        const candidate = rawEvents[index]!;
        if (candidate.k !== 'frame' || candidate.streamId !== streamId) break;
        frames.push({
          seq: candidate.seq,
          tMs: candidate.tMs,
          v: encodeValue(candidate.value, `$.streams[${streamId}].frames[${frames.length}]`),
        });
        index++;
      }
      index--;
      flushNodes(events);
      events.push({ k: 'frames', streamId, frames });
    }
    return events;
  };

  return { registerSecretPlaintext, encodeBatch };
};
