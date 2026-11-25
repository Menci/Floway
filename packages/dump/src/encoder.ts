import { base64 } from '@scure/base';

import { jsonNumber, type DumpEvent, type EncodedValue, type ObjectNode, type ObjectReference, type RawJsonLiteral } from './wire.ts';
import { Secret, type run, type RunEvent } from '@floway-dev/pipeline';

export type Observer = NonNullable<Parameters<typeof run>[2]['events']>;
type IdOf = Parameters<Observer>[1];

const json = JSON as JSON & { isRawJSON?: (value: unknown) => value is RawJsonLiteral };

const encodeNode = (object: object, encode: (value: unknown) => EncodedValue): ObjectNode => {
  if (object instanceof Uint8Array) return { $bytes: base64.encode(object) };
  if (object instanceof Secret) return { $secret: object.describe() };
  if (json.isRawJSON?.(object)) {
    // A numeric object node carries the original JSON token through serialization and decoding.
    if (!jsonNumber.test(object.rawJSON)) throw new TypeError('Dump raw JSON requires a number token');
    return object;
  }

  if (Object.getOwnPropertySymbols(object).length > 0) throw new TypeError('Dump objects require string keys');
  const keys = Object.getOwnPropertyNames(object);
  if (Array.isArray(object)) {
    if (keys.length !== object.length + 1) throw new TypeError('Dump arrays require dense elements');
    const items: EncodedValue[] = [];
    for (let index = 0; index < object.length; index += 1) {
      if (!Object.hasOwn(object, index)) throw new TypeError('Dump arrays require dense elements');
      items.push(encode(object[index]));
    }
    return items;
  }

  if (object instanceof Error || object instanceof DOMException) {
    for (const key of ['name', 'message', 'stack', 'cause']) {
      if (!Object.hasOwn(object, key) && key in object) keys.push(key);
    }
  } else {
    const prototype: unknown = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Dump values require plain objects');
  }
  return Object.fromEntries(keys.map(key => [key.startsWith('$') ? `$${key}` : key, encode(Reflect.get(object, key))]));
};

const encodeEvent = (
  event: RunEvent,
  encode: (value: unknown) => EncodedValue,
  reference: (object: object) => ObjectReference,
): Exclude<DumpEvent, { type: 'object' }> => {
  switch (event.type) {
  case 'stage.entered':
    return { ...event, facts: reference(event.facts) };
  case 'stage.leaved':
    return 'error' in event ? { ...event, error: encode(event.error) } : { ...event, facts: reference(event.facts) };
  case 'stream.frame':
    return { ...event, item: reference(event.item) };
  case 'stream.end':
    return 'error' in event ? { ...event, error: encode(event.error) } : event;
  case 'deferred.settled':
    return 'error' in event ? { ...event, error: encode(event.error) } : { ...event, value: encode(event.value) };
  case 'log': {
    const { fields, error, ...log } = event;
    return { ...log, fields: encode(fields), ...('error' in event && { error: encode(error) }) };
  }
  }
};

export const createDumpEncoder = () => {
  const identities = new WeakMap<object, number>();
  const text = new TextEncoder();
  let nextObjectId = 1;
  let failure: { error: unknown } | undefined;

  return {
    encode(event: RunEvent, idOf: IdOf): Uint8Array<ArrayBuffer> {
      if (failure) throw failure.error;
      try {
        const fromObjectId = nextObjectId;
        const pending: object[] = [];
        const reference = (object: object): ObjectReference => {
          const existing = identities.get(object);
          if (existing !== undefined) return { $: existing };
          const id = nextObjectId++;
          identities.set(object, id);
          pending.push(object);
          return { $: id };
        };

        const encode = (value: unknown): EncodedValue => {
          if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
          if (value === undefined) return { $undefined: true };
          if (typeof value === 'number') {
            if (Object.is(value, -0)) return { $number: '-0' };
            if (Number.isNaN(value)) return { $number: 'NaN' };
            if (value === Infinity) return { $number: 'Infinity' };
            if (value === -Infinity) return { $number: '-Infinity' };
            return value;
          }
          const handle = idOf(value);
          if (handle) return 'streamId' in handle ? { $stream: handle.streamId } : { $deferred: handle.deferredId };
          if (typeof value === 'object') return reference(value);
          throw new TypeError(`Unsupported dump value ${typeof value}`);
        };

        const encoded = encodeEvent(event, encode, reference);
        const nodes: ObjectNode[] = [];
        for (const object of pending) nodes.push(encodeNode(object, encode));

        const lines = nodes.length ? [JSON.stringify({ type: 'object', fromObjectId, nodes } satisfies DumpEvent)] : [];
        lines.push(JSON.stringify(encoded));
        return text.encode(`${lines.join('\n')}\n`);
      } catch (error) {
        failure = { error };
        throw error;
      }
    },
  };
};
