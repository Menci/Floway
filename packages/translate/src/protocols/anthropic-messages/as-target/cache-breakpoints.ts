// Translated Messages requests add up to three cache breakpoints: system text, the last custom tool,
// and the latest cacheable message block. Leave the fourth allowed slot for downstream additions.
// Prompt-cache keys are a separate mechanism.
// https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching

import type {
  AnthropicMessagesCacheControl,
  AnthropicMessagesInputContentBlock,
  AnthropicMessagesMessage,
  AnthropicMessagesTextBlockParam,
  AnthropicMessagesTool,
} from '@floway-dev/protocols/anthropic-messages';

const EPHEMERAL_CACHE_CONTROL: AnthropicMessagesCacheControl = { type: 'ephemeral' };

const replaceAt = <T>(values: readonly T[], index: number, value: T): T[] =>
  values.map((existing, at) => at === index ? value : existing);

export const withLastToolCacheBreakpoint = (tools: AnthropicMessagesTool[]): AnthropicMessagesTool[] => {
  // Native web-search tools carry a `web_search_*` discriminant and are not
  // part of the stable prefix, so the breakpoint lands on the last custom
  // tool instead.
  const index = tools.findLastIndex(tool => !tool.type || tool.type === 'custom');
  return index < 0 ? tools : replaceAt(tools, index, { ...tools[index], cache_control: EPHEMERAL_CACHE_CONTROL });
};

export const withLastSystemCacheBreakpoint = (system: AnthropicMessagesTextBlockParam[]): AnthropicMessagesTextBlockParam[] =>
  replaceAt(system, system.length - 1, { ...system[system.length - 1], cache_control: EPHEMERAL_CACHE_CONTROL });

const withMessageCacheBreakpoint = (message: AnthropicMessagesMessage): AnthropicMessagesMessage | undefined => {
  if (typeof message.content === 'string') {
    return { ...message, content: [{ type: 'text', text: message.content, cache_control: EPHEMERAL_CACHE_CONTROL }] };
  }
  const content: readonly AnthropicMessagesInputContentBlock[] = message.content;
  const index = content.findLastIndex(block => block.type === 'text' || block.type === 'image' || block.type === 'tool_use' || block.type === 'tool_result');
  if (index < 0) return undefined;
  return { ...message, content: replaceAt(content, index, { ...content[index], cache_control: EPHEMERAL_CACHE_CONTROL } as AnthropicMessagesInputContentBlock) } as AnthropicMessagesMessage;
};

// Restored native turns are replayed verbatim, so the breakpoint lands on the
// latest translated message that has a cacheable block.
export const withLastMessageCacheBreakpoint = (
  messages: AnthropicMessagesMessage[],
  restored: ReadonlySet<AnthropicMessagesMessage>,
): AnthropicMessagesMessage[] => {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (restored.has(messages[index])) continue;
    const marked = withMessageCacheBreakpoint(messages[index]);
    if (marked !== undefined) return replaceAt(messages, index, marked);
  }
  return messages;
};
