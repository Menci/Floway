import { expect, test } from 'vitest';

import { envelopeRootToolSchema, envelopeToolArguments, hasRootToolSchemaCombinator, unwrapToolArguments } from '../../../src/shared/openai-responses-via/root-tool-schema-envelope.ts';

test.each(['oneOf', 'anyOf', 'allOf'] as const)('envelopes a root %s and retargets local definition references', combinator => {
  const schema = {
    type: 'object',
    properties: {},
    [combinator]: [{ $ref: '#/$defs/value' }],
    $defs: { value: { type: 'string' } },
  };

  expect(hasRootToolSchemaCombinator(schema)).toBe(true);
  expect(envelopeRootToolSchema(schema)).toEqual({
    type: 'object',
    properties: {
      arguments: {
        type: 'object',
        properties: {},
        [combinator]: [{ $ref: '#/properties/arguments/$defs/value' }],
        $defs: { value: { type: 'string' } },
      },
    },
    required: ['arguments'],
    additionalProperties: false,
  });
  expect(schema).toHaveProperty('$defs');
});

test('retargets document-root, property, and dynamic JSON Pointer references', () => {
  const enveloped = envelopeRootToolSchema({
    type: 'object',
    properties: {
      value: { type: 'string' },
      child: { $ref: '#' },
      alias: { $ref: '#/properties/value' },
      dynamic: { $dynamicRef: '#/$defs/value' },
    },
    oneOf: [{ $ref: '#/properties/value' }],
    $defs: { value: { type: 'string' } },
  });
  expect(enveloped.properties).toEqual({
    arguments: {
      type: 'object',
      properties: {
        value: { type: 'string' },
        child: { $ref: '#/properties/arguments' },
        alias: { $ref: '#/properties/arguments/properties/value' },
        dynamic: { $dynamicRef: '#/properties/arguments/$defs/value' },
      },
      oneOf: [{ $ref: '#/properties/arguments/properties/value' }],
      $defs: { value: { type: 'string' } },
    },
  });
});

test.each([
  { $recursiveRef: '#' },
  { $recursiveAnchor: true },
  { $id: 'root.json' },
  { $schema: 'https://json-schema.org/draft/2020-12/schema' },
])('rejects root-resource or recursive-schema semantics that cannot be enveloped losslessly', keyword => {
  expect(() => envelopeRootToolSchema({ type: 'object', oneOf: [{ type: 'string' }], ...keyword })).toThrow('root resource or recursive-schema');
});

test('does not rewrite reference-looking keys inside instance-valued keywords', () => {
  const instances = {
    const: { $ref: '#' },
    enum: [{ $ref: '#/properties/value' }],
    default: { $dynamicRef: '#/$defs/value' },
    examples: [{ $ref: '#' }],
  };
  const enveloped = envelopeRootToolSchema({
    type: 'object', oneOf: [{ type: 'object' }], properties: { value: { type: 'string' } }, ...instances,
  });
  expect((enveloped.properties as Record<string, Record<string, unknown>>).arguments).toMatchObject(instances);
});

test('rewrites schema dependencies but preserves property dependency arrays', () => {
  const enveloped = envelopeRootToolSchema({
    type: 'object', oneOf: [{ type: 'object' }],
    dependencies: {
      schemaDependency: { $ref: '#/properties/value' },
      propertyDependency: ['other'],
    },
    properties: { value: { type: 'string' } },
  });
  expect((enveloped.properties as Record<string, Record<string, unknown>>).arguments.dependencies).toEqual({
    schemaDependency: { $ref: '#/properties/arguments/properties/value' },
    propertyDependency: ['other'],
  });
});

test('preserves anchors, external references, and references owned by nested schema resources', () => {
  const enveloped = envelopeRootToolSchema({
    type: 'object',
    oneOf: [
      { $ref: '#named' },
      { $ref: 'https://example.com/schema#/$defs/value' },
      { $id: 'nested.json', type: 'object', properties: { self: { $ref: '#' }, value: { $ref: '#/properties/self' } } },
    ],
  });
  expect(enveloped.properties).toEqual({
    arguments: {
      type: 'object',
      oneOf: [
        { $ref: '#named' },
        { $ref: 'https://example.com/schema#/$defs/value' },
        { $id: 'nested.json', type: 'object', properties: { self: { $ref: '#' }, value: { $ref: '#/properties/self' } } },
      ],
    },
  });
});

test('does not identify a nested combinator as an unsupported root combinator', () => {
  expect(hasRootToolSchemaCombinator({
    type: 'object', properties: { value: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
  })).toBe(false);
});

test('wraps and unwraps function arguments without mutating their shape', () => {
  expect(envelopeToolArguments({ mode: 'delete', id: 'job-1' })).toEqual({
    arguments: { mode: 'delete', id: 'job-1' },
  });
  expect(unwrapToolArguments('{"arguments":{"mode":"delete","id":"job-1"}}')).toBe('{"mode":"delete","id":"job-1"}');
});

test.each(['not json', '{}', '{"arguments":null}', '{"arguments":true}'])('keeps a malformed or non-object envelope usable: %s', wrapped => {
  const result = unwrapToolArguments(wrapped);
  expect(typeof result).toBe('string');
  if (wrapped === 'not json' || wrapped === '{}') expect(result).toBe(wrapped);
});
