// Single-string function-tool schema used to bridge OpenAI Responses Freeform
// `custom` tools onto translated targets that only accept JSON-schema function
// tools. The translator preserves user-provided grammar `format.definition`
// as a Lark-grammar hint in the `input` parameter's description so downstream
// models still see what shape the freeform value should follow. Models that
// don't recognize the grammar silently ignore it.
export const buildCustomToolInputSchema = (format?: Record<string, unknown>): Record<string, unknown> & { type: 'object' } => {
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
