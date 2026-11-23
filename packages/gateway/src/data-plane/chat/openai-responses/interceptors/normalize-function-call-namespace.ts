import type { OpenAIResponsesInterceptor } from './types.ts';

// Responses can reject a bare function_call when its name only appears in
// previously loaded namespaces. The lookup includes function and custom tool
// declarations. Explicit null preserves the unresolved call and its result.
// https://github.com/github/copilot-cli/issues/5400
export const withFunctionCallNamespaceNormalized: OpenAIResponsesInterceptor = (ctx, _gatewayCtx, run) => {
  if (ctx.targetApi !== 'openaiResponses') return run();

  const defaultToolNames = new Set(ctx.payload.tools?.flatMap(tool =>
    tool.type === 'function' || tool.type === 'custom' ? [tool.name] : []));
  const namespacedToolNames = new Set<string>();
  ctx.payload = {
    ...ctx.payload,
    input: ctx.payload.input.map(item => {
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

  return run();
};
