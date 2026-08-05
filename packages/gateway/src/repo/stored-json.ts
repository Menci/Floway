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
  if (!result.success) {
    const details = result.error.issues
      .map(issue => `${issue.path.length === 0 ? '<root>' : issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`${messages.invalid}: ${details}`, { cause: result.error });
  }
  return result.data;
};
