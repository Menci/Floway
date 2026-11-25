import { openAIResponsesFactSpace } from './facts.ts';
import { openAIResponsesTargetFor } from './target.ts';
import { move, transform } from '@floway-dev/pipeline';

const { defineStage } = openAIResponsesFactSpace<{}>();

// Explicit null keeps the bare call and its result when its name occurs only
// in previously loaded namespaces.
// https://github.com/github/copilot-cli/issues/5400
export const nullOpenAIResponsesUnresolvedFunctionCallNamespace = defineStage({
  name: 'openaiResponses.null-unresolved-function-call-namespace',
  through: {
    request: { needs: ['request.openaiResponses', 'serve.candidate'], provides: ['request.openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request(facts) {
      const candidate = facts['serve.candidate'];
      if (openAIResponsesTargetFor(candidate) !== 'openaiResponses'
        || !candidate.model.enabledFlags.includes('openai-responses-null-unresolved-function-call-namespace')) return facts;

      const payload = facts['request.openaiResponses'];
      const defaultNames = new Set(payload.tools?.flatMap(tool =>
        tool.type === 'function' || tool.type === 'custom' ? [tool.name] : []));
      const namespacedNames = new Set<string>();
      const input = payload.input.map(item => {
        if (item.type === 'additional_tools' || item.type === 'tool_search_output') {
          for (const tool of item.tools) {
            if (tool.type === 'function' || tool.type === 'custom') defaultNames.add(tool.name);
            else if (tool.type === 'namespace') {
              for (const member of tool.tools) namespacedNames.add(member.name);
            }
          }
        }
        if (item.type === 'function_call' && item.namespace === undefined
          && namespacedNames.has(item.name) && !defaultNames.has(item.name)) {
          return { ...item, namespace: null };
        }
        return item;
      });
      return { ...facts, 'request.openaiResponses': move({ ...payload, input }) };
    },
  })),
});
