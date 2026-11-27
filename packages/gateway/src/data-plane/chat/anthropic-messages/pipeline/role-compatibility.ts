import { defineStage } from '../../pipeline/facts.ts';
import type { AnthropicMessagesMessage, AnthropicMessagesPayload, AnthropicMessagesSystemMessage } from '@floway-dev/protocols/anthropic-messages';
import type { FlagId } from '@floway-dev/upstream';

const serverToolResultTypes = new Set([
  'advisor_tool_result',
  'bash_code_execution_tool_result',
  'code_execution_tool_result',
  'text_editor_code_execution_tool_result',
  'tool_search_tool_result',
  'web_fetch_tool_result',
  'web_search_tool_result',
]);

const isContentSystemMessage = (message: AnthropicMessagesSystemMessage): boolean =>
  !Array.isArray(message.content) || message.content.length > 0 || message.output_config == null;

const endsWithServerToolResult = (message: AnthropicMessagesMessage | undefined): boolean => {
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return false;
  const lastBlock = message.content.at(-1);
  return lastBlock !== undefined && serverToolResultTypes.has(lastBlock.type);
};

// https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages#limitations
const disallowedSystemMessages = (messages: readonly AnthropicMessagesMessage[]): ReadonlySet<number> => {
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
    if ((previous?.role !== 'user' && !endsWithServerToolResult(previous)) || (next !== undefined && next.role !== 'assistant')) {
      for (let index = start; index < end; index++) {
        const message = messages[index];
        if (message?.role === 'system' && isContentSystemMessage(message)) invalid.add(index);
      }
    }
    start = end;
  }
  return invalid;
};

export const applyAnthropicMessagesRoleCompatibility = <Payload extends Pick<AnthropicMessagesPayload, 'messages'>>(
  payload: Payload, flags: readonly FlagId[],
): Payload => {
  const rewriteAll = flags.includes('rewrite-mid-conv-system-to-user');
  const rewriteDisallowed = flags.includes('rewrite-disallowed-mid-conv-system-to-user');
  if (!rewriteAll && !rewriteDisallowed) return payload;

  const disallowed = rewriteDisallowed ? disallowedSystemMessages(payload.messages) : undefined;
  return {
    ...payload,
    messages: payload.messages.map((message, index) =>
      message.role === 'system' && (rewriteAll || disallowed?.has(index) === true)
        ? { role: 'user' as const, content: message.content }
        : message),
  };
};

export const rewriteAnthropicMessagesRoles = defineStage({
  name: 'anthropicMessages.apply-role-compatibility',
  through: {
    request: { needs: ['anthropicMessages', 'model'], provides: ['anthropicMessages'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = applyAnthropicMessagesRoleCompatibility(facts.anthropicMessages, facts.model.enabledFlags);
    return await scope.next({ ...facts, anthropicMessages: payload });
  },
});
