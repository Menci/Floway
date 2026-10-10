import { klona } from 'klona/json';

import { TranslatorInputError } from '../../translator-input-error.ts';
import { jsonInteger } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentFunctionDeclaration, GeminiGenerateContentGenerationConfig, GeminiGenerateContentSchema } from '@floway-dev/protocols/gemini-generate-content';

const types: Readonly<Record<string, string>> = { STRING: 'string', NUMBER: 'number', INTEGER: 'integer', BOOLEAN: 'boolean', ARRAY: 'array', OBJECT: 'object', NULL: 'null' };
const integerConstraints = ['minItems', 'maxItems', 'minLength', 'maxLength', 'minProperties', 'maxProperties'] as const;

// Google Schema uses uppercase type enums, nullable, and decimal int64 strings.
// https://github.com/googleapis/googleapis/blob/e09e85d32ca349e1b205514a412817a7692595c6/google/ai/generativelanguage/v1beta/content.proto#L665-L763
export const geminiSchemaToJsonSchema = (schema: GeminiGenerateContentSchema): Record<string, unknown> => {
  const { type, nullable, properties, items, anyOf, propertyOrdering, ...fields } = schema;
  const propertyNames = properties === undefined ? [] : [...new Set([...(propertyOrdering ?? []), ...Object.keys(properties)])];
  const orderedProperties = properties === undefined ? undefined : Object.fromEntries(propertyNames.filter(name => Object.hasOwn(properties, name)).map(name => [name, geminiSchemaToJsonSchema(properties[name])]));
  const result: Record<string, unknown> = {
    ...klona(fields),
    type: Object.hasOwn(types, type) ? types[type] : type,
    ...(orderedProperties === undefined ? {} : { properties: new Proxy(orderedProperties, { ownKeys: target => [...propertyNames.filter(name => Object.hasOwn(target, name)), ...Reflect.ownKeys(target).filter(name => typeof name !== 'string' || !propertyNames.includes(name))] }) }),
    ...(items === undefined ? {} : { items: geminiSchemaToJsonSchema(items) }),
    ...(anyOf === undefined ? {} : { anyOf: anyOf.map(geminiSchemaToJsonSchema) }),
  };
  for (const key of integerConstraints) {
    if (schema[key] === undefined) continue;
    if (!/^\d+$/.test(schema[key])) throw new TranslatorInputError(`Gemini Schema ${key} must be a non-negative integer.`);
    result[key] = jsonInteger(BigInt(schema[key]));
  }
  return nullable === true ? { anyOf: [result, { type: 'null' }] } : result;
};

const jsonSchemaObject = (schema: unknown): Record<string, unknown> => {
  if (schema === true) return {};
  if (schema === false) return { not: {} };
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) throw new TranslatorInputError('The target protocol requires an object JSON Schema.');
  return klona(schema as Record<string, unknown>);
};

export const geminiFunctionParameters = (declaration: GeminiGenerateContentFunctionDeclaration): Record<string, unknown> | undefined => {
  if (declaration.parameters !== undefined && declaration.parametersJsonSchema !== undefined) throw new TranslatorInputError('Gemini parameters and parametersJsonSchema are mutually exclusive.');
  return declaration.parametersJsonSchema !== undefined ? jsonSchemaObject(declaration.parametersJsonSchema) : declaration.parameters === undefined ? undefined : geminiSchemaToJsonSchema(declaration.parameters);
};

export const geminiResponseSchema = (config: GeminiGenerateContentGenerationConfig): Record<string, unknown> | undefined => {
  if (config.responseSchema !== undefined && config.responseJsonSchema !== undefined) throw new TranslatorInputError('Gemini responseSchema and responseJsonSchema are mutually exclusive.');
  return config.responseJsonSchema !== undefined ? jsonSchemaObject(config.responseJsonSchema) : config.responseSchema === undefined ? undefined : geminiSchemaToJsonSchema(config.responseSchema);
};
