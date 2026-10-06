import { klona } from 'klona/json';

import { TranslatorInputError } from '../../translator-input-error.ts';
import type { GeminiGenerateContentFunctionDeclaration, GeminiGenerateContentGenerationConfig, GeminiGenerateContentSchema } from '@floway-dev/protocols/gemini-generate-content';

const types: Readonly<Record<string, string>> = { STRING: 'string', NUMBER: 'number', INTEGER: 'integer', BOOLEAN: 'boolean', ARRAY: 'array', OBJECT: 'object', NULL: 'null' };
const integerConstraints = ['minItems', 'maxItems', 'minLength', 'maxLength', 'minProperties', 'maxProperties'] as const;

// Google Schema uses uppercase type enums, nullable, and decimal int64 strings.
// https://github.com/googleapis/googleapis/blob/e09e85d32ca349e1b205514a412817a7692595c6/google/ai/generativelanguage/v1beta/content.proto#L665-L763
export const geminiSchemaToJsonSchema = (schema: GeminiGenerateContentSchema): Record<string, unknown> => {
  const { type, nullable, properties, items, anyOf, propertyOrdering: _propertyOrdering, ...fields } = schema;
  const result: Record<string, unknown> = {
    ...klona(fields),
    type: Object.hasOwn(types, type) ? types[type] : type,
    ...(properties === undefined ? {} : { properties: Object.fromEntries(Object.entries(properties).map(([name, property]) => [name, geminiSchemaToJsonSchema(property)])) }),
    ...(items === undefined ? {} : { items: geminiSchemaToJsonSchema(items) }),
    ...(anyOf === undefined ? {} : { anyOf: anyOf.map(geminiSchemaToJsonSchema) }),
  };
  for (const key of integerConstraints) {
    if (schema[key] === undefined) continue;
    const value = Number(schema[key]);
    if (!/^\d+$/.test(schema[key]) || !Number.isSafeInteger(value)) throw new TranslatorInputError(`Gemini Schema ${key} must fit a non-negative safe integer.`);
    result[key] = value;
  }
  return nullable === true ? { anyOf: [result, { type: 'null' }] } : result;
};

const jsonSchemaObject = (schema: unknown): Record<string, unknown> => {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) throw new TranslatorInputError('The target protocol requires an object JSON Schema.');
  return klona(schema as Record<string, unknown>);
};

export const geminiFunctionParameters = (declaration: GeminiGenerateContentFunctionDeclaration): Record<string, unknown> | undefined =>
  declaration.parametersJsonSchema !== undefined ? jsonSchemaObject(declaration.parametersJsonSchema) : declaration.parameters === undefined ? undefined : geminiSchemaToJsonSchema(declaration.parameters);

export const geminiResponseSchema = (config: GeminiGenerateContentGenerationConfig): Record<string, unknown> | undefined =>
  config.responseJsonSchema !== undefined ? jsonSchemaObject(config.responseJsonSchema) : config.responseSchema === undefined ? undefined : geminiSchemaToJsonSchema(config.responseSchema);
