import type { AnthropicMessagesPayloadInterceptor } from './types.ts';
import type { AnthropicMessagesMessage } from '@floway-dev/protocols/anthropic-messages';
import { providerModelOf } from '@floway-dev/provider';

// A contiguous inline-system section must follow user input (including a user
// tool_result turn) or an assistant turn ending in a server-tool result, then
// either end the request or be followed by an assistant turn. Anthropic treats
// consecutive system messages as one section, so validate the section's outer
// neighbors rather than each system message's immediate neighbors.
// https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages#limitations
const endsWithServerToolResult = (message: AnthropicMessagesMessage | undefined): boolean => {
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return false;
  const type = (message.content.at(-1) as { type?: unknown } | undefined)?.type;
  return typeof type === 'string' && type !== 'tool_result' && type.endsWith('_tool_result');
};

const isEffortOnlySystem = (message: AnthropicMessagesMessage): boolean =>
  message.role === 'system'
  && (message.content === '' || (Array.isArray(message.content) && message.content.length === 0))
  && typeof message.output_config?.effort === 'string';

const isExpressibleInlineSystem = (messages: readonly AnthropicMessagesMessage[], index: number): boolean => {
  let start = index;
  while (messages[start - 1]?.role === 'system') start -= 1;
  let end = index;
  while (messages[end + 1]?.role === 'system') end += 1;

  const before = messages[start - 1];
  const after = messages[end + 1];
  return (before?.role === 'user' || endsWithServerToolResult(before))
    && (after === undefined || after.role === 'assistant');
};

export const withRoleCompatibilityApplied: AnthropicMessagesPayloadInterceptor = (ctx, _gatewayCtx, run) => {
  if (ctx.targetApi !== 'anthropicMessages') return run();
  const forceRewrite = providerModelOf(ctx.candidate).enabledFlags.has('rewrite-mid-conv-system-to-user');
  const messages = ctx.payload.messages.map((message, index, source) =>
    message.role === 'system' && !isEffortOnlySystem(message) && (forceRewrite || !isExpressibleInlineSystem(source, index))
      ? { role: 'user' as const, content: message.content }
      : message);
  if (messages.some((message, index) => message !== ctx.payload.messages[index])) {
    ctx.payload = { ...ctx.payload, messages };
  }

  return run();
};
