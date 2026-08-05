import type { ZodType } from 'zod';

interface StoredJsonMessages {
  malformed: string;
  invalid: string;
}

export const parseStoredJson = (raw: string, malformedMessage: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new Error(malformedMessage, { cause });
  }
};

export const decodeStoredJsonValue = <T>(value: unknown, schema: ZodType<T>, invalidMessage: string): T => {
  const result = schema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues
      .map(issue => `${issue.path.length === 0 ? '<root>' : issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`${invalidMessage}: ${details}`, { cause: result.error });
  }
  return result.data;
};

const isJsonObject = (value: unknown): value is object =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Set);

const restoreOwnJsonProperties = <T>(source: unknown, decoded: T): T => {
  if (source === decoded) return decoded;
  if (Array.isArray(source) && Array.isArray(decoded)) {
    for (let index = 0; index < source.length; index++) {
      decoded[index] = restoreOwnJsonProperties(source[index], decoded[index]);
    }
    return decoded;
  }
  if (!isJsonObject(source) || !isJsonObject(decoded)) return decoded;
  for (const [key, sourceValue] of Object.entries(source)) {
    const value = Object.hasOwn(decoded, key)
      ? restoreOwnJsonProperties(sourceValue, Reflect.get(decoded, key))
      : sourceValue;
    // Assignment treats `__proto__` as the legacy prototype setter. Defining
    // the property keeps JSON's own-key semantics for future passthrough data.
    Object.defineProperty(decoded, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value,
    });
  }
  return decoded;
};

export const decodeStoredJson = <T>(raw: string, schema: ZodType<T>, messages: StoredJsonMessages): T =>
  decodeStoredJsonValue(parseStoredJson(raw, messages.malformed), schema, messages.invalid);

export const decodeStoredJsonPreservingProperties = <T>(
  raw: string,
  schema: ZodType<T>,
  messages: StoredJsonMessages,
): T => {
  const parsed = parseStoredJson(raw, messages.malformed);
  return restoreOwnJsonProperties(parsed, decodeStoredJsonValue(parsed, schema, messages.invalid));
};

export const preserveDecodedStoredJsonProperties = <T>(source: unknown, decoded: T): T =>
  restoreOwnJsonProperties(source, decoded);
