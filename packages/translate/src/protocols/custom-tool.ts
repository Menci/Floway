import type { IRInputCustomToolFormat } from '../ir/input/types.ts';
// Translation paths wrap Responses `custom` tools as single-string JSON-schema
// function tools. Their grammar definition becomes a syntax-labeled prompt hint;
// downstream enforcement remains provider-dependent.
// https://github.com/openai/openai-node/blob/7423ac3e9351c46300cd094479cded5551a72eb4/src/resources/responses/responses.ts
export const buildCustomToolInputSchema = (format?: IRInputCustomToolFormat): Record<string, unknown> & { type: 'object' } => {
  const definition = format?.type === 'grammar' ? format.definition : undefined;
  const sourceSyntax = format?.type === 'grammar' && format.syntax !== '' ? format.syntax : undefined;
  const syntax = sourceSyntax === 'lark' ? 'Lark grammar' : sourceSyntax === 'regex' ? 'Regex' : sourceSyntax === undefined ? 'Grammar' : `Grammar (${sourceSyntax})`;
  return {
    type: 'object',
    additionalProperties: false,
    required: ['input'],
    properties: {
      input: {
        type: 'string',
        ...(definition && definition.length > 0 ? { description: `${syntax}: ${definition}` } : {}),
      },
    },
  };
};
