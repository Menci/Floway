import { responsesPayloadStage } from './facts.ts';

// Responses can reject a bare function_call when its name only appears in
// previously loaded namespaces. The lookup includes function and custom tool
// declarations. Explicit null preserves the unresolved call and its result.
// https://github.com/github/copilot-cli/issues/5400
export const nullUnresolvedFunctionCallNamespace = responsesPayloadStage('nullUnresolvedFunctionCallNamespace', (payload, facts) => {
  if (facts['route.targetApi'] !== 'openaiResponses') return payload;
  if (!facts['route.candidate'].providerModel.enabledFlags.includes('openai-responses-null-unresolved-function-call-namespace')) return payload;

  const defaultToolNames = new Set(payload.tools?.flatMap(tool =>
    tool.type === 'function' || tool.type === 'custom' ? [tool.name] : []));
  const namespacedToolNames = new Set<string>();
  return {
    ...payload,
    input: payload.input.map(item => {
      if (item.type === 'additional_tools' || item.type === 'tool_search_output') {
        for (const tool of item.tools) {
          if (tool.type === 'function' || tool.type === 'custom') defaultToolNames.add(tool.name);
          else if (tool.type === 'namespace') {
            for (const member of tool.tools) namespacedToolNames.add(member.name);
          }
        }
      }
      if (item.type === 'function_call' && item.namespace === undefined
        && namespacedToolNames.has(item.name) && !defaultToolNames.has(item.name)) {
        return { ...item, namespace: null };
      }
      return item;
    }),
  };
});
