import { anthropicMessagesPayloadStage } from './payload-stage.ts';
import type { AnthropicMessagesAssistantMessage, AnthropicMessagesMessage, AnthropicMessagesPayload, AnthropicMessagesSystemMessage } from '@floway-dev/protocols/anthropic-messages';
import type { FlagId } from '@floway-dev/provider';

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
    const group = messages.slice(start, end) as AnthropicMessagesSystemMessage[];
    const contentIndexes = group.flatMap((message, offset) => isDirectiveOnlySystemMessage(message) ? [] : [start + offset]);
    if (contentIndexes.length > 0) {
      const previous = messages[start - 1];
      const next = messages[end];
      const validPrevious = previous?.role === 'user' || assistantEndsWithServerToolResult(previous);
      const validNext = next === undefined || next.role === 'assistant';
      if (!validPrevious || !validNext) {
        for (const index of contentIndexes) invalid.add(index);
      }
    }
    start = end;
  }

  return invalid;
};

export const applyAnthropicMessagesRoleCompatibility = <Payload extends Pick<AnthropicMessagesPayload, 'messages'>>(payload: Payload, flags: readonly FlagId[]): Payload => {
  const rewriteAllSystem = flags.includes('rewrite-mid-conv-system-to-user');
  const rewriteDisallowedSystem = flags.includes('rewrite-disallowed-mid-conv-system-to-user');
  if (!rewriteAllSystem && !rewriteDisallowedSystem) return payload;

  const disallowedIndexes = rewriteDisallowedSystem ? disallowedContentSystemMessageIndexes(payload.messages) : new Set<number>();

  return {
    ...payload,
    messages: payload.messages.map((message, index) =>
      message.role === 'system' && (rewriteAllSystem || disallowedIndexes.has(index))
        ? { role: 'user' as const, content: message.content }
        : message),
  };

};

export const applyRoleCompatibility = anthropicMessagesPayloadStage('apply-role-compatibility', applyAnthropicMessagesRoleCompatibility);
