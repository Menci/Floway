import { expect, test } from 'vitest';

import { envelopeAnthropicMessagesRootToolSchemas, envelopeRootToolSchema, hasRootToolSchemaCombinator, unwrapToolArguments } from '../../../../src/protocols/anthropic-messages/as-target/tool-schema-envelope.ts';
import { TranslateInputException } from '../../../../src/shared/input-error.ts';

test.each(['oneOf', 'anyOf', 'allOf'] as const)('envelopes a root %s and retargets local references', combinator => {
  const schema = { type: 'object', [combinator]: [{ $ref: '#/$defs/value' }], $defs: { value: { type: 'string' } } };
  expect(hasRootToolSchemaCombinator(schema)).toBe(true);
  expect(envelopeRootToolSchema(schema)).toEqual({
    type: 'object',
    properties: { arguments: { type: 'object', [combinator]: [{ $ref: '#/properties/arguments/$defs/value' }], $defs: { value: { type: 'string' } } } },
    required: ['arguments'],
    additionalProperties: false,
  });
  expect(schema).toHaveProperty('$defs');
});

test('preserves anchors, external references, and nested schema resources', () => {
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

test('rewrites references in subschemas while preserving literal values and property names', () => {
  const literal = { $ref: '#/$defs/value' };
  const schema = {
    oneOf: [{
      properties: { $dynamicRef: { $ref: '#/$defs/value' }, $id: { type: 'string' } },
      additionalProperties: { $ref: '#/$defs/value' },
      const: literal,
      enum: [literal],
      default: literal,
      examples: [{ $dynamicRef: '#sample', ...literal }],
    }],
    $defs: { value: { type: 'string' } },
  };
  expect(envelopeRootToolSchema(schema).properties).toEqual({
    arguments: {
      ...schema,
      oneOf: [{
        ...schema.oneOf[0],
        properties: { $dynamicRef: { $ref: '#/properties/arguments/$defs/value' }, $id: { type: 'string' } },
        additionalProperties: { $ref: '#/properties/arguments/$defs/value' },
      }],
    },
  });
});

test.each(['$recursiveRef', '$recursiveAnchor', '$dynamicRef', '$dynamicAnchor'])('rejects %s in a subschema', key => {
  expect(() => envelopeRootToolSchema({
    type: 'object',
    oneOf: [{ properties: { value: { [key]: key.endsWith('Anchor') ? true : '#' } } }],
  })).toThrow(TranslateInputException);
});

test('does not identify a nested combinator as an unsupported root combinator', () => {
  expect(hasRootToolSchemaCombinator({ type: 'object', properties: { value: { oneOf: [{ type: 'string' }] } } })).toBe(false);
});

test.each([
  { arguments: undefined, wrapped: '{"arguments":{}}' },
  { arguments: '{"value":1e400}', wrapped: '{"arguments":{"value":1e400}}' },
  { arguments: 'not json', wrapped: '{"arguments":{"raw_arguments":"not json"}}' },
])('wraps and unwraps history arguments $arguments', ({ arguments: argumentsJson, wrapped }) => {
  const result = envelopeAnthropicMessagesRootToolSchemas({
    settings: { model: 'm', stream: true },
    tools: [{ type: 'function', name: 'update', parameters: { oneOf: [{ type: 'object' }] } }],
  }, [{ kind: 'assistant', items: [{ type: 'function_call', call_id: 'call', name: 'update', ...(argumentsJson === undefined ? {} : { arguments: argumentsJson }) }] }]);
  const turn = result.turns[0];
  if (turn?.kind !== 'assistant' || turn.items[0]?.type !== 'function_call') throw new Error('expected function call');
  expect(turn.items[0].arguments).toBe(wrapped);
  expect(unwrapToolArguments(wrapped)).toEqual({
    json: argumentsJson === 'not json' ? '{"raw_arguments":"not json"}' : argumentsJson ?? '{}',
    objectArgument: true,
  });
});

test.each([
  ['not json', 'not json'], ['{}', '{}'], ['{"arguments":null}', 'null'], ['{"arguments":true}', 'true'],
])('keeps malformed or scalar envelopes usable: %s', (wrapped, json) => {
  expect(unwrapToolArguments(wrapped)).toEqual({ json, objectArgument: false });
});
