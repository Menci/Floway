import { TranslateInputException } from './input-error.ts';
import { isPlainJSONObject, parseJSONObject } from './json/object.ts';
import type { RestoredAssistantTurn } from '../composition/reading.ts';
import type { IRInputTurnWithCallIds } from '../composition/request/call-ids.ts';
import type { IRInputRequestHeader, IRInputTool } from '../ir/input/types.ts';
import { parseJSONWithRawNumbers } from '@floway-dev/protocols/common';

const ENVELOPE_KEY = 'arguments';
const ENVELOPE_POINTER = `#/properties/${ENVELOPE_KEY}`;
const ROOT_COMBINATORS = ['oneOf', 'anyOf', 'allOf'] as const;
const DYNAMIC_RECURSION_KEYS = new Set(['$recursiveRef', '$recursiveAnchor', '$dynamicRef', '$dynamicAnchor']);

// Subschema positions from draft 2020-12 and draft-07.
// https://json-schema.org/draft/2020-12/schema
// https://json-schema.org/draft-07/schema
const SCHEMA_MAP_KEYWORDS = new Set(['$defs', 'definitions', 'dependencies', 'dependentSchemas', 'patternProperties', 'properties']);
const SCHEMA_ARRAY_KEYWORDS = new Set([...ROOT_COMBINATORS, 'items', 'prefixItems']);
const SCHEMA_VALUE_KEYWORDS = new Set([
  'additionalItems', 'additionalProperties', 'contains', 'contentSchema', 'else', 'if', 'items', 'not',
  'propertyNames', 'then', 'unevaluatedItems', 'unevaluatedProperties',
]);

export type ToolArgumentsEnvelope<Value> = { readonly [ENVELOPE_KEY]: Value };

export const hasRootToolSchemaCombinator = (schema: Record<string, unknown>): boolean =>
  ROOT_COMBINATORS.some(key => Array.isArray(schema[key]));

const rewriteLocalReference = (reference: string): string => {
  if (reference === '#') return ENVELOPE_POINTER;
  if (reference.startsWith('#/')) return `${ENVELOPE_POINTER}${reference.slice(1)}`;
  return reference;
};

const relocateSchema = (schema: Record<string, unknown>, rebaseReferences: boolean): Record<string, unknown> => {
  // Fragment references in a schema resource with its own $id resolve against that resource.
  const rebase = rebaseReferences && typeof schema.$id !== 'string';
  const relocateChild = (value: unknown): unknown => isPlainJSONObject(value) ? relocateSchema(value, rebase) : value;
  return Object.fromEntries(Object.entries(schema).map(([keyword, value]) => {
    if (DYNAMIC_RECURSION_KEYS.has(keyword)) {
      throw new TranslateInputException('Cannot translate a tool schema with a root combinator and dynamic recursive references.');
    }
    if (keyword === '$ref' && rebase && typeof value === 'string') return [keyword, rewriteLocalReference(value)];
    if (SCHEMA_MAP_KEYWORDS.has(keyword) && isPlainJSONObject(value)) {
      return [keyword, Object.fromEntries(Object.entries(value).map(([name, child]) => [name, relocateChild(child)]))];
    }
    if (SCHEMA_ARRAY_KEYWORDS.has(keyword) && Array.isArray(value)) return [keyword, value.map(relocateChild)];
    if (SCHEMA_VALUE_KEYWORDS.has(keyword)) return [keyword, relocateChild(value)];
    return [keyword, value];
  }));
};

// Anthropic Messages `input_schema` and GenerateContent `parametersJsonSchema`
// accept JSON Schema combinators below root properties while rejecting or
// mis-enforcing them at the tool schema root. Dynamic recursive references
// cannot be relocated under a property without changing resource traversal.
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use#specifying-client-tools
// https://ai.google.dev/api/caching#FunctionDeclaration
export const envelopeRootToolSchema = (schema: Record<string, unknown>): Record<string, unknown> => ({
  type: 'object',
  properties: { [ENVELOPE_KEY]: relocateSchema(schema, true) },
  required: [ENVELOPE_KEY],
  additionalProperties: false,
});

const envelopeToolArgumentsJSON = (input: string | undefined): string => {
  if (input === undefined) return JSON.stringify({ [ENVELOPE_KEY]: {} });
  try {
    return JSON.stringify({ [ENVELOPE_KEY]: parseJSONObject(input) });
  } catch {
    return JSON.stringify({ [ENVELOPE_KEY]: { raw_arguments: input } });
  }
};

export const unwrapToolArguments = (wrapped: string): { json: string; objectArgument: boolean } => {
  let parsed: unknown;
  try {
    parsed = parseJSONWithRawNumbers(wrapped);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { json: wrapped, objectArgument: false };
  }
  const argument = isPlainJSONObject(parsed) ? parsed[ENVELOPE_KEY] : undefined;
  return argument === undefined
    ? { json: wrapped, objectArgument: false }
    : { json: JSON.stringify(argument), objectArgument: isPlainJSONObject(argument) };
};

export interface EnvelopedRootTools<Restored> {
  readonly request: IRInputRequestHeader;
  readonly turns: readonly (IRInputTurnWithCallIds | RestoredAssistantTurn<Restored>)[];
  readonly names: ReadonlySet<string>;
}

export const envelopeRootToolSchemas = <Restored>(
  request: IRInputRequestHeader,
  turns: readonly (IRInputTurnWithCallIds | RestoredAssistantTurn<Restored>)[],
): EnvelopedRootTools<Restored> => {
  const names = new Set((request.tools ?? []).flatMap(tool =>
    tool.type === 'function' && tool.parameters !== undefined && hasRootToolSchemaCombinator(tool.parameters) ? [tool.name] : []));
  if (names.size === 0) return { request, turns, names };

  const tools = request.tools?.map((tool): IRInputTool => tool.type === 'function' && names.has(tool.name)
    ? { ...tool, parameters: envelopeRootToolSchema(tool.parameters!) }
    : tool);
  return {
    request: { ...request, ...(tools === undefined ? {} : { tools }) },
    names,
    turns: turns.map(turn => turn.kind !== 'assistant'
      ? turn
      : {
          ...turn,
          items: turn.items.map(item => item.type === 'function_call' && names.has(item.name)
            ? { ...item, arguments: envelopeToolArgumentsJSON(item.arguments) }
            : item),
        }),
  };
};
