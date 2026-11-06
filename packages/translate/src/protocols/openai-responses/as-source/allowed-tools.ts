import { TranslatorInputError } from '../../../translator-input-error.ts';
import type { CanonicalOpenAIResponsesInputItem, OpenAIResponsesTool, OpenAIResponsesToolChoice } from '@floway-dev/protocols/openai-responses';

// Chat Completions and Anthropic Messages state a permitted subset by narrowing
// the declaration list, so a selector must resolve to declarations the request
// actually makes; otherwise the permitted set would silently widen.
//
// Namespace and hosted selectors are rewritten into flat callables before this
// point. One that survives names something this IR cannot carry, and is
// rejected rather than dropped for the same reason.
// https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts#L8246-L8279
const callableDeclarations = (tools: readonly OpenAIResponsesTool[]): { type: 'function' | 'custom'; name: string }[] =>
  tools.flatMap(tool => {
    if (tool.type !== 'function' && tool.type !== 'custom') return [];
    if ('namespace' in tool && tool.namespace !== undefined) return [];
    return [{ type: tool.type, name: tool.name }];
  });

// A deferred inventory states declarations the request may still use, so a
// name that means two things there cannot be carried either.
const inventoryDeclarations = (input: readonly CanonicalOpenAIResponsesInputItem[] | undefined): { type: 'function' | 'custom'; name: string }[] =>
  (input ?? []).flatMap(item => item.type === 'additional_tools' || item.type === 'tool_search_output'
    ? callableDeclarations(item.tools)
    : []);

const validateCallableKinds = (declarations: readonly { type: 'function' | 'custom'; name: string }[]): void => {
  const kinds = new Map<string, 'function' | 'custom'>();
  for (const { type, name } of declarations) {
    const prior = kinds.get(name);
    if (prior !== undefined && prior !== type) {
      throw new TranslatorInputError(`Cannot translate distinct callable kinds sharing '${name}'.`);
    }
    kinds.set(name, type);
  }
};

export const validateAllowedTools = (
  tools: readonly OpenAIResponsesTool[] | null | undefined,
  choice: OpenAIResponsesToolChoice | null | undefined,
  input?: readonly CanonicalOpenAIResponsesInputItem[],
): void => {
  const declarations = callableDeclarations(tools ?? []);
  if (typeof choice !== 'object' || choice?.type !== 'allowed_tools') {
    validateCallableKinds([...declarations, ...inventoryDeclarations(input)]);
    return;
  }

  if ((choice.mode !== 'auto' && choice.mode !== 'required') || !Array.isArray(choice.tools)) {
    throw new TranslatorInputError('Cannot translate malformed allowed_tools mode or tools array.');
  }

  const declared = new Set(declarations.map(({ type, name }) => `${type}:${name}`));
  const selectedKinds = new Map<string, 'function' | 'custom'>();
  const selected = new Set<string>();
  for (const selector of choice.tools) {
    if (typeof selector !== 'object' || selector === null
      || (selector.type !== 'function' && selector.type !== 'custom')
      || typeof (selector as { name?: unknown }).name !== 'string'
      || (selector as { namespace?: unknown }).namespace !== undefined
      || Object.keys(selector).some(key => key !== 'type' && key !== 'name' && key !== 'namespace')) {
      throw new TranslatorInputError('Cannot translate an allowed_tools selector that is not a flat function or custom tool.');
    }
    const { type, name } = selector as { type: 'function' | 'custom'; name: string };
    // A selector names a callable by kind, so a function and a custom tool that
    // share a name stay distinguishable.
    if (!declared.has(`${type}:${name}`)) {
      throw new TranslatorInputError(`Cannot translate allowed_tools selector '${name}' without a matching callable declaration.`);
    }
    const kind = selectedKinds.get(name);
    if (kind !== undefined && kind !== type) {
      throw new TranslatorInputError(`Cannot translate distinct allowed_tools callable kinds sharing '${name}'.`);
    }
    selectedKinds.set(name, type);
    selected.add(`${type}:${name}`);
  }
  if (selected.size === 0 && choice.mode === 'required') {
    throw new TranslatorInputError('Cannot translate required allowed_tools with an empty callable subset.');
  }
  // The subset lands on the target as one declaration list, so two kinds under
  // one name cannot both be carried even when the selector names only one.
  validateCallableKinds(declarations.filter(({ type, name }) => selected.has(`${type}:${name}`)));
};
