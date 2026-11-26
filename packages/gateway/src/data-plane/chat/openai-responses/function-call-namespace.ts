import { defineStage } from '../../pipeline/facts.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

// Responses can reject a bare call whose name appears only in previously
// loaded namespaces. Explicit null preserves the call and its result.
// https://github.com/github/copilot-cli/issues/5400
export const nullOpenAIResponsesUnresolvedFunctionCallNamespace = defineStage({
  name: 'openaiResponses.null-unresolved-function-call-namespace',
  through: {
    request: { needs: ['request.openaiResponses', 'provider.model'], provides: ['request.openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const model = facts['provider.model'];
    if (model.endpoints.openaiResponses === undefined
      || !model.enabledFlags.includes('openai-responses-null-unresolved-function-call-namespace')) return await scope.next(facts);

    const payload = facts['request.openaiResponses'];
    const input = openAIResponsesUnresolvedNamespaces(payload);
    return await scope.next({
      ...facts,
      'request.openaiResponses': input === payload.input ? payload : { ...payload, input },
    });
  },
});

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
