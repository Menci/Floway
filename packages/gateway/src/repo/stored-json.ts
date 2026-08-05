import type { ZodType } from 'zod';

export const decodeStoredJson = <T>(
  raw: string,
  schema: ZodType<T>,
  messages: { malformed: string; invalid: string },
): T => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(messages.malformed, { cause });
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new Error(messages.invalid, { cause: result.error });
  return result.data;
};
