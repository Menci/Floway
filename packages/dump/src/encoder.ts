import { base64 } from '@scure/base';

import type { DumpEvent, DumpResult, EncodedValue, ObjectNode, RawJsonLiteral } from './wire.ts';
import { isDeferred, isManagedStream, Secret } from '@floway-dev/pipeline';
import type { RunEvent } from '@floway-dev/pipeline';

const json = JSON as JSON & { isRawJSON?: (value: unknown) => value is RawJsonLiteral };

const encodeNode = (value: object, encode: (value: unknown) => EncodedValue): ObjectNode => {
  if (value instanceof Uint8Array) return { $bytes: base64.encode(value) };
  if (value instanceof Secret) return { $secret: value.describe() };
  if (json.isRawJSON?.(value)) return value;

  if (Object.getOwnPropertySymbols(value).length) throw new TypeError('Dump objects require string keys');
  if (Array.isArray(value)) {
    if (Object.getOwnPropertyNames(value).length !== value.length + 1) {
      throw new TypeError('Dump arrays require dense elements');
    }
    return Array.from({ length: value.length }, (_, index) => {
      if (!Object.hasOwn(value, index)) throw new TypeError('Dump arrays require dense elements');
      return encode(value[index]);
    });
  }

  const keys = new Set(Object.getOwnPropertyNames(value));
  if (value instanceof Error || value instanceof DOMException) {
    for (const key of ['name', 'message', 'stack', 'cause']) {
      if (key in value) keys.add(key);
    }
  } else {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Dump values require plain objects');
  }
  return Object.fromEntries([...keys].map(key => [key.startsWith('$') ? `$${key}` : key, encode(Reflect.get(value, key))]));
};

export const createDumpEncoder = () => {
  const objectIds = new WeakMap<object, number>();
  const streamIds = new WeakMap<object, number>();
  const deferredIds = new WeakMap<object, number>();
  const textEncoder = new TextEncoder();
  let nextObjectId = 1;
  let nextStreamId = 1;
  let nextDeferredId = 1;
  let failure: { readonly error: unknown } | undefined;

  const identifyStream = (stream: object): number => {
    const existing = streamIds.get(stream);
    if (existing !== undefined) return existing;
    const id = nextStreamId++;
    streamIds.set(stream, id);
    return id;
  };

  const identifyDeferred = (deferred: object): number => {
    const existing = deferredIds.get(deferred);
    if (existing !== undefined) return existing;
    const id = nextDeferredId++;
    deferredIds.set(deferred, id);
    return id;
  };

  return {
    encode(event: RunEvent): Uint8Array<ArrayBuffer> {
      if (failure) throw failure.error;
      try {
        const fromObjectId = nextObjectId;
        const pending: object[] = [];
        const encodeValue = (value: unknown): EncodedValue => {
          if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
          switch (typeof value) {
          case 'undefined': return { $undefined: true };
          case 'number': {
            if (Object.is(value, -0)) return { $number: '-0' };
            if (Number.isNaN(value)) return { $number: 'NaN' };
            if (value === Infinity) return { $number: 'Infinity' };
            if (value === -Infinity) return { $number: '-Infinity' };
            return value;
          }
          case 'object': {
            if (isManagedStream(value)) return { $stream: identifyStream(value) };
            if (isDeferred(value)) return { $deferred: identifyDeferred(value) };
            const existing = objectIds.get(value);
            if (existing !== undefined) return { $: existing };
            const id = nextObjectId++;
            objectIds.set(value, id);
            pending.push(value);
            return { $: id };
          }
          default: throw new TypeError(`Unsupported dump value ${typeof value}`);
          }
        };
        const encodeResult = (result: DumpResult<unknown>): DumpResult<EncodedValue> => result.ok
          ? { ok: true, value: encodeValue(result.value) }
          : { ok: false, error: encodeValue(result.error) };

        const encodeEvent = (): Exclude<DumpEvent, { type: 'object' }> => {
          switch (event.type) {
          case 'stage.entered':
          case 'stage.leaved':
            return { ...event, facts: encodeValue(event.facts) };
          case 'stage.panicked': {
            const { facts, error, ...stage } = event;
            return { ...stage, error: encodeValue(error), ...(facts !== undefined && { facts: encodeValue(facts) }) };
          }
          case 'stream.frame':
            return { type: event.type, streamId: identifyStream(event.stream), item: encodeResult(event.item) };
          case 'stream.end':
            return { type: event.type, streamId: identifyStream(event.stream) };
          case 'deferred.settled':
            return { type: event.type, deferredId: identifyDeferred(event.deferred), ...encodeResult(event) };
          case 'log': {
            const { fields, error, ...log } = event;
            return { ...log, fields: encodeValue(fields), ...(Object.hasOwn(event, 'error') && { error: encodeValue(error) }) };
          }
          }
        };

        const encoded = encodeEvent();
        const nodes: ObjectNode[] = [];
        for (const value of pending) nodes.push(encodeNode(value, encodeValue));
        const lines = nodes.length ? [JSON.stringify({ type: 'object', fromObjectId, nodes } satisfies DumpEvent)] : [];
        lines.push(JSON.stringify(encoded));
        return textEncoder.encode(`${lines.join('\n')}\n`);
      } catch (error) {
        failure = { error };
        throw error;
      }
    },
  };
};
