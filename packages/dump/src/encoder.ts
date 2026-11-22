import { base64 } from '@scure/base';

import type { EncodedDumpEvent, StoredFrame, StoredRunEvent, StoredValue } from './types.ts';
import {
  Bytes,
  deferredIdOf,
  isDeferred,
  isManagedStream,
  isRawJson,
  isSecret,
  storedSecret,
  streamIdOf,
} from '@floway-dev/pipeline';
import type { RunEvent } from '@floway-dev/pipeline';
import { viewOf } from '@floway-dev/pipeline/bytes-view';

export interface DumpEncoderOptions {
  readonly shareStringsFrom?: number;
  readonly detectRawSecretLeaks?: boolean;
}

export const createDumpEncoder = ({
  shareStringsFrom = 1_024,
  detectRawSecretLeaks = false,
}: DumpEncoderOptions = {}) => {
  const objectIds = new WeakMap<object, number>();
  const stringIds = new Map<string, number>();
  const knownSecrets = new Set<string>();
  let nextId = 1;
  let nodes: StoredValue[] = [];

  const registerSecretPlaintext = (value: string): void => {
    if (detectRawSecretLeaks && value.length >= 6) knownSecrets.add(value);
  };

  const checkText = (value: string): string => {
    for (const secret of knownSecrets) {
      if (value.includes(secret)) throw new Error('Registered secret plaintext reached the dump');
    }
    return value;
  };

  const encodeValue = (value: unknown): StoredValue => {
    if (value === null || typeof value === 'boolean') return value;
    switch (typeof value) {
    case 'undefined': return { $undefined: true };
    case 'number':
      if (Object.is(value, -0)) return { $number: '-0' };
      if (Number.isNaN(value)) return { $number: 'NaN' };
      if (value === Infinity) return { $number: 'Infinity' };
      if (value === -Infinity) return { $number: '-Infinity' };
      return value;
    case 'bigint': return { $bigint: value.toString() };
    case 'string': {
      if (detectRawSecretLeaks) checkText(value);
      if (value.length < shareStringsFrom) return value;
      const earlier = stringIds.get(value);
      if (earlier !== undefined) return { $: earlier };
      const id = nextId++;
      stringIds.set(value, id);
      nodes.push(value);
      return { $: id };
    }
    case 'object': {
      if (isManagedStream(value)) return { $stream: streamIdOf(value) };
      if (isDeferred(value)) return { $deferred: deferredIdOf(value) };
      const earlier = objectIds.get(value);
      if (earlier !== undefined) return { $: earlier };

      const id = nextId++;
      objectIds.set(value, id);
      const index = nodes.length;
      nodes.push(null);
      if (value instanceof Bytes) nodes[index] = { $bytes: base64.encode(viewOf(value)) };
      else if (isSecret(value)) nodes[index] = { $secret: { ...storedSecret(value) } };
      else if (isRawJson(value)) nodes[index] = {
        $rawJson: detectRawSecretLeaks ? checkText(value.rawJSON) : value.rawJSON,
      };
      else if (Array.isArray(value)) nodes[index] = Array.from(value, encodeValue);
      else {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null)
          throw new TypeError('Expected a plain object in dump event data');
        const record: Record<string, StoredValue> = Object.create(null);
        for (const [key, child] of Object.entries(value)) {
          if (detectRawSecretLeaks) checkText(key);
          record[key.startsWith('$') ? `$${key}` : key] = encodeValue(child);
        }
        nodes[index] = record;
      }
      return { $: id };
    }
    default: throw new TypeError(`Unsupported dump value ${typeof value}`);
    }
  };

  const encodeEvent = (event: Exclude<RunEvent, { k: 'frame' }>): StoredRunEvent => {
    switch (event.k) {
    case 'enter':
    case 'leave':
      return { ...event, facts: encodeValue(event.facts) };
    case 'fail':
      return { ...event, error: encodeValue(event.error), facts: encodeValue(event.facts) };
    case 'closed':
    case 'end':
    case 'done': {
      const { error, ...rest } = event;
      return error === undefined ? rest : { ...rest, error: encodeValue(error) };
    }
    case 'log': {
      const { fields, ...rest } = event;
      if (detectRawSecretLeaks) checkText(event.message);
      return fields === undefined ? rest : { ...rest, fields: encodeValue(fields) };
    }
    case 'settled':
      return event.ok
        ? { ...event, value: encodeValue(event.value) }
        : { ...event, error: encodeValue(event.error) };
    default:
      return event;
    }
  };

  function* encodeGroups(events: readonly RunEvent[]): Generator<readonly EncodedDumpEvent[]> {
    for (let index = 0; index < events.length;) {
      const from = nextId;
      const event = events[index++]!;
      let encoded: EncodedDumpEvent;
      if (event.k === 'frame') {
        const { streamId } = event;
        const frames: StoredFrame[] = [{ seq: event.seq, tMs: event.tMs, v: encodeValue(event.value) }];
        while (index < events.length) {
          const next = events[index]!;
          if (next.k !== 'frame' || next.streamId !== streamId) break;
          frames.push({ seq: next.seq, tMs: next.tMs, v: encodeValue(next.value) });
          index++;
        }
        encoded = { k: 'frames', streamId, frames };
      } else {
        encoded = encodeEvent(event);
      }

      const definitions = nodes;
      nodes = [];
      yield definitions.length === 0 ? [encoded] : [{ k: 'obj', from, nodes: definitions }, encoded];
    }
  }

  const encodeBatch = (events: readonly RunEvent[]): EncodedDumpEvent[] => [...encodeGroups(events)].flat();

  return { encodeBatch, encodeGroups, registerSecretPlaintext };
};
