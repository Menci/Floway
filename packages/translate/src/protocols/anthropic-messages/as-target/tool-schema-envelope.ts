import type { RestoredAssistantTurn } from '../../../composition/reading.ts';
import type { IRInputTurnWithCallIds } from '../../../composition/request/call-ids.ts';
import type { IRInputRequestHeader, IRInputTool } from '../../../ir/input/types.ts';
import { TranslateInputException } from '../../../shared/input-error.ts';
import { parseJSONObject } from '../../../shared/json/object.ts';
import { parseJSONWithRawNumbers } from '@floway-dev/protocols/common';

const ENVELOPE_KEY = 'arguments';
const ENVELOPE_POINTER = '#/properties/arguments';
const ROOT_COMBINATORS = ['oneOf', 'anyOf', 'allOf'] as const;
const DYNAMIC_RECURSION_KEYS = new Set(['$recursiveRef', '$recursiveAnchor', '$dynamicRef', '$dynamicAnchor']);

export const hasRootToolSchemaCombinator = (schema: Record<string, unknown>): boolean =>
  ROOT_COMBINATORS.some(key => Array.isArray(schema[key]));

const hasDynamicRecursion = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(hasDynamicRecursion);
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(([key, child]) => DYNAMIC_RECURSION_KEYS.has(key) || hasDynamicRecursion(child));
};

const rewriteLocalReference = (reference: string): string => {
  if (reference === '#') return ENVELOPE_POINTER;
  if (reference.startsWith('#/')) return `${ENVELOPE_POINTER}${reference.slice(1)}`;
  return reference;
};

const rewriteLocalReferences = (value: unknown, rewriteEnabled: boolean): unknown => {
  if (Array.isArray(value)) return value.map(item => rewriteLocalReferences(item, rewriteEnabled));
  if (typeof value !== 'object' || value === null) return value;

  const source = value as Record<string, unknown>;
  // A nested `$id` starts a schema resource. Fragment references below it are
  // relative to that resource and retain their spelling when the resource moves.
  const rewriteChildren = rewriteEnabled && typeof source.$id !== 'string';
  return Object.fromEntries(Object.entries(source).map(([key, child]) => [
    key,
    key === '$ref' && rewriteChildren && typeof child === 'string'
      ? rewriteLocalReference(child)
      : rewriteLocalReferences(child, rewriteChildren),
  ]));
};

// Anthropic accepts JSON Schema combinators below input_schema but rejects them
// at its root. Dynamic recursive references cannot be relocated under a property
// without changing their resource traversal, so reject those schemas instead of
// silently changing validation semantics.
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use#specifying-client-tools
export const envelopeRootToolSchema = (schema: Record<string, unknown>): Record<string, unknown> => {
  if (hasDynamicRecursion(schema)) {
    throw new TranslateInputException('Cannot translate an Anthropic tool schema with a root combinator and dynamic recursive references.');
  }
  return {
    type: 'object',
    properties: { [ENVELOPE_KEY]: rewriteLocalReferences(structuredClone(schema), true) },
    required: [ENVELOPE_KEY],
    additionalProperties: false,
  };
};

const envelopeToolArgumentsJSON = (input: string | undefined): string => {
  if (input === undefined) return JSON.stringify({ [ENVELOPE_KEY]: {} });
  try {
    return JSON.stringify({ [ENVELOPE_KEY]: parseJSONObject(input) });
  } catch {
    return JSON.stringify({ [ENVELOPE_KEY]: { raw_arguments: input } });
  }
};

export const unwrapToolArguments = (wrapped: string): string => {
  try {
    const parsed = parseJSONWithRawNumbers(wrapped);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !(ENVELOPE_KEY in parsed)) return wrapped;
    return JSON.stringify((parsed as Record<string, unknown>)[ENVELOPE_KEY]) ?? wrapped;
  } catch {
    return wrapped;
  }
};

export interface EnvelopedAnthropicMessagesTools<Restored> {
  readonly request: IRInputRequestHeader;
  readonly turns: readonly (IRInputTurnWithCallIds | RestoredAssistantTurn<Restored>)[];
  readonly names: ReadonlySet<string>;
}

export const envelopeAnthropicMessagesRootToolSchemas = <Restored>(
  request: IRInputRequestHeader,
  turns: readonly (IRInputTurnWithCallIds | RestoredAssistantTurn<Restored>)[],
): EnvelopedAnthropicMessagesTools<Restored> => {
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
