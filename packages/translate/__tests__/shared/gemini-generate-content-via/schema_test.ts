import { expect, test } from 'vitest';

import { geminiFunctionParameters, geminiResponseSchema, geminiSchemaToJsonSchema } from '../../../src/shared/gemini-generate-content-via/schema.ts';

test('converts Google Schema validation keywords while preserving literal data', () => {
  const source = {
    type: 'OBJECT',
    propertyOrdering: ['names'],
    properties: {
      names: {
        type: 'ARRAY', minItems: '1',
        items: { type: 'STRING', nullable: true, example: { type: 'OBJECT' } },
      },
    },
  };
  expect(geminiSchemaToJsonSchema(source)).toEqual({
    type: 'object',
    properties: {
      names: {
        type: 'array', minItems: 1,
        items: { anyOf: [{ type: 'string', example: { type: 'OBJECT' } }, { type: 'null' }] },
      },
    },
  });
  expect(source.properties.names.items.nullable).toBe(true);
});

test('preserves explicitly supplied JSON Schema and unknown Google type values', () => {
  const schema = { type: 'object', properties: {} };
  expect(geminiFunctionParameters({ name: 'lookup', parametersJsonSchema: schema })).toEqual(schema);
  expect(geminiResponseSchema({ responseJsonSchema: schema })).toEqual(schema);
  expect(geminiSchemaToJsonSchema({ type: 'FUTURE_TYPE' })).toEqual({ type: 'FUTURE_TYPE' });
});

test('preserves exact decimal constraints beyond IEEE-754 integer precision', () => {
  expect(JSON.stringify(geminiSchemaToJsonSchema({ type: 'ARRAY', maxItems: '9007199254740993' }))).toContain('"maxItems":9007199254740993');
});

test('orders schema properties without changing their constraints', () => {
  const result = geminiSchemaToJsonSchema({ type: 'OBJECT', propertyOrdering: ['b', 'a'], properties: { a: { type: 'STRING' }, b: { type: 'INTEGER' }, c: { type: 'BOOLEAN' } } });
  expect(Object.keys(result.properties as object)).toEqual(['b', 'a', 'c']);
  expect(result).not.toHaveProperty('propertyOrdering');
});

test.each([true, false])('normalizes boolean JSON Schema %s without relaxing its meaning', schema => {
  expect(geminiResponseSchema({ responseJsonSchema: schema })).toEqual(schema ? {} : { not: {} });
});

test('rejects mutually exclusive Gemini schema fields', () => {
  expect(() => geminiFunctionParameters({ name: 'lookup', parameters: { type: 'OBJECT' }, parametersJsonSchema: {} })).toThrow('mutually exclusive');
  expect(() => geminiResponseSchema({ responseSchema: { type: 'OBJECT' }, responseJsonSchema: {} })).toThrow('mutually exclusive');
});

test('raw JSON Schema outputs own every mutable descendant across translation trips', () => {
  const schema = JSON.parse('{"type":"object","properties":{"value":{"enum":["original"],"default":{"nested":[1]}}},"__proto__":{"preserved":[2]}}') as Record<string, unknown>;
  const original = JSON.stringify(schema);
  const response = geminiResponseSchema({ responseJsonSchema: schema })!;
  const parameters = geminiFunctionParameters({ name: 'lookup', parametersJsonSchema: schema })!;
  const value = (response.properties as Record<string, Record<string, unknown>>).value;
  (value.enum as string[]).push('changed');
  ((value.default as { nested: number[] }).nested).push(3);
  (response.__proto__ as { preserved: number[] }).preserved.push(4);
  expect(JSON.stringify(schema)).toBe(original);
  expect(JSON.stringify(parameters)).toBe(original);
  expect(Object.hasOwn(response, '__proto__')).toBe(true);
  expect(Object.getPrototypeOf(response)).toBe(Object.prototype);
});

test('Google Schema outputs own literal fields without converting their data as schemas', () => {
  const schema = {
    type: 'OBJECT',
    required: ['value'],
    properties: {
      value: { type: 'STRING', enum: ['original'], default: { nested: [1] }, example: { type: 'OBJECT', nested: [2] } },
    },
  };
  const original = JSON.stringify(schema);
  const response = geminiResponseSchema({ responseSchema: schema })!;
  const parameters = geminiFunctionParameters({ name: 'lookup', parameters: schema })!;
  const value = (response.properties as Record<string, Record<string, unknown>>).value;
  (response.required as string[]).push('other');
  (value.enum as string[]).push('changed');
  ((value.default as { nested: number[] }).nested).push(3);
  ((value.example as { nested: number[] }).nested).push(4);
  expect(JSON.stringify(schema)).toBe(original);
  expect(parameters).toEqual({
    type: 'object', required: ['value'],
    properties: { value: { type: 'string', enum: ['original'], default: { nested: [1] }, example: { type: 'OBJECT', nested: [2] } } },
  });
});

test('preserves integer-named property ordering through JSON serialization', () => {
  const result = geminiSchemaToJsonSchema({ type: 'OBJECT', propertyOrdering: ['1', '0'], properties: { '0': { type: 'STRING' }, '1': { type: 'INTEGER' } } });
  expect(JSON.stringify(result.properties)).toBe('{"1":{"type":"integer"},"0":{"type":"string"}}');
});
