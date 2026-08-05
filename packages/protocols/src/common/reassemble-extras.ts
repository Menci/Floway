// Field-fidelity primitive shared by every reassembler that turns an upstream
// SSE stream into a single non-streaming result. Reassemblers reach for typed
// accumulators on the fields they understand (string concat, array merge by
// index, etc.); this helper covers everything else, so a future upstream
// extension survives without a code change.
//
// The accumulation rules are deliberately simple:
//
// - String + string: concatenate. Streaming text fields a future upstream
//   adds (a sibling of `content` / `reasoning_text` etc.) accumulate
//   automatically.
// - Array of objects with numeric `index` + same shape: merge by index,
//   recursing into string fields. Mirrors `tool_calls`' streaming wire shape
//   so an unknown vendor extension that copies it survives.
// - Plain object + plain object: shallow merge. Last write wins per key.
// - Anything else: last non-null value wins.
//
// Caller contract: the string-concat default assumes any unknown string field
// is a streaming text delta. Stable scalar string fields — the kind an
// upstream repeats unchanged on every chunk (e.g. OpenAI's
// `system_fingerprint`, `service_tier`) — MUST be registered as known keys
// by the caller, otherwise this helper concatenates the same value N times.

const isPlainArray = (value: unknown): value is unknown[] => Array.isArray(value);
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const ownValue = (object: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(object, key) ? object[key] : undefined;

const setOwnValue = (object: Record<string, unknown>, key: string, value: unknown): void => {
  Object.defineProperty(object, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
};

const cloneExtra = <T>(value: T): T => structuredClone(value);

const mergeIndexedObjects = (
  existing: readonly Record<string, unknown>[],
  incoming: readonly Record<string, unknown>[],
): Record<string, unknown>[] => {
  const merged = existing.map(entry => cloneExtra(entry));
  const positionByIndex = new Map<number, number>();
  for (let position = 0; position < merged.length; position++) {
    const index = merged[position]!.index;
    if (typeof index === 'number' && Number.isFinite(index)) positionByIndex.set(index, position);
  }

  for (const source of incoming) {
    const index = source.index;
    const position = typeof index === 'number' && Number.isFinite(index)
      ? positionByIndex.get(index)
      : undefined;
    if (position === undefined) {
      const appended = cloneExtra(source);
      merged.push(appended);
      if (typeof index === 'number' && Number.isFinite(index)) positionByIndex.set(index, merged.length - 1);
      continue;
    }

    const target = merged[position]!;
    for (const [key, value] of Object.entries(source)) {
      if (key === 'index' || value === undefined || value === null) continue;
      const current = ownValue(target, key);
      if (typeof current === 'string' && typeof value === 'string') {
        setOwnValue(target, key, current + value);
      } else if (isPlainObject(current) && isPlainObject(value)) {
        setOwnValue(target, key, { ...current, ...cloneExtra(value) });
      } else {
        setOwnValue(target, key, cloneExtra(value));
      }
    }
  }
  return merged;
};

const accumulate = (acc: Record<string, unknown>, key: string, value: unknown): void => {
  if (value === undefined || value === null) return;
  const existing = ownValue(acc, key);

  if (typeof existing === 'string' && typeof value === 'string') {
    setOwnValue(acc, key, existing + value);
    return;
  }

  if (isPlainArray(existing) && isPlainArray(value) && existing.every(isPlainObject) && value.every(isPlainObject)) {
    setOwnValue(acc, key, mergeIndexedObjects(existing as Record<string, unknown>[], value as Record<string, unknown>[]));
    return;
  }

  if (isPlainObject(existing) && isPlainObject(value)) {
    setOwnValue(acc, key, { ...existing, ...cloneExtra(value) });
    return;
  }

  setOwnValue(acc, key, cloneExtra(value));
};

export const captureExtras = (source: Record<string, unknown>, knownKeys: ReadonlySet<string>, into: Record<string, unknown>): void => {
  for (const [key, value] of Object.entries(source)) {
    if (knownKeys.has(key)) continue;
    accumulate(into, key, value);
  }
};
