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

const accumulate = (acc: Record<string, unknown>, key: string, value: unknown): void => {
  if (value === undefined || value === null) return;
  const existing = acc[key];

  if (typeof existing === 'string' && typeof value === 'string') {
    acc[key] = existing + value;
    return;
  }

  if (isPlainArray(existing) && isPlainArray(value) && existing.every(isPlainObject) && value.every(isPlainObject)) {
    const merged = [...existing] as Record<string, unknown>[];
    for (const incoming of value as Record<string, unknown>[]) {
      const idx = typeof incoming.index === 'number' ? incoming.index : -1;
      if (idx >= 0 && isPlainObject(merged[idx])) {
        const into = merged[idx];
        for (const [k, v] of Object.entries(incoming)) {
          if (k === 'index') continue;
          if (typeof into[k] === 'string' && typeof v === 'string') into[k] = into[k] + v;
          else if (isPlainObject(into[k]) && isPlainObject(v)) into[k] = { ...into[k], ...v };
          else if (v !== undefined && v !== null) into[k] = v;
        }
      } else if (idx >= 0) {
        merged[idx] = incoming;
      } else {
        merged.push(incoming);
      }
    }
    acc[key] = merged;
    return;
  }

  if (isPlainObject(existing) && isPlainObject(value)) {
    acc[key] = { ...existing, ...value };
    return;
  }

  acc[key] = value;
};

export const captureExtras = (source: Record<string, unknown>, knownKeys: ReadonlySet<string>, into: Record<string, unknown>): void => {
  for (const [key, value] of Object.entries(source)) {
    if (knownKeys.has(key)) continue;
    accumulate(into, key, value);
  }
};
