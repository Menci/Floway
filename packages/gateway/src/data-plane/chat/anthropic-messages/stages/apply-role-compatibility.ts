import type { AnthropicMessagesRequestFacts } from './types.ts';
import type { ChatPipelineServices } from '../../pipeline/index.ts';
import { defineRequestStage } from '@floway-dev/pipeline';
import type {
  AnthropicMessagesAssistantMessage,
  AnthropicMessagesMessage,
  AnthropicMessagesSystemMessage,
} from '@floway-dev/protocols/anthropic-messages';
import { hasEnabledFlag } from '@floway-dev/provider';

const SERVER_TOOL_RESULT_TYPES = new Set([
  'advisor_tool_result',
  'bash_code_execution_tool_result',
  'code_execution_tool_result',
  'text_editor_code_execution_tool_result',
  'tool_search_tool_result',
  'web_fetch_tool_result',
  'web_search_tool_result',
]);

const isDirectiveOnlySystemMessage = (message: AnthropicMessagesSystemMessage): boolean =>
  Array.isArray(message.content) && message.content.length === 0 && message.output_config != null;

const assistantEndsWithServerToolResult = (message: AnthropicMessagesMessage | undefined): message is AnthropicMessagesAssistantMessage => {
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return false;
  const block = message.content.at(-1);
  return block !== undefined && SERVER_TOOL_RESULT_TYPES.has(block.type);
};

// https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages#limitations
const disallowedSystemMessageIndexes = (messages: readonly AnthropicMessagesMessage[]): ReadonlySet<number> => {
  const invalid = new Set<number>();
  for (let start = 0; start < messages.length;) {
    if (messages[start]?.role !== 'system') {
      start++;
      continue;
    }
    let end = start + 1;
    while (messages[end]?.role === 'system') end++;
    const group = messages.slice(start, end) as AnthropicMessagesSystemMessage[];
    const contentIndexes = group.flatMap((message, offset) => isDirectiveOnlySystemMessage(message) ? [] : [start + offset]);
    if (contentIndexes.length > 0) {
      const previous = messages[start - 1];
      const next = messages[end];
      if (!(previous?.role === 'user' || assistantEndsWithServerToolResult(previous))
        || !(next === undefined || next.role === 'assistant')) {
        for (const index of contentIndexes) invalid.add(index);
      }
    }
    start = end;
  }
  return invalid;
};

export const applyRoleCompatibility = defineRequestStage<
  AnthropicMessagesRequestFacts,
  Pick<AnthropicMessagesRequestFacts, 'request.payload'>,
  never,
  ChatPipelineServices
>({
  name: 'applyRoleCompatibility',
  provides: ['request.payload'],
  execute: async (facts, next) => {
    const flags = facts['route.candidate'].providerModel;
    const rewriteAll = hasEnabledFlag(flags, 'rewrite-mid-conv-system-to-user');
    const rewriteDisallowed = hasEnabledFlag(flags, 'rewrite-disallowed-mid-conv-system-to-user');
    const payload = facts['request.payload'];
    if (!rewriteAll && !rewriteDisallowed) return await next({ 'request.payload': payload });
    const disallowed = rewriteDisallowed ? disallowedSystemMessageIndexes(payload.messages) : new Set<number>();
    const messages = payload.messages.map((message, index) =>
      message.role === 'system' && (rewriteAll || disallowed.has(index))
        ? { role: 'user' as const, content: message.content }
        : message);
    return await next({ 'request.payload': { ...payload, messages } });
  },
});
