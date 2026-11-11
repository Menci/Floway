import { TranslateInputException } from '../../../types.ts';
import type { CanonicalOpenAIResponsesInputItem, OpenAIResponsesTool, OpenAIResponsesToolChoice } from '@floway-dev/protocols/openai-responses';

// A permitted selector must name a declaration without changing the full tool
// list that participates in prompt caching.
//
// A namespace selector is expanded here into the callables its group holds, and
// a hosted selector is rejected here: this IR carries no hosted callable.
// https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts#L8246-L8279
// A declaration is identified by the pair a grouped one states, so a selector
// that names either spelling resolves to the same callable.
const callableDeclarations = (tools: readonly OpenAIResponsesTool[]): { type: 'function' | 'custom'; name: string }[] =>
  tools.flatMap(tool => {
    if (tool.type === 'namespace') return tool.tools.flatMap(child => child.type === 'function' || child.type === 'custom'
      ? [{ type: child.type, name: `${tool.name}.${child.name}` }]
      : []);
    if (tool.type !== 'function' && tool.type !== 'custom') return [];
    const namespace = 'namespace' in tool && typeof tool.namespace === 'string' ? `${tool.namespace}.` : '';
    return [{ type: tool.type, name: `${namespace}${tool.name}` }];
  });

// A deferred inventory states declarations the request may still use.
const inventoryDeclarations = (input: readonly CanonicalOpenAIResponsesInputItem[] | undefined): { type: 'function' | 'custom'; name: string }[] =>
  (input ?? []).flatMap(item => item.type === 'additional_tools' || item.type === 'tool_search_output'
    ? callableDeclarations(item.tools)
    : []);

/**
 * The callable a selector names.
 *
 * `allowed_tools.tools` is the wire's own `Record<string, unknown>` array, so
 * this is where a member becomes a typed selector. A member that carries
 * anything beyond the three fields a selector may state is not one.
 */
export const requireCallableSelector = (selector: unknown): { readonly type: 'function' | 'custom'; readonly name: string; readonly namespace?: string } => {
  if (typeof selector !== 'object' || selector === null
    || ((selector as { type?: unknown }).type !== 'function' && (selector as { type?: unknown }).type !== 'custom')
    || typeof (selector as { name?: unknown }).name !== 'string'
    || ('namespace' in selector && selector.namespace !== undefined && typeof selector.namespace !== 'string')
    || Object.keys(selector).some(key => key !== 'type' && key !== 'name' && key !== 'namespace')) {
    throw new TranslateInputException('Cannot translate an allowed_tools selector that is not a function or custom tool.');
  }
  return selector as { readonly type: 'function' | 'custom'; readonly name: string; readonly namespace?: string };
};

export const validateAllowedToolSelectors = (
  tools: readonly OpenAIResponsesTool[] | null | undefined,
  choice: OpenAIResponsesToolChoice | null | undefined,
  input?: readonly CanonicalOpenAIResponsesInputItem[],
): void => {
  // A deferred inventory declares callables too, so a selector may name one.
  const declarations = [...callableDeclarations(tools ?? []), ...inventoryDeclarations(input)];
  if (typeof choice !== 'object' || choice?.type !== 'allowed_tools') return;

  if ((choice.mode !== 'auto' && choice.mode !== 'required') || !Array.isArray(choice.tools)) {
    throw new TranslateInputException('Cannot translate malformed allowed_tools mode or tools array.');
  }

  const declared = new Set(declarations.map(({ type, name }) => `${type}:${name}`));
  const selected = new Set<string>();
  // A selector that names a whole group stands for every callable it holds.
  const allGroups = [
    ...(tools ?? []),
    ...(input ?? []).flatMap(item => item.type === 'additional_tools' || item.type === 'tool_search_output' ? item.tools : []),
  ];
  const expanded = choice.tools.flatMap(selector => {
    if (typeof selector !== 'object' || selector === null) return [selector];
    if ((selector as { type?: unknown }).type !== 'namespace') return [selector];
    const group = allGroups.flatMap(tool => tool.type === 'namespace' && tool.name === (selector as { name?: unknown }).name ? [tool] : []);
    if (group.length === 0) throw new TranslateInputException(`Cannot translate group selector '${String((selector as { name?: unknown }).name)}' without a matching declaration.`);
    return group.flatMap(entry => entry.tools.flatMap(child => child.type === 'function' || child.type === 'custom'
      ? [{ type: child.type, namespace: entry.name, name: child.name }]
      : []));
  });
  for (const selector of expanded) {
    const declaredSelector = requireCallableSelector(selector);
    const type = declaredSelector.type;
    // A selector may name the group separately or spell the pair out.
    const name = declaredSelector.namespace === undefined || declaredSelector.name.includes('.')
      ? declaredSelector.name
      : `${declaredSelector.namespace}.${declaredSelector.name}`;
    // A selector names a callable by kind, so a function and a custom tool that
    // share a name stay distinguishable.
    if (!declared.has(`${type}:${name}`)) {
      throw new TranslateInputException(`Cannot translate allowed_tools selector '${name}' without a matching callable declaration.`);
    }
    selected.add(`${type}:${name}`);
  }
  if (selected.size === 0 && choice.mode === 'required') {
    throw new TranslateInputException('Cannot translate required allowed_tools with an empty callable subset.');
  }
};
