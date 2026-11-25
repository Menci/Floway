import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { providerSupportsOperation } from '../../../pipeline/provider-pipelines.ts';
import { move, transform } from '@floway-dev/pipeline';
import type { AnthropicMessagesMessage } from '@floway-dev/protocols/anthropic-messages';

const { defineStage } = gatewayFactSpace<{}>();
const key = 'request.anthropicMessages';

export const applyRoleCompatibility = (operation: 'anthropicMessages' | 'anthropicMessagesCountTokens') => defineStage({
  name: `${operation}.apply-role-compatibility`,
  through: {
    request: { needs: [key, 'serve.candidate'], provides: [key], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request: facts => {
      const { model, upstream } = facts['serve.candidate'];
      if (model.endpoints.anthropicMessages === undefined || !providerSupportsOperation(upstream.kind, operation)) return facts;
      const rewriteAllSystem = model.enabledFlags.includes('rewrite-mid-conv-system-to-user');
      const rewriteDisallowedSystem = model.enabledFlags.includes('rewrite-disallowed-mid-conv-system-to-user');
      if (!rewriteAllSystem && !rewriteDisallowedSystem) return facts;

      const payload = facts[key];
      const disallowed = rewriteDisallowedSystem ? disallowedSystemIndexes(payload.messages) : null;
      const messages = payload.messages.map((message, index) => message.role === 'system' && (rewriteAllSystem || disallowed?.has(index))
        ? { role: 'user' as const, content: message.content }
        : message);
      return { ...facts, [key]: move({ ...payload, messages }) };
    },
  })),
});

const serverToolResultTypes = new Set([
  'advisor_tool_result',
  'bash_code_execution_tool_result',
  'code_execution_tool_result',
  'text_editor_code_execution_tool_result',
  'tool_search_tool_result',
  'web_fetch_tool_result',
  'web_search_tool_result',
]);

const endsWithServerToolResult = (message: AnthropicMessagesMessage | undefined): boolean => {
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return false;
  const last = message.content.at(-1);
  return last !== undefined && serverToolResultTypes.has(last.type);
};

// https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages#limitations
const disallowedSystemIndexes = (messages: readonly AnthropicMessagesMessage[]): ReadonlySet<number> => {
  const disallowed = new Set<number>();
  for (let start = 0; start < messages.length;) {
    if (messages[start]?.role !== 'system') {
      start++;
      continue;
    }

    let end = start + 1;
    while (messages[end]?.role === 'system') end++;
    const previous = messages[start - 1];
    const next = messages[end];
    const validPrevious = previous?.role === 'user' || endsWithServerToolResult(previous);
    const validNext = next === undefined || next.role === 'assistant';
    if (!validPrevious || !validNext) {
      for (let index = start; index < end; index++) {
        const message = messages[index];
        if (message.role !== 'system') throw new TypeError('Expected an Anthropic Messages system group');
        const directiveOnly = Array.isArray(message.content) && message.content.length === 0 && message.output_config != null;
        if (!directiveOnly) disallowed.add(index);
      }
    }
    start = end;
  }
  return disallowed;
};
