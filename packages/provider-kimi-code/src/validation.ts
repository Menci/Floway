export const object = (value: unknown, path: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  return value as Record<string, unknown>;
};

export const string = (value: unknown, path: string, allowEmpty = false): string => {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) throw new TypeError(`${path} must be a ${allowEmpty ? 'string' : 'nonempty string'}`);
  return value;
};

export const number = (value: unknown, path: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${path} must be a finite number`);
  return value;
};
