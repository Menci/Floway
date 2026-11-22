import type { OpenAIResponsesInterceptor } from './types.ts';

// A replayed bare call can fail validation when previously loaded tools put
// its name exclusively in named namespaces. Explicit null preserves the
// unresolved call and lets its original tool result remain in the history.
// https://github.com/github/copilot-cli/issues/5400
export const withFunctionCallNamespaceNormalized: OpenAIResponsesInterceptor = (ctx, _gatewayCtx, run) => {
  if (ctx.targetApi !== 'openaiResponses') return run();

  const defaultFunctions = new Set(ctx.payload.tools?.flatMap(tool => tool.type === 'function' ? [tool.name] : []));
  const namespacedFunctions = new Set<string>();
  ctx.payload = {
    ...ctx.payload,
    input: ctx.payload.input.map(item => {
      if (item.type === 'additional_tools' || item.type === 'tool_search_output') {
        for (const tool of item.tools) {
          if (tool.type === 'function') defaultFunctions.add(tool.name);
          if (tool.type === 'namespace') {
            for (const member of tool.tools) {
              if (member.type === 'function') namespacedFunctions.add(member.name);
            }
          }
        }
      }
      if (item.type === 'function_call' && item.namespace === undefined
        && namespacedFunctions.has(item.name) && !defaultFunctions.has(item.name)) {
        return { ...item, namespace: null };
      }
      return item;
    }),
  };

  return run();
};
