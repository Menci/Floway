// Single-string function-tool schema used to bridge OpenAI Responses Freeform
// `custom` tools onto translated targets that only accept JSON-schema function
// tools. The translator preserves user-provided grammar `format.definition`
// as a Lark-grammar hint in the `input` parameter's description so downstream
// models still see what shape the freeform value should follow. Models that
// don't recognize the grammar silently ignore it.
export const buildCustomToolInputSchema = (format?: Record<string, unknown>): Record<string, unknown> => {
  const definition = typeof format?.definition === 'string' ? format.definition : undefined;
  return {
    type: 'object',
    additionalProperties: false,
    required: ['input'],
    properties: {
      input: {
        type: 'string',
        ...(definition && definition.length > 0 ? { description: `Lark grammar: ${definition}` } : {}),
      },
    },
  };
};

// Recover the freeform input from a wrapped function-tool argument blob. The
// wrap shape is `{ "input": "..." }`; on parse failure (truncated stream,
// model misformatted JSON) fall back to the raw blob so the caller still sees
// something useful instead of an empty input.
export const unwrapCustomToolInput = (wrappedArguments: string): string => {
  if (wrappedArguments.length === 0) return '';
  try {
    const parsed = JSON.parse(wrappedArguments) as { input?: unknown };
    return typeof parsed.input === 'string' ? parsed.input : wrappedArguments;
  } catch {
    return wrappedArguments;
  }
};
