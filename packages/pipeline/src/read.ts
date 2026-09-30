import { decodeKey } from './dump.ts';
import type { DumpEvent, Stored } from './dump.ts';

export interface ReadEvent {
  readonly facts?: Record<string, unknown>;
  readonly frames?: readonly unknown[];
  readonly deferred?: unknown;
  readonly outcome?: PromiseSettledResult<unknown>;
  readonly error?: unknown;
}

export interface RunReader {
  (event: DumpEvent): ReadEvent | null;
  node(id: number): Stored;
  decode(value: Stored): unknown;
  settlement(id: number): PromiseSettledResult<unknown> | undefined;
}

/** One object space for both decoded values and identity-based inspection of stored nodes.
 * Bytes and platform handles remain descriptions: decoding never acquires a resource. */
export const createRunReader = (): RunReader => {
  const nodes = new Map<number, Stored>();
  const decoded = new Map<number, unknown>();
  const settlements = new Map<number, PromiseSettledResult<unknown>>();

  const node = (id: number): Stored => {
    const stored = nodes.get(id);
    if (stored === undefined) throw new Error(`Dump reference $${id} points at a node no event carried`);
    return stored;
  };

  const fields = (values: Readonly<Record<string, Stored>>, target: Record<string, unknown>): Record<string, unknown> => {
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(target, decodeKey(key), { value: decode(value), enumerable: true, writable: true, configurable: true });
    }
    return target;
  };

  const decode = (stored: Stored, id?: number): unknown => {
    const remember = (value: unknown): unknown => {
      if (id !== undefined) decoded.set(id, value);
      return value;
    };
    if (stored === null || typeof stored !== 'object') return remember(stored);
    if (Array.isArray(stored)) {
      const value: unknown[] = [];
      remember(value);
      for (const child of stored) value.push(decode(child));
      return value;
    }
    if ('$' in stored) {
      const ref = stored.$ as number;
      return decoded.has(ref) ? decoded.get(ref) : decode(node(ref), ref);
    }
    if ('$stream' in stored) return remember({ stream: stored.$stream });
    if ('$readableStream' in stored) return remember({ readableStream: true });
    if ('$deferred' in stored) return remember({ deferred: true });
    if ('$secret' in stored) return remember(stored.$secret);
    if ('$bytes' in stored) return remember({ bytes: stored.$bytes });
    if ('$undefined' in stored) return remember(undefined);
    if ('$number' in stored) return remember(stored.$number === 'NaN' ? NaN : stored.$number === 'Infinity' ? Infinity : -Infinity);
    if ('$bigint' in stored) return remember(BigInt(stored.$bigint as string));
    const value: Record<string, unknown> = {};
    // Cache the container before its children: Error causes, collection members and
    // ordinary facts can all refer back to the very node currently being decoded.
    remember(value);
    if ('$error' in stored) value['error'] = fields(stored.$error as Record<string, Stored>, {});
    else if ('$map' in stored) value['map'] = decode(stored.$map as Stored);
    else if ('$set' in stored) value['set'] = decode(stored.$set as Stored);
    else if ('$date' in stored) value['date'] = decode(stored.$date as Stored);
    else fields(stored, value);
    return value;
  };

  const read = (event: DumpEvent): ReadEvent | null => {
    if (event.type === 'object') {
      event.nodes.forEach((stored, index) => { nodes.set(event.fromObjectId + index, stored); });
      return null;
    }
    if (event.type === 'stream.frame') return { frames: event.frames.map(value => decode(value)) };
    if (event.type === 'stage.failed') return { error: decode(event.error) };
    if (event.type === 'stage.entered' || event.type === 'stage.leaved') {
      return event.facts === undefined ? {} : { facts: fields(event.facts, {}) };
    }
    if (event.type === 'deferred.settled') {
      const outcome = decode(event.outcome) as PromiseSettledResult<unknown>;
      settlements.set((event.deferred as { readonly $: number }).$, outcome);
      return { deferred: decode(event.deferred), outcome };
    }
    return {};
  };

  return Object.assign(read, { node, decode: (value: Stored) => decode(value), settlement: (id: number) => settlements.get(id) });
};
