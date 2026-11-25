import {
  DeferredReference,
  isDumpArray,
  isDumpFacts,
  RawNumber,
  SecretDescription,
  StreamReference,
  type DumpFacts,
  type DumpValue,
} from './archive.ts';

export interface FactDifference {
  readonly path: readonly (string | number)[];
  readonly before?: DumpValue;
  readonly after?: DumpValue;
}

const sameValue = (before: DumpValue, after: DumpValue): boolean => {
  if (Object.is(before, after)) return true;
  if (before instanceof Uint8Array && after instanceof Uint8Array) {
    return before.length === after.length && before.every((byte, index) => byte === after[index]);
  }
  if (before instanceof RawNumber && after instanceof RawNumber) return before.rawJSON === after.rawJSON;
  if (before instanceof StreamReference && after instanceof StreamReference) return before.streamId === after.streamId;
  if (before instanceof DeferredReference && after instanceof DeferredReference) return before.deferredId === after.deferredId;
  if (before instanceof SecretDescription && after instanceof SecretDescription) {
    return before.length === after.length && before.redacted === after.redacted && before.hash === after.hash;
  }
  return false;
};

export const diffRequestFacts = (parent: DumpFacts, child: DumpFacts): readonly FactDifference[] => {
  const changes: FactDifference[] = [];
  const path: (string | number)[] = [];
  const ancestors = new WeakMap<object, Set<object>>();

  const visit = (before: DumpValue, after: DumpValue): void => {
    if (sameValue(before, after)) return;
    if (isDumpFacts(before) && isDumpFacts(after)) {
      compareEntries(before, after, [...new Set([...Object.keys(before), ...Object.keys(after)])]);
    } else if (isDumpArray(before) && isDumpArray(after)) {
      compareEntries(before, after, Array.from({ length: Math.max(before.length, after.length) }, (_, index) => index));
    } else {
      changes.push({ path: [...path], before, after });
    }
  };

  const compareEntries = <K extends string | number>(before: Readonly<Record<K, DumpValue>>, after: Readonly<Record<K, DumpValue>>, keys: readonly K[]): void => {
    let pairs = ancestors.get(before);
    if (pairs === undefined) {
      pairs = new Set();
      ancestors.set(before, pairs);
    }
    if (pairs.has(after)) return;
    pairs.add(after);
    for (const key of keys) {
      path.push(key);
      if (!Object.hasOwn(before, key)) changes.push({ path: [...path], after: after[key] });
      else if (!Object.hasOwn(after, key)) changes.push({ path: [...path], before: before[key] });
      else visit(before[key], after[key]);
      path.pop();
    }
    pairs.delete(after);
  };

  visit(parent, child);
  return changes;
};
