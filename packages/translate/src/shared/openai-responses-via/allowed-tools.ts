import { TranslatorInputError } from '../../translator-input-error.ts';
import type { OpenAIResponsesTool, OpenAIResponsesToolChoice } from '@floway-dev/protocols/openai-responses';

// OpenAI Chat Completions and Anthropic Messages preserve flat function/custom
// subsets by filtering declarations and translating the mode separately.
// Namespace and hosted selectors must arrive already rewritten as flat
// callables; otherwise translation rejects them so the permitted set cannot
// silently widen.
// https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/responses/responses.ts#L8246-L8279
export const restrictAllowedTools = (
  tools: OpenAIResponsesTool[] | null | undefined,
  choice: OpenAIResponsesToolChoice | null | undefined,
): { tools: OpenAIResponsesTool[] | null | undefined; choice: OpenAIResponsesToolChoice | null | undefined } => {
  if (typeof choice !== 'object' || choice?.type !== 'allowed_tools') {
    // Both targets collapse function/custom declarations to one callable kind.
    // Without a subset, a shared name cannot be restored unambiguously.
    const kinds = new Map<string, 'function' | 'custom'>();
    for (const tool of tools ?? []) {
      if (tool.type !== 'function' && tool.type !== 'custom') continue;
      if ('namespace' in tool && tool.namespace !== undefined) continue;
      const prior = kinds.get(tool.name);
      if (prior !== undefined && prior !== tool.type) {
        throw new TranslatorInputError(`Cannot translate distinct callable kinds sharing '${tool.name}'.`);
      }
      kinds.set(tool.name, tool.type);
    }
    return { tools, choice };
  }
  if ((choice.mode !== 'auto' && choice.mode !== 'required') || !Array.isArray(choice.tools)) {
    throw new TranslatorInputError('Cannot translate malformed allowed_tools mode or tools array.');
  }

  const declared = new Map<string, Map<string, OpenAIResponsesTool[]>>();
  for (const tool of tools ?? []) {
    if (tool.type !== 'function' && tool.type !== 'custom') continue;
    if ('namespace' in tool && tool.namespace !== undefined) continue;
    let names = declared.get(tool.type);
    if (names === undefined) {
      names = new Map();
      declared.set(tool.type, names);
    }
    const entries = names.get(tool.name) ?? [];
    entries.push(tool);
    names.set(tool.name, entries);
  }
  const selected = new Set<OpenAIResponsesTool>();
  const selectedKinds = new Map<string, string>();
  for (const selector of choice.tools) {
    if (typeof selector !== 'object' || selector === null
      || (selector.type !== 'function' && selector.type !== 'custom')
      || typeof selector.name !== 'string' || selector.namespace !== undefined
      || Object.keys(selector).some(key => key !== 'type' && key !== 'name' && key !== 'namespace')) {
      throw new TranslatorInputError('Cannot translate an allowed_tools selector that is not a flat function or custom tool.');
    }
    const matches = declared.get(selector.type)?.get(selector.name);
    if (matches === undefined) {
      throw new TranslatorInputError(`Cannot translate allowed_tools selector '${selector.name}' without a matching callable declaration.`);
    }
    const kind = selectedKinds.get(selector.name);
    if (kind !== undefined && kind !== selector.type) {
      throw new TranslatorInputError(`Cannot translate distinct allowed_tools callable kinds sharing '${selector.name}'.`);
    }
    selectedKinds.set(selector.name, selector.type);
    for (const tool of matches) selected.add(tool);
  }
  if (selected.size === 0 && choice.mode === 'required') {
    throw new TranslatorInputError('Cannot translate required allowed_tools with an empty callable subset.');
  }
  return {
    tools: (tools ?? []).filter(tool => selected.has(tool)),
    choice: selected.size === 0 ? 'none' : choice.mode,
  };
};
