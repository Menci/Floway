import { isDumpDeferredRef, isDumpRawJson, isDumpSecret, isDumpStreamRef } from './decoder.ts';

type Path = readonly (string | number)[];
export type DumpDiff =
  | { readonly path: Path; readonly kind: 'added'; readonly after: unknown }
  | { readonly path: Path; readonly kind: 'removed'; readonly before: unknown }
  | { readonly path: Path; readonly kind: 'changed'; readonly before: unknown; readonly after: unknown };

const objectValue = (value: unknown): value is object => typeof value === 'object' && value !== null;

const atomic = (value: object): boolean =>
  value instanceof Uint8Array || isDumpStreamRef(value) || isDumpDeferredRef(value) || isDumpSecret(value) || isDumpRawJson(value);

const equal = (before: object, after: object): boolean => {
  if (before instanceof Uint8Array && after instanceof Uint8Array) {
    return before.length === after.length && before.every((byte, index) => byte === after[index]);
  }
  if (isDumpStreamRef(before) && isDumpStreamRef(after)) return before.$stream === after.$stream;
  if (isDumpDeferredRef(before) && isDumpDeferredRef(after)) return before.$deferred === after.$deferred;
  if (isDumpSecret(before) && isDumpSecret(after)) {
    return before.$secret.length === after.$secret.length && before.$secret.redacted === after.$secret.redacted && before.$secret.hash === after.$secret.hash;
  }
  return isDumpRawJson(before) && isDumpRawJson(after) && before.rawJSON === after.rawJSON;
};

export const diffFacts = (before: unknown, after: unknown): readonly DumpDiff[] => {
  const entries: DumpDiff[] = [];
  const ancestors = new WeakMap<object, WeakSet<object>>();

  const walk = (before: unknown, after: unknown, path: Path): void => {
    if (Object.is(before, after)) return;
    if (!objectValue(before) || !objectValue(after) || Array.isArray(before) !== Array.isArray(after) || atomic(before) || atomic(after)) {
      if (!objectValue(before) || !objectValue(after) || !equal(before, after)) entries.push({ path, kind: 'changed', before, after });
      return;
    }
    const paired = ancestors.get(before) ?? new WeakSet<object>();
    if (paired.has(after)) return;
    paired.add(after);
    ancestors.set(before, paired);
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const childPath = [...path, Array.isArray(before) ? Number(key) : key];
      const left: unknown = Reflect.get(before, key);
      const right: unknown = Reflect.get(after, key);
      if (!Object.hasOwn(before, key)) entries.push({ path: childPath, kind: 'added', after: right });
      else if (!Object.hasOwn(after, key)) entries.push({ path: childPath, kind: 'removed', before: left });
      else walk(left, right, childPath);
    }
    paired.delete(after);
  };

  walk(before, after, []);
  return entries;
};
