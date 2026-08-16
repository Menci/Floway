// Shape guards for the untrusted JSON that credential import and the Codex
// backend's own metadata blobs arrive as. They are internal to this package —
// the distinction each one draws (throw vs. return null, empty string as
// absent) is the import contract, not a general-purpose utility.

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const requireObject = (value: unknown, where: string): Record<string, unknown> => {
  if (!isObject(value)) throw new TypeError(`${where} must be a JSON object`);
  return value;
};

// The shared plain-object + allowlist scaffold used by the state and config
// asserters: reject non-plain-objects first, then any key not in the set.
export const assertAllowedObjectKeys = (value: unknown, where: string, allowed: ReadonlySet<string>): Record<string, unknown> => {
  if (!isObject(value)) throw new TypeError(`${where} must be a plain object`);
  const obj = value;
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) throw new TypeError(`${where} has unexpected key '${key}'`);
  }
  return obj;
};

export const requireString = (value: unknown, where: string): string => {
  if (typeof value !== 'string' || value === '') throw new TypeError(`${where} must be a non-empty string`);
  return value;
};

// An empty string reads as absent rather than as an error: exporters routinely
// serialize an unset optional field as `""`, and an operator clearing a form
// field means the same thing as never filling it in.
export const optionalString = (value: unknown, where: string): string | null => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new TypeError(`${where} must be a string when present`);
  return value;
};

// Guards prototype-pollution keys on objects used as maps.
export const isUnsafeObjectKey = (key: string): boolean => key === '__proto__' || key === 'constructor' || key === 'prototype';
