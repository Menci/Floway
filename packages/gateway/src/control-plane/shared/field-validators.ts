export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export type FieldErrorBuilder = (field: string, expected: string) => Error;

const stringField = (value: unknown, field: string, err: FieldErrorBuilder): string => {
  if (typeof value !== 'string') throw err(field, 'a string');
  return value;
};

export const nonEmptyStringField = (value: unknown, field: string, err: FieldErrorBuilder): string => {
  const str = stringField(value, field, err).trim();
  if (str === '') throw err(field, 'a non-empty string');
  return str;
};
