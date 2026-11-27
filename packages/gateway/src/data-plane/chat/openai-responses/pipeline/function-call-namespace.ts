import { defineStage } from '../../pipeline/facts.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

// A name found only in an earlier tool inventory needs an explicit namespace.
// https://github.com/github/copilot-cli/issues/5400
export const openAIResponsesUnresolvedNamespaces = (payload: Pick<CanonicalOpenAIResponsesPayload, 'tools' | 'input'>) => {
  const defaultNames = new Set(payload.tools?.flatMap(tool =>
    tool.type === 'function' || tool.type === 'custom' ? [tool.name] : []));
  const namespacedNames = new Set<string>();
  let changed = false;
  const input = payload.input.map(item => {
    if (item.type === 'additional_tools' || item.type === 'tool_search_output') {
      for (const tool of item.tools) {
        if (tool.type === 'function' || tool.type === 'custom') defaultNames.add(tool.name);
        if (tool.type === 'namespace') for (const member of tool.tools) namespacedNames.add(member.name);
      }
    }
    if (item.type === 'function_call' && item.namespace === undefined
      && namespacedNames.has(item.name) && !defaultNames.has(item.name)) {
      changed = true;
      return { ...item, namespace: null };
    }
    return item;
  });
  return changed ? input : payload.input;
};

export const nullOpenAIResponsesUnresolvedFunctionCallNamespace = defineStage({
  name: 'openaiResponses.null-unresolved-function-call-namespace',
  through: {
    request: { needs: ['openaiResponses', 'model', 'chat.target'], provides: ['openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    if (facts['chat.target'] !== 'openaiResponses'
      || !facts.model.enabledFlags.includes('openai-responses-null-unresolved-function-call-namespace')) return await scope.next(facts);
    const payload = facts.openaiResponses;
    const input = openAIResponsesUnresolvedNamespaces(payload);
    if (input === payload.input) return await scope.next(facts);
    return await scope.next({ ...facts, openaiResponses: { ...payload, input } });
  },
});
