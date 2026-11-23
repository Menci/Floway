import type { ChatEgressInput } from '../../shared/route-body.ts';
import { defineStage, transform } from '@floway-dev/pipeline';
import type { AnthropicMessagesMessage } from '@floway-dev/protocols/anthropic-messages';

const SERVER_TOOL_RESULT_TYPES = new Set([
  'advisor_tool_result',
  'bash_code_execution_tool_result',
  'code_execution_tool_result',
  'text_editor_code_execution_tool_result',
  'tool_search_tool_result',
  'web_fetch_tool_result',
  'web_search_tool_result',
]);

const assistantEndsWithServerToolResult = (message: AnthropicMessagesMessage | undefined): boolean => {
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return false;
  const lastBlock = message.content.at(-1);
  return lastBlock !== undefined && SERVER_TOOL_RESULT_TYPES.has(lastBlock.type);
};

// https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages#limitations
const disallowedContentSystemMessageIndexes = (messages: readonly AnthropicMessagesMessage[]): ReadonlySet<number> => {
  const invalid = new Set<number>();
  for (let start = 0; start < messages.length;) {
    if (messages[start]?.role !== 'system') {
      start++;
      continue;
    }

    let end = start + 1;
    while (messages[end]?.role === 'system') end++;
    const previous = messages[start - 1];
    const next = messages[end];
    const validPrevious = previous?.role === 'user' || assistantEndsWithServerToolResult(previous);
    const validNext = next === undefined || next.role === 'assistant';
    if (!validPrevious || !validNext) {
      for (let index = start; index < end; index++) {
        const message = messages[index];
        if (message.role === 'system' && !(Array.isArray(message.content) && message.content.length === 0 && message.output_config != null)) invalid.add(index);
      }
    }
    start = end;
  }
  return invalid;
};

type Request = Pick<ChatEgressInput<'anthropicMessages'>, 'request.payload' | 'route.candidate'>;

export const applyRoleCompatibility = defineStage<Request, Request, object, object>({
  name: 'applyRoleCompatibility',
  through: {
    request: { needs: ['request.payload', 'route.candidate'], consumes: [], provides: ['request.payload'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: transform(() => ({
    request: facts => {
      const flags = facts['route.candidate'].providerModel.enabledFlags;
      const rewriteAll = flags.includes('rewrite-mid-conv-system-to-user');
      const rewriteDisallowed = flags.includes('rewrite-disallowed-mid-conv-system-to-user');
      if (!rewriteAll && !rewriteDisallowed) return facts;

      const payload = facts['request.payload'];
      const disallowed = rewriteDisallowed ? disallowedContentSystemMessageIndexes(payload.messages) : new Set<number>();
      return {
        ...facts,
        'request.payload': {
          ...payload,
          messages: payload.messages.map((message, index) =>
            message.role === 'system' && (rewriteAll || disallowed.has(index)) ? { role: 'user', content: message.content } : message),
        },
      };
    },
  })),
});
